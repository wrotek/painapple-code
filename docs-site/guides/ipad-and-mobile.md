# iPad & mobile (PWA)

pAInapple Code is an installable PWA with real touch UX — a good chunk of the app was built *from* an iPad, so mobile is a first-class citizen, not an afterthought.

## Installing the app

Log into the web client from the device's browser first, then install:

- **iOS / iPadOS** — in Safari, tap the share button and choose **Add to Home Screen**.
- **Android** — Chrome offers **Install app** from the ⋮ menu (or an install banner).
- **Desktop** — Chrome and Edge show an install icon in the address bar.

Why bother, instead of a browser tab:

- **Standalone mode** — no browser chrome, full-screen app, and shortcuts like ++cmd+r++ work as in-app bindings.
- **Offline fallback** — a service worker precaches the app shell; if the server is unreachable you get a proper offline page instead of a browser error, and cached assets keep loads fast.
- **Per-instance icons and names** — an instance started with `--instance-name DEV --accent red` serves a manifest named "pAInapple Code DEV" with tinted icons, so multiple installed instances stay visually distinct on your home screen ([Server CLI](../reference/server-cli.md)).
- **App shortcut** — long-press the icon for a **New Session** shortcut that opens the app straight into a fresh session.

## Reaching the server from a device

Your phone or tablet needs a route to the server — `localhost` won't cut it:

- **Bind beyond loopback** — start the server with `--host 0.0.0.0` (or a LAN IP). Binding a non-loopback host auto-enables TLS with a self-signed certificate; the browser shows a one-time certificate warning you accept on first visit.
- **Or put a reverse proxy in front** — Caddy/nginx/Tailscale with a real certificate gives you a clean HTTPS origin, which PWAs and service workers prefer.

Either way, read [Read this first (security)](../getting-started/security.md) before exposing the server to anything wider than your desk, and [First run & login](../getting-started/first-run.md) for the password flow.

## Touch UX

The whole UI is built for fingers, not just shrunk down:

- **Swipe to switch tabs** — swipe left/right anywhere in the chat area to move between session tabs, with an on-screen indicator that fills as your swipe approaches the commit threshold. Two-finger trackpad swipes do the same on iPad with a Magic Keyboard. (Swipes inside the terminal or horizontally-scrollable content are left alone.)
- **Long-press menus** — where desktop right-clicks, touch long-presses: tabs (long-press picks the tab up — drag to reorder, or release in place for the context menu), file chips, the quick-actions FAB, and more.
- **Selection bubbles** — native text selection is painful on touch, so message paragraphs and file-preview blocks have tap-to-select bubble icons instead. See [Comments stash & discussions](stash-and-discussions.md).
- **Quick actions FAB** — the draggable radial menu is the touch-first way to reach panels and actions; there's even an "iPad User" preset. See [Customization](customization.md).
- **Terminal keyboard bar and d-pad** — a key bar (Esc, Tab, Ctrl, Alt, arrows, shell characters) above the software keyboard, with one-shot/locked modifiers and long-press chord menus, plus a swipe-summoned virtual d-pad. Covered in [Embedded terminal](terminal.md#touch-controls).

## iPad with a hardware keyboard

An iPad with a Magic Keyboard is a genuinely good client — with one OS-level catch: iPadOS **reserves some ++cmd++ chords** and never delivers them to web apps, even installed PWAs. Notably ++cmd+comma++, ++cmd+w++, ++cmd+tab++, ++cmd+h++, ++cmd+m++, ++cmd+q++.

Shortcuts that would collide keep a literal ++ctrl++ binding as the iPad-safe fallback — Settings is ++ctrl+comma++ everywhere, close tab is ++alt+w++, tab cycling is ++alt+tab++ (the app's own binding, which iPadOS does deliver). The [keyboard shortcuts reference](../reference/keyboard-shortcuts.md) lists the per-platform bindings; everything is rebindable in **Settings → Shortcuts**.

!!! note "Trackpad hover works, hover media queries don't"
    iPadOS reports `hover: none` even with a trackpad attached, but actual `:hover` works fine — tooltips and hover states behave normally with the Magic Keyboard trackpad.

## Surviving iPadOS storage quirks

iPadOS PWAs have a known WebKit quirk: `localStorage` writes can **silently fail to persist to disk**. Everything looks saved until you reload the page, which reads stale data — historically this meant lost tabs.

pAInapple Code handles this for you: tab state (open sessions, widget tabs, strip order, active tab) is **stored on the server** and reconciled on every page load — if the server and localStorage disagree, the server wins. You don't need to do anything; it's the reason your tabs come back reliably on iPad. If the server is unreachable, the client falls back to localStorage, which is fine on desktop browsers.

## Debugging on the device

No dev tools on an iPad? The app ships its own:

- **Debug console** (++alt+d++) — a widget that captures `console.log`/`warn`/`error` output with per-entry copy and multi-select copy. The everyday "why did that fail" tool.
- **Eruda dev tools** (++alt+shift+d++) — full mobile devtools (DOM inspector, network, console), only available when the server is started with `--enable-eruda`.
- **Capture snapshot** — a quick action that dumps full client state (localStorage, runtime sessions, memory, metrics) to the server as a JSON file, so a desktop session — or Claude itself — can dig through what the device was seeing.
