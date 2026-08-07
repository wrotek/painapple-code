# Example: pAInapple Code in any project's devcontainer

Drop `devcontainer.json` (sibling file) into the `.devcontainer/` directory
of any project, commit, and the next Codespace you open on that project
will boot with pAInapple Code already installed and serving on port 8765.

## Step-by-step

1. **Copy** `devcontainer.json` from this directory into your project at
   `.devcontainer/devcontainer.json`. If the project already has one, merge
   the `features`, `forwardPorts`, and `secrets` keys.

2. **Set the API key as a Codespaces secret.**
   - GitHub → Settings → Codespaces → New secret → `ANTHROPIC_API_KEY`.
   - Or per-repo: repo Settings → Secrets → Codespaces.

3. **Open the codespace.** First boot takes ~4-6 minutes (Feature install
   pulls Python deps + the claude CLI). Subsequent restarts are fast.

4. **Get the URL.** The Codespaces "Ports" tab shows port 8765 forwarded.
   Hover → copy URL → append `?tkn=<password>` from
   `/tmp/painapple-code.log`. The `postAttachCommand` in the example
   prints the bootstrap URL line for you when you open a terminal.

5. **Open it on your iPad.** First visit installs the PWA; subsequent
   visits stay logged in via cookie.

## Variants

### Different base image

The Feature works on top of any Debian/Ubuntu-based dev container image —
the official `mcr.microsoft.com/devcontainers/...` images, your team's
custom image, anything with apt. Swap the `image` line.

### Pin a specific version

```json
"features": {
    "ghcr.io/wrotek/painapple-code/painapple-code:1": {
        "version": "v1.0.0"
    }
}
```

`version` accepts any git ref — branch, tag, or commit SHA.

### Multiple codespaces on the same iPad

Give each one a distinct label and accent so you can tell them apart at a
glance:

```json
"painapple-code": {
    "instanceName": "PROJ-A",
    "accent": "purple"
}
```

### Use OAuth instead of an API key

Skip the `secrets` block. After the codespace boots, open a terminal and
run `claude login`. The OAuth credential persists for the life of the
codespace.

### Multiple workspaces in one bridge

By default the launcher uses `/workspaces` as the workspace root and the
Painapple welcome screen lists every project directory under it. To pin a
single repo, set `PAINAPPLE_WORKSPACE` before the launcher runs:

```json
"containerEnv": {
    "PAINAPPLE_WORKSPACE": "/workspaces/my-repo"
}
```
