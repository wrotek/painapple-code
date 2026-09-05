"""
Bash command → file-access classifier.

Claude (and Codex) routinely edit files through the Bash tool — `sed -i`,
heredoc redirects, `tee`, `mv` — rather than Edit/Write. Attribution used to
be tool-name gated (`tool_name in ("Edit", "Write")`), so those edits were
invisible to the turn-summary pills, `turn_files`, the shadow-git commit
frontmatter, and the quick switcher's recency ranking; a five-file `sed -i`
turn was even classified "tool_only" and summarized as research.

This module turns a Bash `command` string into candidate file operations:

    ops = classify_bash_command("cd src && sed -i 's/a/b/' x.py", cwd)
    ops.writes   -> {"src/x.py"}
    ops.reads    -> set()
    ops.deletes  -> set()

Paths are returned RELATIVE to `cwd` (posix separators) and only when they
resolve INSIDE it — a heuristic parser must stay conservative, so
`/tmp/...`, `~/.config/...`, `/dev/null` and anything outside the project
are dropped. Globs, `$VARS`, and command substitutions are skipped rather
than guessed. The classifier is PURE (no filesystem access except an
injectable `isdir` used for `mv`/`cp` destination-directory semantics);
`verify_ops()` is the filesystem-checking step callers run once the tool
result has landed, so a `sed -i` on a missing file or a failed command never
records a phantom edit.

Segmenting: the command is split on unquoted `;`, `&&`, `||`, `|`, `&`,
newlines and parens (with `cd` tracked per segment and scoped to subshells),
heredoc bodies are stripped first, and each segment is `shlex.split` in
POSIX mode — so `sed 's|a|b|'`, `grep '>' file` and `"quoted > text"` do not
fool the redirect scanner.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable, Optional

# Per-command cap so a pathological `rm a b c … ×5000` can't flood a turn.
MAX_PATHS_PER_COMMAND = 50

# Leading tokens that wrap the real command (shell keywords, privilege /
# timing wrappers). Stripped repeatedly until a real command word appears.
_PREFIX_TOKENS = frozenset({
    "if", "then", "else", "elif", "do", "while", "until", "!", "{", "}",
    "time", "sudo", "nohup", "env", "command", "builtin", "exec", "nice",
})
# Segments that are pure control flow — nothing to classify.
_SKIP_LEADERS = frozenset({"for", "case", "function", "done", "fi", "esac", "select", "in"})

_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Redirect operators are tagged with this sentinel by the segment splitter
# WHILE it still knows quote state — `shlex.split` erases quoting, so a
# quoted `'>'` (grep pattern) would otherwise be indistinguishable from a
# real redirect afterwards. Only sentinel-marked operators are redirects.
_REDIR_MARK = "\x00"
_REDIR_OP_RE = re.compile(r"&>>|&>|>>|>\||>&|<&|<<<|<<|<|>")
# fd-aware redirect token: `>f`, `2>`, `>>`, `&>`, `2>&1`, `<f`, `<<EOF`, `<<<str`
_REDIRECT_RE = re.compile(
    r"^(?P<fd>\d*)" + _REDIR_MARK + r"(?P<op>&>>|&>|>>|>\||>&|<&|<<<|<<|<|>)(?P<target>.*)$"
)
_HEREDOC_RE = re.compile(r"<<-?\s*(?P<q>['\"]?)(?P<tag>[A-Za-z_][A-Za-z0-9_]*)(?P=q)")
_OPTION_RE = re.compile(r"^-")
_UNSAFE_TOKEN_RE = re.compile(r"[$`*?\[{]")  # variables, substitutions, globs, brace expansion

# Commands whose positional args are READ. Value = number of leading
# positionals to skip (e.g. jq's filter) — None means "all positionals".
_READ_COMMANDS: dict[str, int] = {
    "cat": 0, "head": 0, "tail": 0, "less": 0, "more": 0, "bat": 0, "batcat": 0,
    "wc": 0, "nl": 0, "tac": 0, "strings": 0, "hexdump": 0, "xxd": 0, "od": 0,
    "file": 0, "stat": 0, "md5sum": 0, "sha1sum": 0, "sha256sum": 0,
    "sort": 0, "uniq": 0, "cut": 0, "column": 0, "fold": 0, "rev": 0,
    "diff": 0, "cmp": 0, "comm": 0, "source": 0, ".": 0,
    "jq": 1, "yq": 1,
}
# Options that consume a following value, so it isn't mistaken for a path.
_VALUE_OPTS: dict[str, frozenset] = {
    "head": frozenset({"-n", "-c"}),
    "tail": frozenset({"-n", "-c"}),
    "cut": frozenset({"-d", "-f", "-c", "-b"}),
    "sort": frozenset({"-k", "-t", "-o"}),
    "wc": frozenset(),
    "grep": frozenset({"-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C",
                       "--include", "--exclude", "--exclude-dir", "-d", "--color"}),
    "rg": frozenset({"-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C",
                     "-g", "--glob", "-t", "--type", "-T", "--type-not", "--color", "--max-depth"}),
    "sed": frozenset({"-e", "--expression", "-f", "--file", "-l", "--line-length"}),
    "awk": frozenset({"-F", "-v", "-f"}),
    "gawk": frozenset({"-F", "-v", "-f"}),
    "perl": frozenset({"-e", "-E", "-M", "-m", "-I"}),
    "truncate": frozenset({"-s", "--size", "-r", "--reference"}),
    "tee": frozenset(),
    "mv": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "cp": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "jq": frozenset({"--arg", "--argjson", "--slurpfile", "--rawfile", "-f", "--from-file", "--indent"}),
    "yq": frozenset({"-o", "--output-format", "-p", "--input-format"}),
    "dd": frozenset(),
}
_GREP_COMMANDS = frozenset({"grep", "egrep", "fgrep", "rg", "ag", "ack", "zgrep"})


@dataclass
class BashFileOps:
    """Candidate file operations extracted from one Bash command.

    All paths are cwd-relative posix. `reads` never overlaps `writes` or
    `deletes` (an in-place edit reads and writes; it counts as a write).
    """
    writes: set[str] = field(default_factory=set)
    deletes: set[str] = field(default_factory=set)
    reads: set[str] = field(default_factory=set)

    @property
    def is_empty(self) -> bool:
        return not (self.writes or self.deletes or self.reads)

    def all_paths(self) -> set[str]:
        return self.writes | self.deletes | self.reads


# ═══════════════════════════════════════════════════════════════════════════
# Preprocessing
# ═══════════════════════════════════════════════════════════════════════════

def _strip_heredocs(command: str) -> str:
    """Remove heredoc BODIES (`<<EOF … EOF`) so their contents are never
    scanned for commands or paths. The `<<EOF` marker itself stays (it's
    consumed as a redirect token later)."""
    out: list[str] = []
    pos = 0
    while True:
        m = _HEREDOC_RE.search(command, pos)
        if not m:
            out.append(command[pos:])
            break
        tag = m.group("tag")
        # Body starts on the line AFTER the one holding the marker.
        line_end = command.find("\n", m.end())
        if line_end == -1:
            out.append(command[pos:])
            break
        out.append(command[pos:line_end])
        # Find the terminator line (optionally tab-indented for <<-).
        body_pos = line_end + 1
        term_re = re.compile(r"^\t*" + re.escape(tag) + r"[ \t]*$", re.MULTILINE)
        t = term_re.search(command, body_pos)
        if not t:
            # Unterminated heredoc: everything after is body.
            break
        pos = t.end()
    return "".join(out)


def _split_segments(command: str) -> list[str]:
    """Split on unquoted command separators. Returns segment strings plus
    the literal markers "(" and ")" so callers can scope `cd` to subshells.

    Tracks single quotes, double quotes and backslashes. Backticks are
    treated as separators (their contents become their own segment, which
    is the right call for `$(cat file)` / `` `cat file` ``)."""
    segments: list[str] = []
    buf: list[str] = []
    quote: Optional[str] = None
    i, n = 0, len(command)

    def flush():
        s = "".join(buf).strip()
        buf.clear()
        if s:
            segments.append(s)

    while i < n:
        c = command[i]
        if quote:
            if c == "\\" and quote == '"' and i + 1 < n:
                buf.append(c)
                buf.append(command[i + 1])
                i += 2
                continue
            buf.append(c)
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            buf.append(c)
            buf.append(command[i + 1])
            i += 2
            continue
        if c in ("'", '"'):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == "\n" or c == ";" or c == "`":
            flush()
            i += 1
            continue
        if c in "<>&":
            m = _REDIR_OP_RE.match(command, i)
            if m:
                # Unquoted redirect operator — tag it so the tokenizer's
                # output still carries "this was a real operator".
                buf.append(_REDIR_MARK + m.group(0))
                i = m.end()
                continue
        if c == "&" or c == "|":
            flush()
            # collapse && / || / |&
            i += 1
            while i < n and command[i] in "&|":
                i += 1
            continue
        if c == "(" or c == ")":
            flush()
            segments.append(c)
            i += 1
            continue
        buf.append(c)
        i += 1
    flush()
    return segments


def _tokenize(segment: str) -> list[str]:
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        # Unbalanced quotes — degrade to whitespace split, still useful for
        # the common `sed -i … file` shape.
        return segment.split()


# ═══════════════════════════════════════════════════════════════════════════
# Path resolution
# ═══════════════════════════════════════════════════════════════════════════

class _Resolver:
    """Resolves tokens to project-relative paths against a tracked cwd."""

    def __init__(self, project_cwd: str):
        self.root = os.path.normpath(os.path.expanduser(project_cwd))
        self.cwd: Optional[str] = self.root  # None once `cd` went somewhere unknowable
        self._stack: list[Optional[str]] = []

    def push(self):
        self._stack.append(self.cwd)

    def pop(self):
        if self._stack:
            self.cwd = self._stack.pop()

    def chdir(self, target: Optional[str]):
        if target is None or _UNSAFE_TOKEN_RE.search(target) or target == "-":
            self.cwd = None
            return
        target = os.path.expanduser(target)
        if os.path.isabs(target):
            self.cwd = os.path.normpath(target)
        elif self.cwd is not None:
            self.cwd = os.path.normpath(os.path.join(self.cwd, target))

    def resolve(self, token: str) -> Optional[str]:
        """Project-relative posix path, or None when the token isn't a
        plain in-project path."""
        if not token or _UNSAFE_TOKEN_RE.search(token) or token.startswith("-"):
            return None
        if token in (".", "..", "/") or token.endswith("/"):
            return None  # directories, never files
        expanded = os.path.expanduser(token)
        if os.path.isabs(expanded):
            abs_path = os.path.normpath(expanded)
        else:
            if self.cwd is None:
                return None
            abs_path = os.path.normpath(os.path.join(self.cwd, expanded))
        try:
            rel = os.path.relpath(abs_path, self.root)
        except ValueError:
            return None  # different drive on Windows
        if rel == "." or rel.startswith(".." + os.sep) or rel == "..":
            return None
        rel_posix = Path(rel).as_posix()
        first = PurePosixPath(rel_posix).parts[0] if rel_posix else ""
        if first == ".git":
            return None
        return rel_posix

    def abs_of(self, rel_posix: str) -> str:
        return os.path.join(self.root, *PurePosixPath(rel_posix).parts)


# ═══════════════════════════════════════════════════════════════════════════
# Per-segment classification
# ═══════════════════════════════════════════════════════════════════════════

def _extract_redirects(tokens: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Pull redirections out of a token list.

    Returns (remaining_tokens, write_targets, read_targets)."""
    rest: list[str] = []
    writes: list[str] = []
    reads: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        m = _REDIRECT_RE.match(tok)
        if not m:
            rest.append(tok)
            i += 1
            continue
        op, target = m.group("op"), m.group("target")
        if not target:
            if i + 1 < len(tokens):
                target = tokens[i + 1]
                i += 1
            else:
                i += 1
                continue
        i += 1
        if op in (">&", "<&"):
            # fd duplication (2>&1) unless the target is a real filename
            if target.isdigit() or target == "-":
                continue
            if op == ">&":
                writes.append(target)
            else:
                reads.append(target)
        elif op in (">", ">>", ">|", "&>", "&>>"):
            writes.append(target)
        elif op == "<":
            reads.append(target)
        # "<<" / "<<<": heredoc marker / herestring — nothing to record
    return rest, writes, reads


