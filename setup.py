"""Build-time hook: bundle the frontend when building from source.

Everything else about packaging lives in pyproject.toml. This file exists
only to hang a `build_py` override off setuptools, because installing from
source — `pip install .`, `pip install git+ssh://…`, `pipx install git+…`,
or an sdist — otherwise produces an install with no frontend bundle. The
bundle is deliberately not committed (it changes on every frontend edit),
so unless something builds it during the install, a source install silently
serves ~190 loose modules per cold load.

Three properties this must preserve:

* **`pip install` still needs zero Node.** Without npm the bundle is skipped
  with a note, never an error — an unbundled install is a fully working app,
  just a slower cold load, so failing the install would be a bad trade.
* **Editable installs stay unbundled.** `pip install -e .` is the dev
  workflow; a bundle there would shadow the loose modules and break the
  edit→refresh loop. setuptools sets `editable_mode` on the command, which
  is exactly the signal we want.
* **A failed bundle never breaks the build.** build-frontend.sh installs
  atomically, so a failure leaves no partial bundle to serve.

`PAINAPPLE_SKIP_BUNDLE=1` opts out explicitly.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py

ROOT = Path(__file__).parent.resolve()


def _note(msg: str) -> None:
    print(f"[painapple-code] {msg}", file=sys.stderr)


class BuildPyWithFrontend(build_py):
    def run(self):
        self._drop_stale_bundle()
        self._build_frontend()
        super().run()

    def _drop_stale_bundle(self) -> None:
        """Clear any previously staged bundle out of the build dir.

        build_py copies package data forward but never removes what no longer
        exists in the source tree, so a repeat local build happily packages an
        artifact from an earlier run — that is how a 5.8 MB sourcemap kept
        shipping after source maps were made opt-in. CI always starts from a
        fresh checkout, so this only bites maintainers building repeatedly.
        """
        staged = Path(self.build_lib) / "painapple_code" / "static" / "dist"
        if staged.exists():
            shutil.rmtree(staged, ignore_errors=True)

    def _build_frontend(self) -> None:
        if os.environ.get("PAINAPPLE_SKIP_BUNDLE"):
            _note("PAINAPPLE_SKIP_BUNDLE set — serving loose modules")
            return
        # Editable install: leave the tree alone so edit->refresh works.
        if getattr(self, "editable_mode", False):
            return

        script = ROOT / "build-frontend.sh"
        if not script.is_file():
            return  # building from something without the bundler (not an sdist)

        if not shutil.which("npm"):
            _note(
                "npm not found — skipping the frontend bundle. The app works "
                "fine; cold page loads just fetch ~190 modules instead of one. "
                "Install Node and reinstall to get the bundle."
            )
            return

        _note("building frontend bundle...")
        try:
            subprocess.run(["bash", str(script)], cwd=ROOT, check=True)
        except (subprocess.CalledProcessError, OSError) as exc:
            # Never fatal: the bundle is an optimisation over a default that
            # already works, and build-frontend.sh leaves no partial output.
            _note(f"frontend bundle failed ({exc}) — serving loose modules")


setup(cmdclass={"build_py": BuildPyWithFrontend})
