//! Loopback HTTP proxy fronting a remote pAInapple server.
//!
//! Not every target gets one: `lib.rs::needs_proxy` is the policy. Only
//! https targets with IP / mDNS / dotless hosts (self-signed certs WKWebView
//! would refuse) and plain-http targets (secure-context shim) are proxied;
//! https domains with real certs and loopback servers load directly.
//!
//! The webview always sees plain `http://127.0.0.1:<port>` — that unlocks
//! WKWebView's secure-context features (clipboard, service worker, PWA
//! install) regardless of how the upstream is reached. Two upstream modes,
//! chosen by the target's scheme:
//!
//!   - **TLS forward** (`https://` target): this module terminates plaintext
//!     on loopback and opens TLS to the real server, accepting ANY cert —
//!     self-signed, expired, wrong hostname, all of it. No chain validation,
//!     no fingerprint pinning: the design explicitly accepts the MITM risk
//!     in exchange for zero cert ceremony. TLS here buys wire encryption
//!     against passive snooping only. The reason a proxy exists at all:
//!     WKWebView refuses self-signed certs unless the device has a
//!     configuration profile trusting them, and Tauri v2 has no per-origin
//!     override hook.
//!   - **Plain TCP forward** (`http://` target): bytes travel unencrypted
//!     upstream. The admin opted into this by starting the server with
//!     `--tls=off`. The proxy is still in the path so the webview side
//!     stays a loopback origin (secure context preserved).

use std::convert::Infallible;
use std::sync::Arc;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::client::conn::http1 as client_http1;
use hyper::header::{HeaderName, HeaderValue, COOKIE, HOST, SET_COOKIE, UPGRADE};
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

/// Accepts every server cert unconditionally. Deliberate: the threat model
/// accepts active MITM in exchange for zero cert ceremony (no pinning, no
/// OS trust install, no bootstrap fingerprint to shuttle around). TLS is
/// used purely as wire encryption against passive observers.
#[derive(Debug)]
struct AcceptAnyCert;

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

/// Build a rustls client config that accepts ANY server cert. Hostname and
/// chain checks are both disabled — see `AcceptAnyCert` for the rationale.
pub fn make_tls_config() -> ClientConfig {
    let mut cfg = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert))
        .with_no_client_auth();
    // Force HTTP/1.1 — WebSocket Upgrade only works over HTTP/1.1, and we
    // don't want to negotiate h2 only to have to fall back per-request.
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg
}

/// Per-target cookie-name prefix, derived from the upstream origin.
///
/// Every proxied server lives on host `127.0.0.1` from the webview's point of
/// view, and cookies are scoped by HOST, NOT PORT — so without isolation, two
/// servers that both set the same cookie name (`bridge_auth` on every
/// pAInapple instance) clobber each other in WKWebView's shared jar: opening
/// a second window on server B logs the first window out of server A.
///
/// The proxy therefore namespaces cookies per upstream: `Set-Cookie` names
/// are prefixed with `pa<fnv1a64(origin)>_` on the way to the webview, and
/// the `Cookie` request header is filtered down to (and stripped of) that
/// prefix on the way upstream. Cookies belonging to other targets — or set
/// unprefixed on 127.0.0.1 by directly-accessed loopback servers — are never
/// forwarded. fnv1a is hand-rolled so the tag is stable across builds
/// (std's DefaultHasher makes no cross-version promise).
fn cookie_prefix(origin: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in origin.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("pa{h:016x}_")
}

