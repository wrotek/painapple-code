// Local server mode (desktop only — the whole module is behind
// `#[cfg(desktop)]` in lib.rs; on iOS the local_* commands simply don't
// exist and the launcher hides the card when invoke() rejects).
//
// Provisions the Python bridge with the bundled `uv` sidecar and supervises
// it as a child process. uv downloads a managed CPython (no system Python
// involved — macOS ships none worth using) and installs painapple-code from
// PyPI into an isolated tool env. Everything uv touches lives under the
// app's data dir:
//
//   ~/Library/Application Support/com.boothw.painapple/uv/
//   ├── cache/    UV_CACHE_DIR
//   ├── python/   UV_PYTHON_INSTALL_DIR   (managed CPython)
//   ├── tools/    UV_TOOL_DIR             (the painapple-code venv)
//   └── bin/      UV_TOOL_BIN_DIR         (painapple-code entry point)
//
// so nothing collides with a user-managed uv/pipx/homebrew setup. The
// bridge itself still keeps its data in ~/.painapple-code/ and its auth
// config in ~/.config/painapple-code/ like any other install — an
// app-managed instance and a CLI-managed one share session history.
//
// Full design: docs-ai/plans/2026-07-10-desktop-app-macos-local-mode.md

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const BRIDGE_PACKAGE: &str = "painapple-code";
const PYTHON_VERSION: &str = "3.13";
const LOG_CAP: usize = 500;
const HEALTH_TIMEOUT_SECS: u64 = 90; // first start imports duckdb etc. — slow on cold FS cache

