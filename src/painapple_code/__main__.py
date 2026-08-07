"""Entry point for ``python -m painapple_code`` and the ``painapple``
console script (``painapple-code`` is kept as a compatibility alias).

Delegates to :func:`painapple_code.cli.main`, which dispatches known
subcommands (``docker``, ``serve``) and falls through to the server's
flat argument parser for everything else — so bare invocations keep
working exactly as before the CLI grew subcommands.
"""

import sys

from painapple_code.cli import main

if __name__ == "__main__":
    # Propagate the handler's return code (the console script's setuptools
    # wrapper already does sys.exit(main()) — python -m must match, or
    # `docker config set` failures look successful to callers).
    sys.exit(main())
