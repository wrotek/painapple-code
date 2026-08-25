"""Terminal UI helpers shared by CLI subcommands.

Two layers:

1. Plain ANSI output helpers (``say``/``info``/``ok``/``warn``/``err``) —
   zero dependencies, safe to import in non-TTY contexts. Mirrors the
   look of painapple-docker.sh so the two tools feel like one.

2. Interactive prompt widgets built on questionary/prompt_toolkit —
   imported lazily so `docker up`/`logs`/etc. never pay the import and
   never break in a pipe. Every widget understands "back": selects get
   a dedicated ``← Back`` entry, text/path prompts bind Esc. A widget
   returns the sentinel :data:`BACK` when the user backs out, so wizard
   step machines can just compare against it.
"""

import os
import re
import sys


# Unique sentinel: "user asked to go back one step".
class _Back:
    def __repr__(self):
        return "<BACK>"


BACK = _Back()

# Legacy Windows conhost ignores ANSI escapes until VT processing is
# switched on; the empty os.system() call does exactly that (Windows
# Terminal and every unix terminal don't need it, and it's a no-op there).
if os.name == "nt" and sys.stdout.isatty():
    os.system("")

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")

BOLD = "\033[1m" if _COLOR else ""
DIM = "\033[2m" if _COLOR else ""
GREEN = "\033[32m" if _COLOR else ""
YELLOW = "\033[33m" if _COLOR else ""
RED = "\033[31m" if _COLOR else ""
BLUE = "\033[34m" if _COLOR else ""
CYAN = "\033[36m" if _COLOR else ""
RESET = "\033[0m" if _COLOR else ""


def say(msg=""):
    print(msg)


def info(msg):
    print(f"{BLUE}→{RESET} {msg}")


def ok(msg):
    print(f"{GREEN}✓{RESET} {msg}")


def warn(msg):
    print(f"{YELLOW}⚠{RESET} {msg}", file=sys.stderr)


def err(msg):
    print(f"{RED}✗{RESET} {msg}", file=sys.stderr)


def die(msg, hint=None):
    err(msg)
    if hint:
        say(hint)
    raise SystemExit(1)


def sanitize(value):
    """Strip control bytes some terminals smuggle into typed input."""
    return re.sub(r"[\x00-\x1f\x7f]", "", value)


def print_credentials(urls, pw, token):
    """The credential block behind `painapple password` (host AND docker).

    One shared body so the two paths can't drift. Labels carry each
    credential's purpose — users copy the line they need, not the footer
    hints. ``token`` is "" on a config written by a pre-WP-02 build; the
    URL is then a bare address (manual login form) and the API-token
    row/hint are dropped.
    """
    width = len("Password (login form):") + 2

    def _row(label, value):
        say(f"{BOLD}{label}{RESET}{' ' * (width - len(label))}{value}")

    url_label = "Auto-Login URL:" if token else "URL:"
    for url in urls:
        _row(url_label, url)
        url_label = ""
    _row("Password (login form):", pw)
    if token:
        _row("API token (scripts):", token)
        say(f"{DIM}  Open the URL once; the cookie keeps you logged in after that.{RESET}")
        say(f"{DIM}  Scripts use the API token (Bearer / ?tkn=), never the password.{RESET}")
    else:
        say(f"{DIM}  Open the URL and log in with the password; the cookie keeps you logged in.{RESET}")


def require_tty(what="interactive setup", alternative=None):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        die(f"{what} needs a terminal.",
            alternative or
            f"{DIM}Non-interactive alternative:  painapple profile set "
            f"NAME KEY=VALUE …{RESET}")


# ──── Interactive widgets (lazy questionary import) ─────────────────────────

_BACK_TITLE = "← Back"


def _questionary():
    try:
        import questionary
        return questionary
    except ImportError:
        die("The interactive setup needs the 'questionary' package.",
            f"{DIM}Install it with:  pip install questionary{RESET}")


def _style():
    from prompt_toolkit.styles import Style
    return Style([
        ("qmark", "fg:ansicyan bold"),
        ("question", "bold"),
        ("answer", "fg:ansicyan"),
        ("pointer", "fg:ansicyan bold"),
        ("highlighted", "fg:ansicyan bold"),
        ("instruction", "fg:ansibrightblack"),
        ("text", ""),
        ("dim", "fg:ansibrightblack"),
    ])


class Choice:
    """One selectable option: a value, a short title, an optional dim hint."""

    def __init__(self, value, title, hint=None):
        self.value = value
        self.title = title
        self.hint = hint