#[derive(Default)]
pub struct LocalState {
    // The supervised bridge process. Present ⇒ we spawned it and believe it
    // to be alive; the reader task clears this when Terminated arrives.
    server: Mutex<Option<CommandChild>>,
    // (port, scheme) of the running bridge — scheme matters once TLS is on.
    running_port: Mutex<Option<(u16, &'static str)>>,
    // Ring buffer of provisioning + server output for the launcher's log pane.
    logs: Mutex<VecDeque<String>>,
    // Coarse re-entrancy guard: only one provision/start/claude-install/
    // docker-op at a time. Holds a label so the UI can say what's in flight.
    busy: Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------
// Paths + environment

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn uv_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(base.join("uv"))
}

fn uv_envs(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let root = uv_root(app)?;
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut envs = HashMap::new();
    envs.insert("UV_CACHE_DIR".into(), s(root.join("cache")));
    envs.insert("UV_PYTHON_INSTALL_DIR".into(), s(root.join("python")));
    envs.insert("UV_TOOL_DIR".into(), s(root.join("tools")));
    envs.insert("UV_TOOL_BIN_DIR".into(), s(root.join("bin")));
    // Never fall back to a system Python — macOS's /usr/bin/python3 is a CLT
    // stub (or missing, or 3.9). The managed download is the whole point.
    envs.insert("UV_MANAGED_PYTHON".into(), "1".into());
    Ok(envs)
}

fn server_bin(app: &AppHandle) -> Result<PathBuf, String> {
    // Canonical entry point is `painapple` since the 2026-07 rename; fall
    // back to the legacy `painapple-code` alias for older provisioned venvs.
    let bin_dir = uv_root(app)?.join("bin");
    let canonical = bin_dir.join("painapple");
    if canonical.is_file() {
        return Ok(canonical);
    }
    Ok(bin_dir.join(BRIDGE_PACKAGE))
}

// PATH the bridge subprocess gets. A .app launched from Finder inherits the
// minimal launchd PATH (/usr/bin:/bin:…) which does NOT include wherever
// `claude` lives — prepend the usual suspects so the bridge (and the
// claude-agent-sdk under it) can spawn the CLI. ~/.docker/bin is Docker
// Desktop's CLI drop dir — needed so the `painapple` CLI's container verbs
// (--in-docker, start NAME, …) find the runtime when driven from the app.
fn augmented_path() -> String {
    let home = home_dir();
    let mut parts: Vec<String> = [
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".docker/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
    .iter()
    .map(|p| p.to_string_lossy().into_owned())
    .collect();
    parts.push(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
    parts.join(":")
}

fn find_claude() -> Option<String> {
    find_on_path("claude")
}

fn find_on_path(name: &str) -> Option<String> {
    for dir in augmented_path().split(':') {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Logs + progress events

#[derive(Clone, Serialize)]
struct Progress {
    stage: String,
    line: String,
}

fn push_log(app: &AppHandle, line: &str) {
    let state = app.state::<LocalState>();
    let mut logs = state.logs.lock().unwrap();
    if logs.len() >= LOG_CAP {
        logs.pop_front();
    }
    logs.push_back(line.to_string());
}

fn emit_progress(app: &AppHandle, stage: &str, line: &str) {
    push_log(app, line);
    let _ = app.emit(
        "local-progress",
        Progress {
            stage: stage.into(),
            line: line.into(),
        },
    );
}

// ---------------------------------------------------------------------------
// Busy guard

fn acquire_busy(app: &AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<LocalState>();
    let mut busy = state.busy.lock().unwrap();
    if let Some(current) = busy.as_deref() {
        return Err(format!("another operation is in progress ({current})"));
    }
    *busy = Some(label.to_string());
    Ok(())
}

fn release_busy(app: &AppHandle) {
    app.state::<LocalState>().busy.lock().unwrap().take();
}

// ---------------------------------------------------------------------------
// uv helpers

// Run the uv sidecar to completion, streaming output as progress events.
async fn run_uv_streamed(app: &AppHandle, stage: &str, args: Vec<String>) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar("uv")
        .map_err(|e| format!("uv sidecar missing: {e}"))?
        .args(args.iter().map(|s| s.as_str()))
        .envs(uv_envs(app)?);
    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("uv spawn failed: {e}"))?;
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end();
                if !line.is_empty() {
                    emit_progress(app, stage, line);
                }
            }
            CommandEvent::Error(e) => emit_progress(app, stage, &format!("error: {e}")),
            CommandEvent::Terminated(t) => code = t.code,
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(()),
        Some(c) => Err(format!("uv exited with code {c}")),
        None => Err("uv terminated by signal".into()),
    }
}

// Run the uv sidecar quietly and return collected stdout+stderr.
async fn run_uv_collect(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let cmd = app
        .shell()
        .sidecar("uv")
        .map_err(|e| format!("uv sidecar missing: {e}"))?
        .args(args.iter().copied())
        .envs(uv_envs(app)?);
    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("uv spawn failed: {e}"))?;
    let mut out = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                out.push_str(&String::from_utf8_lossy(&bytes));
                out.push('\n');
            }
            _ => {}
        }
    }
    Ok(out)
}

// `uv tool list` prints "painapple-code v1.2.3" above the entry-point lines.
async fn query_server_version(app: &AppHandle) -> Option<String> {
    let out = run_uv_collect(app, &["tool", "list"]).await.ok()?;
    out.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{BRIDGE_PACKAGE} v"))
            .map(|v| v.split_whitespace().next().unwrap_or(v).to_string())
    })
}

// ---------------------------------------------------------------------------
// Health probe + auth config