/// Spin up a loopback HTTP listener that forwards every request to `target`.
/// The target's scheme picks the upstream transport:
///   - `https` — TLS to `target`, any cert accepted (see `AcceptAnyCert`).
///   - `http` — plain TCP, no TLS. For plain-HTTP LAN servers (admin chose
///     `--tls=off`); the webview still gets secure-context via loopback,
///     but bytes are cleartext on the wire upstream.
///
/// Returns the bound loopback port. The forwarder task runs until the process
/// exits or the listener socket dies under it — closing the webview doesn't
/// drop it. Listener is cheap (one socket + a couple of Arcs) and a JS-side
/// stop signal would only add complexity for no material savings. The death
/// case is real on iOS: the kernel reclaims sockets during long suspensions,
/// after which every accept fails forever — the loop then exits and drops the
/// listener so the port frees up for ensure_proxy's rebind (lib.rs), instead
/// of squatting dead on the origin the webview keeps retrying.
///
/// `preferred_port` is the port this target was proxied on in a previous
/// launch (see lib.rs port prefs): binding it again keeps the webview origin
/// stable across cold starts, which is what lets the chat client's cookies
/// and localStorage survive. Best-effort — if it's taken (or 0), fall back
/// to an OS-assigned ephemeral port.
pub async fn start(target: url::Url, preferred_port: Option<u16>) -> std::io::Result<u16> {
    let use_tls = match target.scheme() {
        "https" => true,
        "http" => false,
        other => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("unsupported scheme: {other}"),
            ));
        }
    };

    let listener = match preferred_port {
        Some(p) if p != 0 => match TcpListener::bind(("127.0.0.1", p)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0u16)).await?,
        },
        _ => TcpListener::bind(("127.0.0.1", 0u16)).await?,
    };
    let port = listener.local_addr()?.port();

    let tls_config = use_tls.then(|| Arc::new(make_tls_config()));
    let cookie_tag = Arc::new(cookie_prefix(&target.origin().ascii_serialization()));
    let target = Arc::new(target);

    tokio::spawn(async move {
        // Consecutive accept() failures with no success in between. A healthy
        // listener only sees these transiently (RST'd backlog entries, fd
        // pressure); a socket iOS reclaimed during a long suspension fails
        // every accept, instantly, forever. Once that's clear, exit: dropping
        // the listener releases the port so ensure_proxy's liveness probe can
        // rebind the same origin, instead of busy-looping on a corpse while
        // the webview retries a port nobody serves.
        let mut failures: u32 = 0;
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(x) => {
                    failures = 0;
                    x
                }
                Err(e) => {
                    failures += 1;
                    if failures >= 10 {
                        eprintln!(
                            "proxy[{port}]: {failures} consecutive accept failures ({e}) — listener dead, releasing port"
                        );
                        break;
                    }
                    // Pace retries — a dead socket fails in microseconds and
                    // an unpaced loop would peg a core while racking these up.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            let tls = tls_config.clone();
            let target = target.clone();
            let cookie_tag = cookie_tag.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let tls = tls.clone();
                    let target = target.clone();
                    let cookie_tag = cookie_tag.clone();
                    async move { Ok::<_, Infallible>(handle(req, target, tls, cookie_tag).await) }
                });
                // .with_upgrades() is mandatory — WebSocket frames have to
                // travel over the same TCP socket after the 101 response.
                let _ = server_http1::Builder::new()
                    .serve_connection(io, service)
                    .with_upgrades()
                    .await;
            });
        }
    });

    Ok(port)
}

type ProxyBody = BoxBody<Bytes, std::io::Error>;

// Upper bound on each upstream setup step (TCP connect, TLS handshake,
// HTTP/1 handshake). Without this, a silently-dropped SYN (firewalled LAN
// IP, sleeping VPN peer) leaves the webview's navigation hanging on the OS
// connect timeout — tens of seconds to minutes — with no error page. The
// health probe has always had a 6s bound (lib.rs); this mirrors it on the
// path real navigations take.
const UPSTREAM_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

async fn with_timeout<T, E: std::fmt::Display>(
    fut: impl std::future::Future<Output = Result<T, E>>,
    what: &str,
) -> Result<T, String> {
    match tokio::time::timeout(UPSTREAM_STEP_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{what}: {e}")),
        Err(_) => Err(format!(
            "{what}: timed out after {}s",
            UPSTREAM_STEP_TIMEOUT.as_secs()
        )),
    }
}