def _positionals(cmd: str, args: list[str]) -> list[str]:
    """Positional (non-option) args, honoring `--` and value-taking options."""
    value_opts = _VALUE_OPTS.get(cmd, frozenset())
    out: list[str] = []
    i = 0
    end_of_opts = False
    while i < len(args):
        a = args[i]
        if end_of_opts:
            out.append(a)
        elif a == "--":
            end_of_opts = True
        elif a.startswith("-") and len(a) > 1:
            if a in value_opts:
                i += 1  # skip the value
            elif "=" not in a and cmd in ("sed", "perl", "awk", "gawk") and _short_opt_takes_value(cmd, a):
                i += 1
        else:
            out.append(a)
        i += 1
    return out


def _short_opt_takes_value(cmd: str, opt: str) -> bool:
    """Clustered short options ending in a value-taker: sed `-ne` (no), `-e`
    handled above; perl `-pe` ends in e → next token is the script."""
    if cmd == "perl":
        return opt[-1] in ("e", "E", "M", "m", "I") and not opt.startswith("--")
    if cmd in ("awk", "gawk"):
        return opt[-1] in ("F", "v", "f") and len(opt) > 2 and not opt.startswith("--")
    return False


def _has_inplace_flag(cmd: str, args: list[str]) -> bool:
    for a in args:
        if a == "--":
            break
        if a in ("--in-place",) or a.startswith("--in-place="):
            return True
        if cmd in ("sed", "perl") and a.startswith("-") and not a.startswith("--") and "i" in a[1:]:
            return True
    if cmd in ("awk", "gawk"):
        for i, a in enumerate(args):
            if a == "-i" and i + 1 < len(args) and args[i + 1] == "inplace":
                return True
            if a == "-iinplace" or a == "--in-place":
                return True
    return False


