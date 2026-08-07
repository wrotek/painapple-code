"""Container run-mode machinery (Docker/Podman).

Docker is not a separate command group — it's *how* a deployment runs.
This package holds everything the unified CLI needs to run a workspace
or a profile inside a container:

* ``runtime``   — docker/podman resolution + invocation helpers
* ``config``    — DockerSettings: the docker-mode key model + validation
* ``container`` — run/stop/logs/shell/password/extract/pull bodies
* ``claude_seed`` — .claude credential/onboarding seeding for sandboxes

Entry points: ``painapple --in-docker`` (cwd sandbox), docker-mode
profiles (``painapple setup NAME`` → ``painapple start NAME``), and the
management verbs (``painapple logs/password/shell/extract NAME``).
"""