def select(message, choices, default=None, back=False, instruction=None,
           use_search=False, on_left=None, right_pick=None):
    """Arrow-key menu. Returns the picked Choice's value, or BACK.

    ``choices`` is a list of :class:`Choice` (or plain strings, used as
    both value and title). ``default`` pre-highlights the choice with
    that value. ``back=True`` appends a dim ``← Back`` entry — and makes
    the ← key return BACK too (previous step), unless ``on_left``
    overrides it with a different value (the directory browser maps ← to
    "go to parent"). ``right_pick`` is a predicate on choice values: when
    it accepts the highlighted value, the → key picks it (browser: enter
    the highlighted folder). ``use_search=True`` enables type-to-filter.
    """
    questionary = _questionary()

    if on_left is None and back:
        on_left = BACK

    normalized = [c if isinstance(c, Choice) else Choice(c, str(c)) for c in choices]
    q_choices = []
    default_choice = None
    for c in normalized:
        # questionary's search filter calls .lower() on the title, so
        # searchable selects need plain-string titles (hint folded in,
        # un-dimmed — and conveniently filterable too).
        if use_search:
            title = f"{c.title}  {c.hint}" if c.hint else c.title
        else:
            title = [("class:text", c.title)]
            if c.hint:
                title.append(("class:dim", f"  {c.hint}"))
        qc = questionary.Choice(title=title, value=c.value)
        q_choices.append(qc)
        if default is not None and c.value == default:
            default_choice = qc
    if back:
        q_choices.append(questionary.Choice(
            title=_BACK_TITLE if use_search else [("class:dim", _BACK_TITLE)],
            value=BACK))

    if instruction is None:
        base = "type to filter, ↑↓ + Enter" if use_search else "↑↓ + Enter"
        instruction = f"({base}, ← back)" if on_left is BACK else f"({base})"

    question = questionary.select(
        message,
        choices=q_choices,
        default=default_choice,
        style=_style(),
        instruction=instruction,
        use_shortcuts=False,
        use_search_filter=use_search,
        use_jk_keys=False,
    )

    # ←/→ bindings ride on top of questionary's own. The application
    # consults key_bindings dynamically, so merging before run() works.
    if on_left is not None or right_pick is not None:
        from prompt_toolkit.key_binding import KeyBindings, merge_key_bindings
        extra = KeyBindings()
        app = question.application
        if on_left is not None:
            @extra.add("left")
            def _(event):
                event.app.exit(result=on_left)
        if right_pick is not None:
            ic = _find_inquirer_control(app)
            if ic is not None:
                @extra.add("right")
                def _(event):
                    pointed = ic.get_pointed_at()
                    if pointed is not None and right_pick(pointed.value):
                        event.app.exit(result=pointed.value)
        app.key_bindings = (merge_key_bindings([app.key_bindings, extra])
                            if app.key_bindings else extra)

    return question.unsafe_ask()


def _find_inquirer_control(app):
    """The list control inside a questionary select — needed to read the
    highlighted choice from a custom key binding."""
    from questionary.prompts.common import InquirerControl
    for control in app.layout.find_all_controls():
        if isinstance(control, InquirerControl):
            return control
    return None


def _prompt_session(completer=None):
    from prompt_toolkit import PromptSession
    from prompt_toolkit.key_binding import KeyBindings

    bindings = KeyBindings()

    class _BackRequested(Exception):
        pass

    @bindings.add("escape", eager=True)
    def _(event):
        event.app.exit(exception=_BackRequested())

    return PromptSession(key_bindings=bindings, completer=completer), _BackRequested


def text(message, default="", validate=None, back=True, completer=None,
         hint=None):
    """One-line input with the default pre-filled and editable.

    The user edits the default in place (arrows/Home/End work) instead
    of retyping it. Esc returns BACK (when ``back``). ``validate`` is a
    callable returning an error string (re-prompt) or None (accept).
    """
    from prompt_toolkit.formatted_text import FormattedText

    session, back_exc = _prompt_session(completer)
    esc_part = "Esc = back, " if back else ""
    suffix = hint or ""
    prompt_msg = FormattedText([
        ("fg:ansicyan bold", "? "),
        ("bold", message),
        ("fg:ansibrightblack", f"  ({esc_part}Enter = accept){suffix}"),
        ("", "\n  "),
    ])
    while True:
        try:
            reply = session.prompt(prompt_msg, default=default)
        except back_exc:
            if back:
                return BACK
            continue
        reply = sanitize(reply).strip()
        if validate:
            problem = validate(reply)
            if problem:
                warn(problem)
                default = reply  # keep what they typed for correction
                continue
        return reply