def _classify_segment(tokens: list[str], res: _Resolver, ops: BashFileOps,
                      isdir: Callable[[str], bool]) -> None:
    tokens, redir_writes, redir_reads = _extract_redirects(tokens)

    # Strip wrappers / env assignments
    while tokens and (tokens[0] in _PREFIX_TOKENS or _ASSIGNMENT_RE.match(tokens[0])):
        tokens = tokens[1:]

    def add(kind: str, raw: str):
        rel = res.resolve(raw)
        if rel:
            getattr(ops, kind).add(rel)

    for t in redir_writes:
        add("writes", t)
    for t in redir_reads:
        add("reads", t)

    if not tokens:
        return
    cmd = os.path.basename(tokens[0])
    if cmd in _SKIP_LEADERS:
        return
    args = tokens[1:]

    if cmd in ("cd", "pushd"):
        res.chdir(args[0] if args else None)
        return
    if cmd == "popd":
        res.cwd = None
        return

    if cmd == "sed":
        pos = _positionals(cmd, args)
        has_script_opt = any(a in ("-e", "--expression", "-f", "--file") or a.startswith("--expression=")
                             for a in args) or any(
            a.startswith("-") and not a.startswith("--") and a[-1] in ("e", "f") and len(a) > 2 for a in args)
        files = pos if has_script_opt else pos[1:]
        kind = "writes" if _has_inplace_flag(cmd, args) else "reads"
        for f in files:
            add(kind, f)
        return

    if cmd == "perl":
        pos = _positionals(cmd, args)
        has_script_opt = any(a.startswith("-") and not a.startswith("--") and a[-1] in ("e", "E") for a in args)
        files = pos if has_script_opt else pos[1:]  # else first positional is the script file
        kind = "writes" if _has_inplace_flag(cmd, args) else "reads"
        for f in files:
            add(kind, f)
        return

    if cmd in ("awk", "gawk", "mawk"):
        pos = _positionals("awk", args)
        has_prog_file = any(a == "-f" or (a.startswith("-f") and not a.startswith("--")) for a in args)
        files = pos if has_prog_file else pos[1:]
        kind = "writes" if _has_inplace_flag(cmd, args) else "reads"
        for f in files:
            add(kind, f)
        return

    if cmd in _GREP_COMMANDS:
        pos = _positionals("rg" if cmd == "rg" else "grep", args)
        has_pattern_opt = any(a in ("-e", "--regexp", "-f", "--file") or a.startswith("--regexp=") for a in args)
        files = pos if has_pattern_opt else pos[1:]
        for f in files:
            add("reads", f)
        return

    if cmd in _READ_COMMANDS:
        skip = _READ_COMMANDS[cmd]
        for f in _positionals(cmd, args)[skip:]:
            add("reads", f)
        return

    if cmd in ("tee", "touch", "sponge", "patch"):
        for f in _positionals(cmd, args):
            add("writes", f)
        return

    if cmd == "truncate":
        for f in _positionals(cmd, args):
            add("writes", f)
        return

    if cmd == "rm":
        for f in _positionals(cmd, args):
            add("deletes", f)
        return

    if cmd in ("mv", "cp"):
        pos = _positionals(cmd, args)
        target_dir = None
        for i, a in enumerate(args):
            if a in ("-t", "--target-directory") and i + 1 < len(args):
                target_dir = args[i + 1]
            elif a.startswith("--target-directory="):
                target_dir = a.split("=", 1)[1]
        if target_dir is not None:
            srcs, dst = pos, target_dir
        elif len(pos) >= 2:
            srcs, dst = pos[:-1], pos[-1]
        else:
            return
        dst_rel = res.resolve(dst)
        dst_is_dir = dst.endswith("/") or (dst_rel is not None and isdir(res.abs_of(dst_rel))) \
            or (dst_rel is None and target_dir is not None)
        for s in srcs:
            src_rel = res.resolve(s)
            if src_rel is None:
                continue
            if cmd == "mv":
                ops.deletes.add(src_rel)
            else:
                ops.reads.add(src_rel)
            if dst_is_dir:
                # mv a.txt dir/  → dir/a.txt
                dst_dir_rel = res.resolve(dst.rstrip("/")) if dst.endswith("/") else dst_rel
                if dst_dir_rel is not None:
                    ops.writes.add(str(PurePosixPath(dst_dir_rel) / PurePosixPath(src_rel).name))
                elif dst.rstrip("/") in (".", ""):
                    ops.writes.add(PurePosixPath(src_rel).name)
            elif dst_rel is not None:
                ops.writes.add(dst_rel)
        return

    if cmd == "dd":
        for a in args:
            if a.startswith("of="):
                add("writes", a[3:])
            elif a.startswith("if="):
                add("reads", a[3:])
        return
    # Everything else (git, python, npm, curl, …): only redirects were recorded.