async fn probe_health(scheme: &str, port: u16, timeout_secs: u64) -> bool {
    // Self-signed certs are the norm for local TLS — accept anything, this
    // is a loopback liveness probe, not an authenticity check.
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .danger_accept_invalid_certs(true)
        .build()
    else {
        return false;
    };
    matches!(
        client
            .get(format!("{scheme}://127.0.0.1:{port}/health"))
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

// The bridge generates ~/.config/painapple-code/config.yaml (mode 0600) on
// first start; `password:` is its only required field. Reading it here lets
// the app hand the webview a logged-in `?tkn=` URL instead of showing the
// login page — same bootstrap the server logs on startup.
fn read_password() -> Option<String> {
    let path = home_dir().join(".config/painapple-code/config.yaml");
    let contents = std::fs::read_to_string(path).ok()?;
    contents.lines().find_map(|line| {
        line.strip_prefix("password:")
            .map(|rest| rest.trim().to_string())
            .filter(|p| !p.is_empty())
    })
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    provisioned: bool,
    server_version: Option<String>,
    claude_path: Option<String>,
    running: bool,
    port: Option<u16>,
    busy: Option<String>,
}

#[tauri::command]
pub async fn local_status(app: AppHandle) -> Result<LocalStatus, String> {
    let provisioned = server_bin(&app)?.is_file();
    let busy = {
        let state = app.state::<LocalState>();
        let guard = state.busy.lock().unwrap();
        guard.clone()
    };
    // Skip the (subprocess-spawning) version query while an install is in
    // flight — uv locks its tool dir and the answer is about to change anyway.
    let server_version = if provisioned && busy.is_none() {
        query_server_version(&app).await
    } else {
        None
    };
    let state = app.state::<LocalState>();
    let running = state.server.lock().unwrap().is_some();
    let port = state.running_port.lock().unwrap().map(|(p, _)| p);
    Ok(LocalStatus {
        provisioned,
        server_version,
        claude_path: find_claude(),
        running,
        port,
        busy,
    })
}

// Install or update the bridge. `source` overrides the PyPI package spec —
// a local wheel path for pre-release testing, or "painapple-code==1.2.3"
// to pin. Streams uv output as `local-progress` events (stage "provision").
#[tauri::command]
pub async fn local_provision(app: AppHandle, source: Option<String>) -> Result<(), String> {
    acquire_busy(&app, "provision")?;
    let result = provision_inner(&app, source).await;
    release_busy(&app);
    result
}

async fn provision_inner(app: &AppHandle, source: Option<String>) -> Result<(), String> {
    let spec = source
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| BRIDGE_PACKAGE.to_string());
    emit_progress(app, "provision", &format!("$ uv tool install {spec}"));
    run_uv_streamed(
        app,
        "provision",
        vec![
            "tool".into(),
            "install".into(),
            "--force".into(),
            "--python".into(),
            PYTHON_VERSION.into(),
            spec,
        ],
    )
    .await?;
    if !server_bin(app)?.is_file() {
        return Err("install finished but the painapple-code entry point was not found".into());
    }
    emit_progress(app, "provision", "install complete ✓");
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    port: u16,
    cwd: Option<String>,
    instance_name: Option<String>,
    accent: Option<String>,
    // Bind address (default 127.0.0.1). 0.0.0.0 makes the bridge reachable
    // on the LAN — the wizard warns before offering it.
    host: Option<String>,
    // auto | on | off — forwarded as --tls. The bridge resolves `auto`
    // against its real bind (loopback → off), so we mirror that resolution
    // only to pick the scheme for health probes + the login URL.
    tls: Option<String>,
}

impl LocalConfig {
    fn bind_host(&self) -> String {
        match self.host.as_deref().map(str::trim) {
            None | Some("") => "127.0.0.1".into(),
            Some(h) => h.into(),
        }
    }

    fn scheme(&self) -> &'static str {
        let effective_on = match self.tls.as_deref() {
            Some("on") => true,
            Some("off") => false,
            _ => !matches!(self.bind_host().as_str(), "127.0.0.1" | "::1" | "localhost"),
        };
        if effective_on {
            "https"
        } else {
            "http"
        }
    }
}

// Start the bridge (or return the login URL if it's already running on the
// requested port). Returns a ready-to-navigate `?tkn=` URL.
#[tauri::command]
pub async fn local_start(app: AppHandle, config: LocalConfig) -> Result<String, String> {
    acquire_busy(&app, "start")?;
    let result = start_inner(&app, config).await;
    release_busy(&app);
    result
}

fn login_url(scheme: &str, port: u16) -> String {
    match read_password() {
        Some(tkn) => format!("{scheme}://127.0.0.1:{port}/?tkn={tkn}"),
        None => format!("{scheme}://127.0.0.1:{port}/"),
    }
}

