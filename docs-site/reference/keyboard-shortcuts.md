# Keyboard shortcuts

Every keyboard shortcut in the web client, grouped the same way as the in-app help.

Some shortcuts bind different keys per platform: **Mac / iPad** uses ++cmd++, **Windows / Linux** uses ++ctrl++, and a few bindings are literal and identical everywhere. Where a row shows two columns, both are listed; where it shows one combo, it works on all platforms.

!!! tip "In-app help and customization"
    Open the command palette (++ctrl+shift+p++ / ++cmd+shift+p++, or ++f1++ on Windows/Linux) or type `/help` to see the same list inside the app. Every binding can be rebound in **Settings → Shortcuts** (++ctrl+comma++); your overrides are synced to the server, so they follow you across browsers and devices.

!!! note "iPad-reserved Cmd combos"
    iPadOS reserves some ++cmd++ chords at the OS level — they never reach the web app, even in the PWA. Two of the app's bindings land on reserved chords, and each carries an additive fallback that always works: **Settings** is ++ctrl+comma++ everywhere, with ++cmd+comma++ riding along on macOS proper; **Close tab** is ++alt+w++ everywhere, with ++cmd+w++ on Mac and ++ctrl+w++ on Windows/Linux. Note the fallback is not always a ++ctrl++ chord — close-tab's is ++alt+w++, because ++ctrl+w++ is itself taken in browsers. Other reserved chords (++cmd+tab++, ++cmd+h++, ++cmd+q++, ++cmd+m++) are simply never bound; the grid switcher uses ++alt+tab++ on Mac/iPad precisely to stay clear of ++cmd+tab++.

## Sessions & Tabs

| Action | Mac / iPad | Windows / Linux |
|--------|-----------|-----------------|
| New session | ++cmd+t++ | ++ctrl+t++ |
| Quick switcher | ++cmd+k++ / ++cmd+p++ | ++ctrl+k++ / ++ctrl+p++ |
| Browse Claude sessions | ++cmd+shift+k++ | ++ctrl+shift+k++ |
| Open File or Folder | ++cmd+o++ | ++ctrl+o++ |
| Command palette | ++cmd+shift+p++ | ++ctrl+shift+p++ / ++f1++ |
| All sessions grid (cycle forward) | ++alt+tab++ | ++ctrl+shift+bracket-right++ |
| All sessions grid (cycle backward) | ++alt+shift+tab++ | ++ctrl+shift+bracket-left++ |
| Close tab | ++alt+w++ (both) or ++cmd+w++ | ++alt+w++ (both) or ++ctrl+w++ |
| Reopen last closed tab | ++cmd+shift+t++ | ++ctrl+shift+t++ |
| Clone session | ++cmd+n++ | ++ctrl+shift+n++ |
| New scratch tab | ++ctrl+n++ | ++ctrl+n++ |
| Previous tab | ++cmd+bracket-left++ | ++ctrl+bracket-left++ |
| Next tab | ++cmd+bracket-right++ | ++ctrl+bracket-right++ |
| Switch to tab 1–9 | ++cmd+1++ … ++cmd+9++ | ++ctrl+1++ … ++ctrl+9++ |

!!! note
    ++cmd+w++ closes the browser tab on macOS browsers — it only reaches the app in the PWA / standalone wrapper, which is why ++alt+w++ exists as the universal close-tab binding. On Windows/Linux, clone is ++ctrl+shift+n++ because ++ctrl+n++ is taken by "new scratch tab" (and ++ctrl+n++ is deliberately literal on Mac too, where the ++ctrl++ layer is mostly free).

## Panels

| Action | Mac / iPad | Windows / Linux |
|--------|-----------|-----------------|
| Toggle terminal | ++ctrl+grave++ / ++ctrl+backslash++ | ++ctrl+grave++ / ++ctrl+backslash++ |
| New terminal | ++ctrl+shift+grave++ / ++ctrl+shift+c++ / ++cmd+shift+c++ | ++ctrl+shift+grave++ / ++ctrl+shift+c++ |
| Toggle rail menu (sidebar) | ++cmd+b++ | ++ctrl+b++ |
| File explorer | ++alt+f++ | ++alt+f++ |
| File preview (reopen last file) | ++alt+v++ | ++alt+v++ |
| Log explorer | ++alt+l++ | ++alt+l++ |
| Git panel | ++alt+g++ | ++alt+g++ |
| Active sessions | ++alt+s++ | ++alt+s++ |
| Cost analytics | ++alt+4++ | ++alt+4++ |
| Discussion thread | ++alt+slash++ | ++alt+slash++ |
| Browser widget | ++alt+b++ | ++alt+b++ |
| Debug console | ++alt+d++ | ++alt+d++ |
| Eruda dev tools | ++alt+shift+d++ | ++alt+shift+d++ |
| Toggle Journal | ++alt+h++ | ++alt+h++ |
| Zen mode | ++alt+z++ | ++alt+z++ |
| Quick actions (radial menu) | ++ctrl+q++ | ++ctrl+q++ |
| Prompt explorer | ++alt+p++ / ++ctrl+r++ | ++alt+p++ / ++ctrl+r++ |
| Save input as draft | ++ctrl+shift+s++ (both) or ++cmd+shift+s++ | ++ctrl+shift+s++ |
| Skills panel | ++alt+k++ | ++alt+k++ |
| Commands panel | ++alt+shift+k++ | ++alt+shift+k++ |
| Thinking settings | ++cmd+apostrophe++ | ++ctrl+apostrophe++ |
| Cycle effort (one-shot, next message) | ++cmd+shift+apostrophe++ | ++ctrl+shift+apostrophe++ |