# ═══════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════

def classify_bash_command(command: str, cwd: str, *,
                          isdir: Callable[[str], bool] = os.path.isdir) -> BashFileOps:
    """Extract candidate file operations from a Bash command string.

    Args:
        command: The Bash tool's `command` input, verbatim.
        cwd: The session's working directory — the project root every
            returned path is relative to and confined within.
        isdir: Predicate used only to decide `mv`/`cp` destination-directory
            semantics (injectable for tests).
    """
    ops = BashFileOps()
    if not command or not cwd:
        return ops
    res = _Resolver(cwd)
    for seg in _split_segments(_strip_heredocs(command)):
        if seg == "(":
            res.push()
            continue
        if seg == ")":
            res.pop()
            continue
        tokens = _tokenize(seg)
        if tokens:
            _classify_segment(tokens, res, ops, isdir)
        if len(ops.all_paths()) > MAX_PATHS_PER_COMMAND:
            break
    # An in-place edit reads then writes — it's a write. A moved file is gone.
    ops.reads -= ops.writes
    ops.reads -= ops.deletes
    ops.writes -= ops.deletes
    _cap(ops)
    return ops


def _cap(ops: BashFileOps) -> None:
    for name in ("writes", "deletes", "reads"):
        s = getattr(ops, name)
        if len(s) > MAX_PATHS_PER_COMMAND:
            setattr(ops, name, set(sorted(s)[:MAX_PATHS_PER_COMMAND]))