async fn start_inner(app: &AppHandle, config: LocalConfig) -> Result<String, String> {
    let port = config.port;
    let scheme = config.scheme();

    // Already supervising a server?
    let running_on = *app.state::<LocalState>().running_port.lock().unwrap();
    if let Some((current, current_scheme)) = running_on {
        if current == port && current_scheme == scheme {
            return Ok(login_url(scheme, port)); // idempotent "Open"
        }
        stop_inner(app).await?; // port/TLS changed — restart with the new config
    }

    let bin = server_bin(app)?;
    if !bin.is_file() {
        return Err("server is not installed yet — run Install first".into());
    }

    // Someone else on the port (a CLI-managed instance, another app copy)?
    // Don't fight over it — the user can add it as a saved server instead.
    if probe_health("http", port, 2).await || probe_health("https", port, 2).await {
        return Err(format!(
            "port {port} is already serving a pAInapple instance — pick another port, or add http://127.0.0.1:{port} as a saved server"
        ));
    }

    // Workspace directory: default to $HOME, expand a leading ~.
    let home = home_dir();
    let cwd = match config.cwd.as_deref().map(str::trim) {
        None | Some("") => home.clone(),
        Some("~") => home.clone(),
        Some(p) if p.starts_with("~/") => home.join(&p[2..]),
        Some(p) => PathBuf::from(p),
    };
    if !cwd.is_dir() {
        return Err(format!("folder does not exist: {}", cwd.display()));
    }

    let mut args: Vec<String> = vec![
        "--host".into(),
        config.bind_host(),
        "--port".into(),
        port.to_string(),
        "--cwd".into(),
        cwd.to_string_lossy().into_owned(),
    ];
    if let Some(name) = config.instance_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--instance-name".into());
        args.push(name.to_string());
    }
    if let Some(accent) = config.accent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--accent".into());
        args.push(accent.to_string());
    }
    if let Some(tls) = config.tls.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--tls".into());
        args.push(tls.to_string());
    }

    emit_progress(app, "server", &format!("$ painapple-code --port {port} --cwd {}", cwd.display()));

    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("PATH".into(), augmented_path());

    let cmd = app
        .shell()
        .command(bin.to_string_lossy().as_ref())
        .args(args.iter().map(|s| s.as_str()))
        .envs(envs)
        .current_dir(cwd);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("server spawn failed: {e}"))?;

    {
        let state = app.state::<LocalState>();
        *state.server.lock().unwrap() = Some(child);
        *state.running_port.lock().unwrap() = Some((port, scheme));
    }

    // Reader task: mirror output into the log ring for the lifetime of the
    // process; on exit, clear the supervised state and tell the launcher
    // (covers both user-driven stops and crashes — e.g. port already bound
    // by a non-painapple process, missing deps, config errors).
    let app_reader = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        emit_progress(&app_reader, "server", line);
                    }
                }
                CommandEvent::Terminated(t) => {
                    let state = app_reader.state::<LocalState>();
                    state.server.lock().unwrap().take();
                    state.running_port.lock().unwrap().take();
                    emit_progress(
                        &app_reader,
                        "server",
                        &format!("server exited (code {:?})", t.code),
                    );
                    let _ = app_reader.emit("local-server-exited", t.code);
                }
                _ => {}
            }
        }
    });

    // Wait for /health. Bail early if the reader task saw the process die.
    let deadline = HEALTH_TIMEOUT_SECS * 2; // 500ms ticks
    for _ in 0..deadline {
        if app.state::<LocalState>().server.lock().unwrap().is_none() {
            return Err("server exited during startup — check the log".into());
        }
        if probe_health(scheme, port, 2).await {
            emit_progress(app, "server", &format!("ready on {scheme}://127.0.0.1:{port}/"));
            return Ok(login_url(scheme, port));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "server did not answer /health within {HEALTH_TIMEOUT_SECS}s — check the log"
    ))
}

#[tauri::command]
pub async fn local_stop(app: AppHandle) -> Result<(), String> {
    stop_inner(&app).await
}