async fn handle(
    mut req: Request<Incoming>,
    target: Arc<url::Url>,
    tls_config: Option<Arc<ClientConfig>>,
    cookie_tag: Arc<String>,
) -> Response<ProxyBody> {
    let host = match target.host_str() {
        Some(h) => h.to_string(),
        None => return error_response(StatusCode::BAD_GATEWAY, "target has no host"),
    };
    let port = target.port_or_known_default().unwrap_or(80);

    let tcp = match with_timeout(
        TcpStream::connect((host.as_str(), port)),
        &format!("connect to {host}:{port}"),
    )
    .await
    {
        Ok(s) => s,
        Err(msg) => return error_response(StatusCode::BAD_GATEWAY, &msg),
    };

    // SendRequest<Incoming> is the same concrete type whether the handshake
    // ran over TLS or plain TCP — the IO type only appears in the Connection
    // half, which we move into a spawned task in each arm. So a single
    // post-match `sender` works for both modes.
    let mut sender = match tls_config {
        Some(cfg) => {
            let server_name: ServerName<'static> = match ServerName::try_from(host.clone()) {
                Ok(n) => n,
                Err(_) => {
                    return error_response(
                        StatusCode::BAD_GATEWAY,
                        "target host is not a valid SNI name",
                    )
                }
            };
            let connector = TlsConnector::from(cfg);
            let tls = match with_timeout(
                connector.connect(server_name, tcp),
                "tls handshake failed",
            )
            .await
            {
                Ok(s) => s,
                Err(msg) => return error_response(StatusCode::BAD_GATEWAY, &msg),
            };
            let (sender, conn) = match with_timeout(
                client_http1::handshake(TokioIo::new(tls)),
                "upstream HTTP handshake",
            )
            .await
            {
                Ok(pair) => pair,
                Err(msg) => return error_response(StatusCode::BAD_GATEWAY, &msg),
            };
            // with_upgrades keeps the IO alive past 101 so upgrade futures resolve.
            tokio::spawn(async move { let _ = conn.with_upgrades().await; });
            sender
        }
        None => {
            let (sender, conn) = match with_timeout(
                client_http1::handshake(TokioIo::new(tcp)),
                "upstream HTTP handshake",
            )
            .await
            {
                Ok(pair) => pair,
                Err(msg) => return error_response(StatusCode::BAD_GATEWAY, &msg),
            };
            tokio::spawn(async move { let _ = conn.with_upgrades().await; });
            sender
        }
    };

    // Headers / URI rewrites for upstream:
    //   - Host: must reflect the upstream authority, not the loopback we received on.
    //   - X-Forwarded-Proto: http — the webview's connection to us IS http (loopback).
    //     Without this, the server sees the upstream TLS and sets `Secure` on its
    //     auth cookie; the webview, being on plain http://127.0.0.1, then refuses
    //     to store it, so the post-login redirect loses the cookie and the user
    //     sees the login page again. Setting it overrides any client-sent value
    //     (uvicorn's forwarded_allow_ips='*' would otherwise trust whatever the
    //     webview sent, which is unset).
    //   - X-Forwarded-For: the webview's loopback IP. Not load-bearing for auth,
    //     but it keeps the server's access logs honest about who the proxy is.
    //   - Request URI must be origin-form (path + query only) for HTTP/1.1.
    let authority = match target.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    if let Ok(v) = HeaderValue::from_str(&authority) {
        req.headers_mut().insert(HOST, v);
    }
    req.headers_mut().insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("http"),
    );
    req.headers_mut().insert(
        HeaderName::from_static("x-forwarded-for"),
        HeaderValue::from_static("127.0.0.1"),
    );
    // Cookie isolation, request side: forward only this target's namespaced
    // cookies, with the prefix stripped. Everything else on the shared
    // 127.0.0.1 jar (other targets' prefixed cookies, unprefixed cookies from
    // directly-accessed loopback servers) is dropped — sending another
    // server's `bridge_auth` upstream would just be a wrong credential.
    let filtered_cookies = req
        .headers()
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|hdr| {
            hdr.split(';')
                .filter_map(|crumb| crumb.trim().strip_prefix(cookie_tag.as_str()))
                .collect::<Vec<_>>()
                .join("; ")
        });
    match filtered_cookies {
        Some(c) if !c.is_empty() => {
            if let Ok(v) = HeaderValue::from_str(&c) {
                req.headers_mut().insert(COOKIE, v);
            } else {
                req.headers_mut().remove(COOKIE);
            }
        }
        Some(_) => {
            req.headers_mut().remove(COOKIE);
        }
        None => {}
    }
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let new_uri: Uri = match path_and_query.parse() {
        Ok(u) => u,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "invalid URI"),
    };
    *req.uri_mut() = new_uri;

    let is_upgrade = req
        .headers()
        .get(UPGRADE)
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    // Grab the client-side upgrade future BEFORE sending — hyper consumes the
    // request when forwarding, so we can't reach back for it afterwards.
    let client_upgrade = if is_upgrade {
        Some(hyper::upgrade::on(&mut req))
    } else {
        None
    };

    let mut upstream_res = match sender.send_request(req).await {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("upstream send_request: {e}"),
            )
        }
    };

    if upstream_res.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_upgrade) = client_upgrade {
            let upstream_upgrade = hyper::upgrade::on(&mut upstream_res);
            tokio::spawn(async move {
                let client = match client_upgrade.await {
                    Ok(u) => u,
                    Err(_) => return,
                };
                let upstream = match upstream_upgrade.await {
                    Ok(u) => u,
                    Err(_) => return,
                };
                let mut client = TokioIo::new(client);
                let mut upstream = TokioIo::new(upstream);
                // Bidirectional bytes pipe — both sides AsyncRead+AsyncWrite via TokioIo.
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    }

    let (mut parts, body) = upstream_res.into_parts();
    // Cookie isolation, response side: namespace every Set-Cookie name with
    // this target's prefix. A Set-Cookie value always starts with `name=`,
    // so prefixing the whole string renames the cookie and leaves the value
    // and attributes (Path, Max-Age, HttpOnly, …) untouched. Logout-style
    // deletions (`name=; Max-Age=0`) rewrite the same way and still match.
    let set_cookies: Vec<HeaderValue> = parts.headers.get_all(SET_COOKIE).iter().cloned().collect();
    if !set_cookies.is_empty() {
        parts.headers.remove(SET_COOKIE);
        for original in set_cookies {
            let rewritten = original
                .to_str()
                .ok()
                .and_then(|s| HeaderValue::from_str(&format!("{cookie_tag}{s}")).ok());
            parts.headers.append(SET_COOKIE, rewritten.unwrap_or(original));
        }
    }
    let mapped: ProxyBody = body
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        .boxed();
    Response::from_parts(parts, mapped)
}

// Styled HTML in the launcher's palette — when the proxy can't reach the
// upstream (server offline, TLS handshake failed, etc.) the webview was
// rendering raw text on a black page. The button invokes back_to_launcher
// via Tauri IPC (the server-pages capability grants it on this origin).
fn error_response(code: StatusCode, msg: &str) -> Response<ProxyBody> {
    let html = format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=contain">
<meta name="color-scheme" content="dark light">
<title>Server unreachable</title>
<style>
:root {{ --bg:#1a1612; --fg:#f3eee5; --muted:#8a8278; --accent:#f0a050; --field:#2a241d; --border:#3a3328; --error:#e06b5b; }}
@media (prefers-color-scheme: light) {{
  :root {{ --bg:#faf6ee; --fg:#1a1612; --muted:#6a6358; --accent:#c87830; --field:#fff; --border:#d8d0c0; --error:#b04030; }}
}}
*{{box-sizing:border-box}}
html,body{{height:100%;margin:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;align-items:center;justify-content:center;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}}
main{{width:100%;max-width:420px;padding:32px 24px}}
h1{{font-size:24px;margin:0 0 8px;letter-spacing:-0.02em}}
.summary{{color:var(--muted);margin:0 0 16px;font-size:14px}}
.detail{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--error);padding:12px 14px;background:var(--field);border:1px solid var(--border);border-radius:10px;margin:0 0 24px;word-break:break-all}}
button{{font:inherit;font-weight:600;padding:12px 16px;border-radius:10px;border:0;background:var(--accent);color:#1a1612;cursor:pointer;width:100%}}
button:hover{{filter:brightness(1.1)}}
button:active{{transform:translateY(1px)}}
</style>
</head>
<body>
<main>
<h1>Server unreachable</h1>
<p class="summary">The pAInapple server didn't respond.</p>
<p class="detail">{}</p>
<button id="back">Back to launcher</button>
</main>
<script>
document.getElementById('back').addEventListener('click', () => {{
  if (window.__TAURI__ && window.__TAURI__.core) {{
    window.__TAURI__.core.invoke('back_to_launcher');
  }}
}});
</script>
</body>
</html>"##,
        html_escape(msg)
    );
    let body: ProxyBody = Full::new(Bytes::from(html))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        .boxed();
    let mut resp = Response::new(body);
    *resp.status_mut() = code;
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    resp
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