@dataclass
class VerifiedOps:
    """Filesystem-confirmed subset of a BashFileOps."""
    created: set[str] = field(default_factory=set)
    modified: set[str] = field(default_factory=set)
    deleted: set[str] = field(default_factory=set)
    reads: set[str] = field(default_factory=set)

    @property
    def is_empty(self) -> bool:
        return not (self.created or self.modified or self.deleted or self.reads)


def snapshot_existing(ops: BashFileOps, cwd: str) -> set[str]:
    """Which of the candidate write paths already exist — taken BEFORE (or
    as close as possible to) execution so a later `verify_ops` can tell a
    created file from a modified one. Best-effort: if the frame arrives
    after the command ran, a new file reads as pre-existing and is recorded
    as 'modified', which is the safe direction."""
    root = Path(os.path.expanduser(cwd))
    return {p for p in ops.writes if (root / p).is_file()}


def verify_ops(ops: BashFileOps, cwd: str, *, existed_before: Iterable[str] = (),
               failed: bool = False) -> VerifiedOps:
    """Confirm candidates against the filesystem after the command ran.

    A failed command (`is_error` tool result) credits NO writes/deletes —
    `sed -i` on a missing file, a `tee` into a read-only dir, etc. Reads
    still count when the file exists (the command likely read it before
    failing later in a pipeline), which is what the quick switcher wants.
    """
    root = Path(os.path.expanduser(cwd))
    before = set(existed_before)
    out = VerifiedOps()
    if not failed:
        for p in ops.writes:
            if (root / p).is_file():
                (out.modified if p in before else out.created).add(p)
        for p in ops.deletes:
            if not (root / p).exists():
                out.deleted.add(p)
    for p in ops.reads:
        if (root / p).is_file():
            out.reads.add(p)
    return out