async fn stop_inner(app: &AppHandle) -> Result<(), String> {
    let child = {
        let state = app.state::<LocalState>();
        state.running_port.lock().unwrap().take();
        let child = state.server.lock().unwrap().take();
        child
    };
    let Some(child) = child else {
        return Ok(()); // nothing supervised — no-op
    };
    let pid = child.pid();

    // Graceful first: SIGTERM lets uvicorn close sockets and the DuckDB
    // single-writer commit cleanly (same contract as the `pkill` restart
    // workflow on the dev tiers). CommandChild::kill() is SIGKILL, so send
    // TERM out-of-band and keep kill() as the escalation.
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    for _ in 0..20 {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !alive {
            emit_progress(app, "server", "server stopped");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    emit_progress(app, "server", "server ignored SIGTERM — killing");
    child.kill().map_err(|e| format!("kill failed: {e}"))
}

// Last N log lines for the launcher's log pane (survives card re-renders).
#[tauri::command]
pub fn local_logs(app: AppHandle) -> Vec<String> {
    app.state::<LocalState>()
        .logs
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect()
}

// One-click Claude Code CLI install via the official native installer
// (no Node prerequisite). Streams into the same progress pane.
#[tauri::command]
pub async fn local_install_claude(app: AppHandle) -> Result<String, String> {
    acquire_busy(&app, "claude")?;
    let result = install_claude_inner(&app).await;
    release_busy(&app);
    result
}

async fn install_claude_inner(app: &AppHandle) -> Result<String, String> {
    emit_progress(app, "claude", "$ curl -fsSL https://claude.ai/install.sh | bash");
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("PATH".into(), augmented_path());
    let cmd = app
        .shell()
        .command("/bin/bash")
        .args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"])
        .envs(envs);
    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("installer spawn failed: {e}"))?;
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end();
                if !line.is_empty() {
                    emit_progress(app, "claude", line);
                }
            }
            CommandEvent::Terminated(t) => code = t.code,
            _ => {}
        }
    }
    if code != Some(0) {
        return Err(format!("installer exited with code {code:?}"));
    }
    find_claude().ok_or_else(|| {
        "installer finished but `claude` was not found on PATH — try a new terminal or install manually".into()
    })
}

// ---------------------------------------------------------------------------
// Docker engine support (setup wizard). The GUI never talks to the docker
// daemon itself — it drives the uv-provisioned unified `painapple` CLI
// non-interactively via local_tool (`profile get/set`, `start/stop/restart
// NAME`, `pull`, `password NAME`), so all orchestration logic (run argv,
// SELinux labels, podman keep-id, password-from-volume) stays in Python and
// config lands in the canonical ~/.painapple-code/profiles/NAME/profile.yaml
// shared with terminal use.
// Design: docs-ai/plans/2026-07-30-cli-unification-redesign.md

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    output: String,
    code: Option<i32>,
}

// Run the provisioned painapple-code CLI with `args`, streaming each line as
// a `local-progress` event (stage defaults to "docker") AND collecting the
// full output for the caller to parse (config get, password, …). Spawn
// failures are Err; a nonzero exit comes back in `code` with the output so
// the UI can show the CLI's own error text.
#[tauri::command]
pub async fn local_tool(
    app: AppHandle,
    args: Vec<String>,
    stage: Option<String>,
    quiet: Option<bool>,
) -> Result<ToolResult, String> {
    let stage = stage.unwrap_or_else(|| "docker".into());
    acquire_busy(&app, &stage)?;
    let result = tool_inner(&app, args, &stage, quiet.unwrap_or(false)).await;
    release_busy(&app);
    result
}