Background tasks has a panel toggle action but ships with no default binding — assign one in Settings → Shortcuts if you want it on a key. ++cmd+r++ is bound to page reload on Mac/iPad only, for the standalone PWA wrapper where there is no browser chrome (in a normal browser it just reloads, same as native).

## Search

| Action | Mac / iPad | Windows / Linux |
|--------|-----------|-----------------|
| Search in conversation | ++cmd+f++ | ++ctrl+f++ |
| Search in files (project-wide) | ++cmd+shift+f++ / ++ctrl+shift+f++ | ++ctrl+shift+f++ |
| Find next | ++cmd+g++ | ++ctrl+g++ / ++f3++ |
| Find previous | ++cmd+shift+g++ | ++ctrl+shift+g++ / ++shift+f3++ |

## Editor

| Action | Key |
|--------|-----|
| Toggle edit mode (file preview) | ++e++ |

++e++ only fires when focus is *not* in an input, textarea, or terminal — i.e. while you are viewing a file preview, pressing ++e++ flips it into inline-edit mode.

## Navigation

| Action | Mac / iPad | Windows / Linux |
|--------|-----------|-----------------|
| Previous user message | ++cmd+up++ | ++ctrl+up++ |
| Next user message | ++cmd+down++ | ++ctrl+down++ |
| Focus message input | ++cmd+slash++ | ++ctrl+slash++ |
| Focus project field | ++cmd+l++ | ++ctrl+l++ |
| Reconnect (when disconnected) | ++cmd+enter++ | ++ctrl+enter++ |
| Back to sessions | ++backspace++ | ++backspace++ |

Context gates worth knowing:

- **Previous/next user message** only fire while a session view is active.
- **Focus input** skips the CodeMirror editor, so ++cmd+slash++ / ++ctrl+slash++ still toggles comments in scratch tabs — but it *does* work from inside the terminal, as an escape hatch back to the chat input.
- **Reconnect** only fires when the active session is disconnected; otherwise the key passes through to other handlers (e.g. send).
- **Back to sessions** only fires when the back pill is visible and the message input is empty — it never steals ++backspace++ while you are editing text.

## Other

| Action | Key |
|--------|-----|
| Settings | ++ctrl+comma++ (all platforms), plus ++cmd+comma++ on macOS |
| Close / cancel | ++escape++ |
| Allow pending permission | ++enter++ (only while a permission card is waiting) |
| Help | no default binding — use the command palette or `/help` |
| Reload page (Mac/iPad only) | ++cmd+r++ |

++escape++ is gated out of the terminal so it reaches your shell, vim, etc.

**Allow pending permission** is deliberately narrow: it fires only when an approve/deny card is actually waiting, never in the terminal, and — if focus is in a text field — only from an *empty* message box. That keeps ++enter++ as Send while you're typing, and leaves it to the deny-guidance field when you're writing one.

## How context gating works

Each shortcut declares a `when` context. The defaults:

| Context | Behavior |
|---------|----------|
| `global` (default) | Fires everywhere **except** when the terminal is focused, so keystrokes pass through to the shell |
| `always` | Fires everywhere, including inside the terminal (tab switching, quick switcher, …) |
| `notInInput` | Suppressed while typing in any input or textarea |
| `notInTerminal` | Suppressed only in the terminal |
| `notInEditor` | Suppressed in the CodeMirror editor (lets the editor keymap win) |
| `session` | Only while a chat session view is active |
| `disconnected` | Only when a session exists and is disconnected — so once connected, the key passes through to other handlers (this is how ++cmd+enter++ can mean both Reconnect and Send) |
| `permissionPending` | Only while an approve/deny permission card is waiting, never in the terminal, and from a text field only when it's the empty message box |
| `backToSessionsContext` | Only when the back pill is visible, outside the terminal, and — in an input — only when it's empty, so ++backspace++ is never stolen mid-edit |

This is why ++ctrl+b++ still works as your tmux prefix inside the terminal widget: the rail-menu toggle uses the default `global` context and stays out of the terminal's way.
