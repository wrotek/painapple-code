## Personalized image — layer your dev tools onto painapple-code

This example shows the **reverse** of the [Dev Container Feature](../devcontainer/)
flow. Instead of dropping painapple-code into your project's
devcontainer.json, you point painapple-code at a devcontainer.json full of
tools you want, and the container image gets baked with all of them on top
of the standard painapple-code base.

End result: a single `painapple-code:latest` image that has Go, AWS CLI,
Terraform (or whatever you list) pre-installed — useful when your remote
agent needs language toolchains, language servers, or vendor CLIs not in
the slim default image.

### How it works

`painapple-docker.sh build --devcontainer PATH` runs in two stages:

1. **Stage 1.** Build the standard `painapple-code:base` image from the
   project's own Dockerfile (no modifications).
2. **Stage 2.** Hand a wrapper `.devcontainer/devcontainer.json` to
   `@devcontainers/cli` — `image:` set to `painapple-code:base`, plus the
   `features` you supplied — and let the official Dev Containers tooling
   resolve each feature from its OCI registry and layer it in. The final
   image is tagged as your normal `$IMAGE` (default `painapple-code:latest`).

The Dockerfile is never edited. Switching back is just
`./painapple-docker.sh build --no-devcontainer`.

### Usage

```bash
# One-shot override — doesn't change saved config.
./painapple-docker.sh build --devcontainer ./examples/personalize

# Save it so subsequent builds personalize automatically.
./painapple-docker.sh config set DEVCONTAINER_PATH=./examples/personalize
./painapple-docker.sh build

# Verify the tools landed in the image:
./painapple-docker.sh up -d
./painapple-docker.sh shell -c 'go version && aws --version && terraform version'
```

The `DEVCONTAINER_PATH` value can be either a `devcontainer.json` file
directly or a directory containing `devcontainer.json` or
`.devcontainer/devcontainer.json`.

### What gets carried over

Only the fields that affect what's baked into the image:

| Field | Carried over? | Why |
|-------|---------------|-----|
| `features` | yes | the main point |
| `containerEnv` | yes | env vars set at image level |
| `remoteEnv` | yes | env vars set on attach (CLI honors them at build) |
| `remoteUser` | yes | features sometimes write to that user's home |
| `image` / `build` / `dockerFile` | no | replaced by `painapple-code:base` |
| `forwardPorts` / `portsAttributes` | no | runtime concern; painapple-docker.sh handles ports |
| `mounts` / `runArgs` | no | runtime concern |
| `customizations` | no | IDE/editor-specific, irrelevant for a baked image |
| `postCreateCommand` / `postAttachCommand` / etc. | no | the server has its own entrypoint |

### Requirements

- **Node.js + npx on the host.** `@devcontainers/cli` runs via `npx -y`,
  so any reasonably recent Node (18+) on the host is enough — no global
  install needed.
- **Docker** (primary) or **Podman**. With Podman, the wrapper passes
  `--docker-path=podman` and references the base image as
  `localhost/painapple-code:base` so the Dev Containers CLI uses the local
  copy instead of trying to pull from a registry.

### Tips

- Browse available features at
  [containers.dev/features](https://containers.dev/features). Anything
  published as an OCI feature works.
- Local feature paths (e.g. `"./my-feature": {}`) are resolved against
  the directory of your devcontainer.json, so they keep pointing at your
  checkout even though the build happens in a temp dir.
- If a feature install fails, the wrapper devcontainer.json is left at
  the `tmpdir` path the error message prints — you can inspect, hand-edit,
  and rerun the same `devcontainer build` invocation directly to iterate.