async fn tool_inner(
    app: &AppHandle,
    args: Vec<String>,
    stage: &str,
    quiet: bool,
) -> Result<ToolResult, String> {
    let bin = server_bin(app)?;
    if !bin.is_file() {
        return Err("painapple-code is not installed yet — run Install first".into());
    }
    if !quiet {
        emit_progress(app, stage, &format!("$ painapple {}", args.join(" ")));
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("PATH".into(), augmented_path());
    // The CLI colorizes via ANSI when isatty — it isn't here, but belt and
    // braces: NO_COLOR is honored by most CLI ecosystems.
    envs.insert("NO_COLOR".into(), "1".into());
    let cmd = app
        .shell()
        .command(bin.to_string_lossy().as_ref())
        .args(args.iter().map(|s| s.as_str()))
        .envs(envs)
        .current_dir(home_dir());
    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut out = String::new();
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                out.push_str(&line);
                if !line.ends_with('\n') {
                    out.push('\n');
                }
                let trimmed = line.trim_end();
                if !trimmed.is_empty() && !quiet {
                    emit_progress(app, stage, trimmed);
                }
            }
            CommandEvent::Error(e) => {
                if !quiet {
                    emit_progress(app, stage, &format!("error: {e}"));
                }
            }
            CommandEvent::Terminated(t) => code = t.code,
            _ => {}
        }
    }
    Ok(ToolResult { output: out, code })
}

fn painapple_home() -> PathBuf {
    std::env::var_os("PAINAPPLE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".painapple-code"))
}

// KEEP IN SYNC with PROFILES_DIR in src/painapple_code/cli/serve_config.py
// (store logic in cli/profiles.py) — the unified profile store keeps every
// named deployment at $PAINAPPLE_HOME/profiles/NAME/profile.yaml with a
// `mode: host | docker` key. The launcher manages ONLY docker-mode
// profiles; host profiles in the same dir are someone else's business.
// There is no flag-less root sandbox anymore ('default' is reserved for
// the root HOST deployment) — legacy stores (docker-profiles/, the root
// docker.yaml) are auto-migrated by the CLI on any profile-aware verb.
const PROFILES_DIR: &str = "profiles";

// A docker-mode profile: profile.yaml present with `mode: docker`.
fn profile_configured(dir: &PathBuf) -> bool {
    let path = dir.join("profile.yaml");
    match std::fs::read_to_string(&path) {
        Ok(text) => text
            .lines()
            .any(|l| l.trim() == "mode: docker"),
        Err(_) => false,
    }
}

// Same shape the CLI enforces (_PROFILE_RE in cli/profiles.py) — and
// our guarantee that a profile arg can't traverse out of profiles/.
fn valid_profile_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerState {
    // "docker" | "podman" — first found on the augmented PATH (Docker
    // Desktop's ~/.docker/bin included). None ⇒ neither installed.
    runtime: Option<String>,
    // A LEGACY root docker.yaml still exists ⇒ the CLI hasn't migrated it
    // yet (it becomes profile "docker" / --in-docker defaults on the next
    // profile-aware CLI call). Kept for API stability; the JS no longer
    // builds an instance from it.
    configured: bool,
    // Docker-mode profiles found under profiles/ (terminal- or GUI-made) —
    // sorted so the launcher's instance list is stable across refreshes.
    profiles: Vec<String>,
    // Host has ~/.claude/.credentials.json → wizard can offer login seeding.
    host_claude_creds: bool,
}

#[tauri::command]
pub fn local_docker_state() -> DockerState {
    let runtime = ["docker", "podman"]
        .iter()
        .find(|name| find_on_path(name).is_some())
        .map(|s| s.to_string());
    let home = painapple_home();
    let mut profiles: Vec<String> = std::fs::read_dir(home.join(PROFILES_DIR))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| profile_configured(&e.path()))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    profiles.sort();
    DockerState {
        runtime,
        configured: home.join("docker.yaml").is_file(), // legacy, pre-migration
        profiles,
        host_claude_creds: home_dir().join(".claude/.credentials.json").is_file(),
    }
}

// Delete a docker-mode profile's *config* (profile.yaml) so the launcher's
// Remove genuinely forgets it — otherwise the on-disk profile would be
// re-adopted as a new instance on the next refresh. Data volume, bind
// dirs, and the (shared) Claude home are deliberately untouched; the
// caller is expected to stop the container first. Host-mode profiles are
// refused — their profile dir IS a data home the launcher doesn't own.
#[tauri::command]
pub fn local_docker_remove_profile(profile: String) -> Result<(), String> {
    let profile = profile.trim();
    if profile.is_empty() || profile == "default" || !valid_profile_name(profile) {
        return Err(format!("bad profile name: {profile}"));
    }
    let dir = painapple_home().join(PROFILES_DIR).join(profile);
    if !profile_configured(&dir) {
        return Err(format!("not a docker-mode profile: {profile}"));
    }
    let path = dir.join("profile.yaml");
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    let _ = std::fs::remove_dir(&dir); // only if empty — never recursive
    Ok(())
}

