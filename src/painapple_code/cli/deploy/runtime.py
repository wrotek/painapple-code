"""Container runtime resolution (docker/podman) and invocation helpers."""

import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from painapple_code.cli.ui import die


# Labels a painapple image carries about the user it runs as. Images
# built before the uid-alignment work have none of them — every reader
# below falls back to probing, so pulled older tags still work.
APP_UID_LABEL = "io.painapple.app-uid"
APP_GID_LABEL = "io.painapple.app-gid"
ADAPT_LABEL = "io.painapple.uid-adapt"


def _responds(binary):
    """Does this runtime actually answer? A `docker` CLI whose daemon
    socket we can't reach is on PATH but useless — picking it means the
    real failure surfaces much later as a nonsense message ("Image not
    found locally", because `image inspect` silently returned nothing).
    """
    try:
        return subprocess.run([binary, "info"], capture_output=True,
                              timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def auto_detect():
    """Prefer docker (more common default); podman as fallback — but
    only pick a runtime that's actually reachable, so a docker CLI with
    no daemon behind it doesn't shadow a working podman."""
    present = [(name, path) for name in ("docker", "podman")
               if (path := shutil.which(name))]
    if not present:
        # No RUNTIME env var here — that's the build wrapper's lever
        # (painapple-docker.sh). The CLI's runtime lives in config.
        die("Neither docker nor podman found in PATH.",
            "Install one, then point painapple at it:\n"
            "  painapple setup                        (global runtime default)\n"
            "  painapple profile set NAME RUNTIME=…   (one deployment — also "
            "takes an absolute path to a custom binary)")
    for name, path in present:
        if _responds(path):
            return name
    names = ", ".join(name for name, _ in present)
    die(f"Found {names} on PATH, but neither answers — `{present[0][0]} info` failed.",
        "Start the service (`systemctl --user start docker`/`podman.socket`), "
        "check you're in the `docker` group, or run `painapple setup` to point "
        "at the runtime you actually use.")


def detect_runtimes():
    """[(name, path, version)] for every container runtime found on
    PATH — what the setup wizard lists as concrete choices."""
    found = []
    for name in ("docker", "podman"):
        path = shutil.which(name)
        if not path:
            continue
        version = ""
        try:
            out = subprocess.run([path, "--version"], capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=5).stdout.strip()
            m = re.search(r"version\s+v?([0-9][\w.-]*)", out)
            version = m.group(1).rstrip(",") if m else out
        except (OSError, subprocess.TimeoutExpired):
            pass
        found.append((name, path, version))
    return found


class Runtime:
    """One resolved runtime: binary (name or explicit path) + persistent
    global flags.

    Every invocation goes through here so RUNTIME_FLAGS injection applies
    uniformly — otherwise `run` would see the flags but `ps`/`exec`
    would silently use the default storage driver and miss images.
    """

    def __init__(self, cfg):
        self.binary = cfg.runtime or auto_detect()
        # Display/behavior name: an explicit /path/to/podman still counts
        # as podman for --userns/SELinux handling.
        self.name = Path(self.binary).name
        self.flags = shlex.split(cfg.runtime_flags) if cfg.runtime_flags else []
        self._image_ids = {}   # image → (uid, gid), memoized probe results

    def argv(self, *args):
        return [self.binary, *self.flags, *args]

    def run(self, *args, **kwargs):
        return subprocess.run(self.argv(*args), **kwargs)

    def output(self, *args):
        """Stdout of a runtime call, or '' on any failure."""
        try:
            proc = self.run(*args, capture_output=True, text=True, encoding="utf-8", errors="replace")
            return proc.stdout if proc.returncode == 0 else ""
        except OSError:
            return ""

    def ok(self, *args):
        try:
            return self.run(*args, capture_output=True).returncode == 0
        except OSError:
            return False

    def exec_interactive(self, *args):
        """Replace this process with the runtime call — full TTY handoff,
        native Ctrl-C, no Python in the signal path."""
        argv = self.argv(*args)
        os.execvp(argv[0], argv)

    # ── Queries ─────────────────────────────────────────────────────────

    def image_exists(self, image):
        return self.ok("image", "inspect", image)

    def volume_exists(self, volume):
        return self.ok("volume", "inspect", volume)

    def container_running(self, name):
        names = self.output("ps", "--format", "{{.Names}}").splitlines()
        return name in names

    def container_exists(self, name):
        names = self.output("ps", "-a", "--format", "{{.Names}}").splitlines()
        return name in names

    def container_status(self, name):
        for line in self.output("ps", "--format", "{{.Names}}\t{{.Status}}").splitlines():
            cname, _, status = line.partition("\t")
            if cname == name:
                return status
        return None

    def selinux_enforcing(self):
        """Podman bind mounts need :Z under SELinux."""
        if self.name != "podman" or not shutil.which("selinuxenabled"):
            return False
        try:
            return subprocess.run(["selinuxenabled"], capture_output=True).returncode == 0
        except OSError:
            return False

    def responds(self):
        """Runtime reachable? (Explicitly configured binaries skip
        auto_detect's check, so run_container asks again.)"""
        return _responds(self.binary)

    # ── Image identity ──────────────────────────────────────────────────

    def label(self, image, name):
        """One image label, '' when absent. Docker renders a missing key
        as '<no value>', podman as an empty string — normalize both."""
        raw = self.output("image", "inspect", image, "--format",
                          '{{index .Config.Labels "%s"}}' % name).strip()
        return "" if raw in ("<no value>", "<nil>") else raw

    def image_adapts_uid(self, image):
        """Does the image's entrypoint re-stamp its user to match host
        ownership and drop privileges? (Images predating that: no.)"""
        return self.label(image, ADAPT_LABEL) == "1"

    def image_user_ids(self, image):
        """(uid, gid) of the image's `app` user.

        Labels first — an adapting image starts as root, so its
        Config.User says nothing about the uid the bridge ends up
        running as. Falls back to one throwaway container for images
        built before the labels existed.
        """
        if image in self._image_ids:
            return self._image_ids[image]

        uid, gid = self.label(image, APP_UID_LABEL), self.label(image, APP_GID_LABEL)
        if uid.isdigit() and gid.isdigit():
            ids = (int(uid), int(gid))
        else:
            out = self.output("run", "--rm", "--entrypoint", "", "--network", "none",
                              image, "sh", "-c", "id -u; id -g").split()
            ids = ((int(out[0]), int(out[1]))
                   if len(out) >= 2 and all(t.isdigit() for t in out[:2]) else (None, None))
        self._image_ids[image] = ids
        return ids

    def supports_userns_map(self):
        """podman ≥ 4.3 understands `keep-id:uid=…,gid=…` (the flag that
        lands the host user ON the image's app uid). Unparsable version
        → assume yes; podman 4.3 shipped in 2022 and the failure is a
        loud one-liner from podman itself, not a silent misbehavior."""
        if self.name != "podman":
            return False
        raw = self.output("version", "--format", "{{.Client.Version}}").strip()
        m = re.match(r"(\d+)\.(\d+)", raw)
        return (int(m.group(1)), int(m.group(2))) >= (4, 3) if m else True

    # ── Volume ownership ────────────────────────────────────────────────

    def chown_volume(self, image, volume, uid, gid, extra_args=()):
        """Make a named volume owned by the uid the container will run
        as — as root inside the same user namespace the real run uses,
        so the mapping matches.

        Testing the top-level dir is NOT enough: a volume seeded from the
        image has its root owned by `app` while everything a previous
        container wrote under it (/data/logs/server.log, the classic) is
        owned by that container's uid instead. `-print -quit` stops at
        the first offender, so this is one cheap walk when there's
        nothing to fix — `chown -R` over a populated data home (DuckDB
        plus every session log) is not something to redo on every start.
        """
        script = (f'[ -n "$(find /vol \\( ! -uid {uid} -o ! -gid {gid} \\) '
                  f'-print -quit 2>/dev/null)" ] && chown -R {uid}:{gid} /vol; :')
        return self.ok("run", "--rm", "--user", "0", "--entrypoint", "",
                       *extra_args, "-v", f"{volume}:/vol", image, "sh", "-c", script)