def path_input(message, default="", must_exist=False, back=True,
               offer_create=False):
    """Path input: pre-filled editable default + filesystem tab-completion.

    ``must_exist`` re-prompts (keeping the typed value) until the
    directory exists; with ``offer_create`` the user is asked whether to
    mkdir -p it instead.
    """
    from prompt_toolkit.completion import PathCompleter
    from pathlib import Path

    completer = PathCompleter(expanduser=True)
    current_default = default
    while True:
        reply = text(message, default=current_default, back=back,
                     completer=completer, hint="  Tab = complete")
        if reply is BACK:
            return BACK
        if not reply:
            warn("Path can't be empty.")
            continue
        p = Path(reply).expanduser()
        if must_exist and not p.is_dir():
            if offer_create and confirm(f"Directory does not exist: {p} — create it?",
                                        default=False):
                p.mkdir(parents=True, exist_ok=True)
            else:
                warn(f"Directory does not exist: {p}")
                current_default = reply
                continue
        return str(p.resolve() if p.exists() else p)


def int_input(message, default, lo=None, hi=None, back=True):
    def _validate(v):
        if not v.isdigit():
            return f"Need a number{f' between {lo} and {hi}' if lo else ''}."
        n = int(v)
        if lo is not None and n < lo or hi is not None and n > hi:
            return f"Must be between {lo} and {hi}."
        return None

    reply = text(message, default=str(default), validate=_validate, back=back)
    return reply if reply is BACK else int(reply)


def confirm(message, default=True):
    questionary = _questionary()
    return questionary.confirm(message, default=default, style=_style()).unsafe_ask()


def browse_dir(message, start=None, allow_create=False, back=True,
               suggest=None):
    """Interactive directory picker (mc/ncdu-style): descend into
    subdirectories, go up with `..`, type letters to filter the list.

    Escape hatches: "Type a path instead…" drops to the completing text
    prompt; ``allow_create`` adds a "New folder here…" entry. ``suggest``
    keeps a not-yet-existing default one Enter away (shown as its own
    entry, created later by the caller). Returns the chosen absolute
    path as str, or BACK.
    """
    from pathlib import Path

    suggest_path = None
    if suggest:
        suggest_path = Path(suggest).expanduser()
        if suggest_path.is_dir():
            suggest_path = None  # it exists — the browser just starts there

    current = Path(start).expanduser() if start else Path.cwd()
    try:
        current = current.resolve()
    except OSError:
        current = Path.home()
    # A saved-but-vanished default shouldn't strand the browser — walk up
    # to the nearest ancestor that still exists.
    while not current.is_dir() and current.parent != current:
        current = current.parent
    if not current.is_dir():
        current = Path.home()

    show_hidden = False
    while True:
        try:
            subdirs = sorted(
                (p for p in current.iterdir()
                 if p.is_dir() and (show_hidden or not p.name.startswith("."))),
                key=lambda p: p.name.lower())
        except OSError as e:
            warn(f"Can't list {current}: {e}")
            subdirs = []

        choices = []
        if suggest_path is not None:
            choices.append(Choice("suggest", f"✓ Use {suggest_path}",
                                  "default — will be created"))
        choices += [Choice("use", "✓ Use this directory", str(current)),
                    Choice("type", "✎ Type a path instead…")]
        if current.parent != current:
            choices.append(Choice("up", "↑ ..", "up one level"))
        choices.extend(Choice(("cd", p), f"{p.name}/") for p in subdirs)
        if allow_create:
            choices.append(Choice("mkdir", "＋ New folder here…"))
        choices.append(Choice("hidden", "· Hide hidden folders" if show_hidden
                              else "· Show hidden folders"))

        # Plain string — questionary messages go through prompt_toolkit,
        # which renders raw ANSI escapes as literal text.
        # ← climbs to the parent (not "previous step" like elsewhere) and
        # → enters the highlighted folder — mc-style navigation.
        picked = select(
            f"{message}  [{current}]", choices, back=back, use_search=True,
            on_left="up",
            right_pick=lambda v: v == "up" or (isinstance(v, tuple) and v[0] == "cd"),
            instruction="(type to filter, ↑↓ + Enter, ←/→ = parent/enter dir)")
        if picked is BACK:
            return BACK
        if picked == "suggest":
            return str(suggest_path)
        if picked == "use":
            return str(current)
        if picked == "up":
            current = current.parent
        elif picked == "hidden":
            show_hidden = not show_hidden
        elif picked == "type":
            typed = path_input(message, default=str(current),
                               must_exist=not allow_create,
                               offer_create=allow_create, back=True)
            if typed is BACK:
                continue  # back into the browser, not out of it
            return typed
        elif picked == "mkdir":
            name = text("New folder name", default="", back=True)
            if name is BACK or not name:
                continue
            new_dir = current / name
            try:
                new_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                warn(f"Can't create {new_dir}: {e}")
                continue
            current = new_dir.resolve()
        else:
            current = picked[1]