// Seed an isolated CLAUDE_HOME from the host's ~/.claude so the container
// doesn't start logged-out: copies .credentials.json verbatim and writes
// `<dest>.json` (the CLAUDE_JSON the CLI derives) from an allowlist of
// "not a fresh install" flags. Existing files are never overwritten.
//
// KEEP IN SYNC with CLAUDE_JSON_ALLOW in
// src/painapple_code/cli/deploy/claude_seed.py — the Python TUI wizard
// does the same seeding for terminal setups.
const CLAUDE_JSON_ALLOW: &[&str] = &[
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "installMethod",
    "migrationVersion",
    "claudeCodeFirstTokenDate",
    "opusProMigrationComplete",
    "sonnet1m45MigrationComplete",
    "lastReleaseNotesSeen",
    "opus47LaunchSeenCount",
];

#[cfg(unix)]
fn chmod_600(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn chmod_600(_path: &PathBuf) {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedResult {
    creds: bool,
    onboarding: bool,
}

#[tauri::command]
pub fn local_seed_claude(dest: String) -> Result<SeedResult, String> {
    let dest = expand_home(&dest);
    std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;

    let mut result = SeedResult { creds: false, onboarding: false };

    let src_creds = home_dir().join(".claude/.credentials.json");
    let dst_creds = dest.join(".credentials.json");
    if src_creds.is_file() && !dst_creds.is_file() {
        std::fs::copy(&src_creds, &dst_creds)
            .map_err(|e| format!("copy credentials: {e}"))?;
        chmod_600(&dst_creds);
        result.creds = true;
    }

    let src_json = home_dir().join(".claude.json");
    let dst_json = PathBuf::from(format!("{}.json", dest.display()));
    if src_json.is_file() && !dst_json.is_file() {
        if let Ok(text) = std::fs::read_to_string(&src_json) {
            if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&text) {
                let subset: serde_json::Map<String, serde_json::Value> = map
                    .into_iter()
                    .filter(|(k, _)| CLAUDE_JSON_ALLOW.contains(&k.as_str()))
                    .collect();
                if std::fs::write(
                    &dst_json,
                    serde_json::to_string_pretty(&serde_json::Value::Object(subset))
                        .unwrap_or_else(|_| "{}".into()),
                )
                .is_ok()
                {
                    chmod_600(&dst_json);
                    result.onboarding = true;
                }
            }
        }
    }
    Ok(result)
}

fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    if path == "~" {
        home_dir()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(path)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirProbe {
    exists: bool,
    git: bool,
    expanded: String,
}

// Folder validation for the wizard: does it exist, and is it a git checkout
// (.git can be a dir, or a file for worktrees/submodules) — used to preselect
// "single project" vs "folder of projects" for the Docker workspace layout.
#[tauri::command]
pub fn local_probe_dir(path: String) -> DirProbe {
    let expanded = if path.trim().is_empty() {
        home_dir()
    } else {
        expand_home(&path)
    };
    DirProbe {
        exists: expanded.is_dir(),
        git: expanded.join(".git").exists(),
        expanded: expanded.to_string_lossy().into_owned(),
    }
}

// App-exit hook (RunEvent::Exit in lib.rs): don't orphan the bridge. TERM,
// a short grace so DuckDB/uvicorn can wind down, then hard kill. A crashed
// app still orphans it — accepted for now; the orphan keeps serving and the
// next start on that port errors loudly with an adopt-or-repick message.
pub fn shutdown(app: &AppHandle) {
    let child = {
        let state = app.state::<LocalState>();
        state.running_port.lock().unwrap().take();
        let child = state.server.lock().unwrap().take();
        child
    };
    let Some(child) = child else { return };
    let pid = child.pid();
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    for _ in 0..8 {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !alive {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
}
