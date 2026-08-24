# Example: extra tooling layered onto a personalized painapple-code image
# via a plain Dockerfile (no devcontainer.json needed).
#
# Point painapple-docker.sh at this file and `build` will:
#   1. Build painapple-code:base from this repo's Dockerfile (untouched).
#   2. Append the instructions below onto painapple-code:base. The FROM
#      line is rewritten by the wrapper to point at painapple-code:base;
#      CMD/ENTRYPOINT (if any) are stripped so the server's entrypoint
#      survives.
#
# Usage:
#   ./painapple-docker.sh build --dockerfile examples/personalize-dockerfile
#
# Or persist it:
#   ./painapple-docker.sh config set DOCKERFILE_PATH=examples/personalize-dockerfile
#   ./painapple-docker.sh build
#
# The FROM line below is a placeholder — it gets rewritten regardless of
# what you put here. We use `painapple-code:base` so this file still
# builds as a plain `docker build` if you ever want to (the wrapper just
# substitutes the same name).
FROM painapple-code:base

# Become root to install packages. Stay there: the base image's
# entrypoint runs as root on purpose (it re-stamps the `app` user to
# match the ownership of your mounts) and drops privileges itself before
# the server starts. Ending this file with `USER app` would take that
# away and bring back "Permission denied" on any host whose UID isn't
# the one baked into the image.
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        jq \
        ripgrep \
        fd-find \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# fd ships as `fdfind` on Debian; alias to `fd` for muscle memory.
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# No trailing `USER app` — see the note above. The server still runs as
# `app`; the entrypoint drops to it.
