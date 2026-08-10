# Git & diff viewer

Keep an eye on what Claude is doing to your working tree without leaving the chat: a git panel for status and history, and a diff viewer that can compare almost anything against almost anything.

## The git widget

Press ++alt+g++ to open the git panel for the current session's repository. The header shows the branch as a pill, with ahead/behind arrows (`↑2 ↓1`) when your branch has diverged from its upstream — the same branch also appears in the session status bar.

The **status view** groups uncommitted work into **Staged Changes**, **Changes**, and **Untracked Files**, each with a count. Every file gets a colored status letter (M modified, A added, D deleted, R renamed, C copied, ? untracked) and `+/-` line stats. Click a tracked file to see its diff inline — hunk by hunk, right in the panel — with a back button to return and a columns button to reopen the same diff [side by side](#the-diff-viewer) in the full diff viewer.

Two header buttons switch context: the clock opens **commit history** (twenty commits at a time, with *load more*), and the refresh button re-reads status. Click a commit to open its **detail view**: full message (expandable when long), author, relative time, and the file list with per-file `+/-` stats — click any file to open that commit's diff in the diff viewer.

Right-clicking a changed file gets you the usual file actions (the same menu as chat file pills), and the widget floats, docks as a sidebar, or promotes to a tab like everything else.

!!! note "Read-only by design"
    The git widget shows state; it doesn't stage, commit, or push. Ask Claude to run the git commands, or drop into the [embedded terminal](terminal.md) and do it yourself.

## The diff viewer

The diff viewer is a dedicated widget for comparing two versions of a file — or a set of files — with two rendering modes you can toggle at any time: **Split** (side-by-side columns, perfectly line-aligned) and **Unified** (classic single-column). Below about 600 px of widget width, Split is not worth the columns — the viewer renders Unified regardless of the toggle until you make it wider. A wrap toggle handles long lines, unchanged regions collapse into "*N unchanged lines*" expanders, and when it holds multiple files, arrows step through them. On the keyboard, ++j++ / ++n++ jump to the next hunk and ++k++ / ++p++ to the previous one.

You'll land in it from all over the app:

- **Edit tool blocks** in the chat — every edit Claude makes renders as a diff pill with a *Side-by-side* button.
- **Turn summary bar** file pills — tap for the diff, long-press for compare presets.
- **The git widget** — the side-by-side button on a working-tree diff, or any file inside a commit's detail view.
- **The file explorer** — **Compare…** on any file, or **Select for Compare** on one file followed by **Compare with…** on another for a quick two-file diff.
- **The Journal** — [history explorer](shadow-git.md#browsing-the-journal-widget) entries have *Open in diff tool*.
- **The file preview's History tab** — a per-file timeline of [Shadow Git](shadow-git.md) snapshots.

### The history bar

When the compared file has [Shadow Git](shadow-git.md) history, a bar across the top of the diff turns it into a time machine: **From** and **To** pickers select any two recorded snapshots, arrow buttons step to older or newer ones, and pivot shortcuts jump to the common questions — **vs HEAD** (working tree against your last real git commit), **vs Working** (a snapshot against the file on disk right now), or **Pick…** to open the Compare Wizard.

### The Compare Wizard

**Compare…** (from the file explorer, a file pill's long-press menu, or the history bar's **Pick…**) opens a small wizard: choose what to compare the file against, then pick the exact version. Five sources:

| Source | What you're comparing against |
|--------|-------------------------------|
| **Shadow History** | Versions recorded from Claude sessions — every turn that touched the file |
| **Git History** | Previous git commits that touched the file |
| **Git Branches** | The same file on another branch |
| **Working Changes** | HEAD vs working tree, or HEAD vs staged |
| **Another File** | Any other file in the project (searchable picker) |

The wizard is fully keyboard-navigable — arrows to move, ++enter++ to select, ++escape++ to back out.
