## Personalized image — bring your own Dockerfile

This example shows the **Dockerfile flavor** of personalization. If your
project already has a `Dockerfile` (for prod, CI, or anything else), you
can point painapple-docker.sh at it and have its instructions appended
to the standard painapple-code base — without touching either file.

If your project has a `devcontainer.json` instead, see
[../personalize/](../personalize/) for the features-based flow. The two
are mutually exclusive (a build uses one or the other, not both).

### How it works

`painapple-docker.sh build --dockerfile PATH` runs in two stages:

1. **Stage 1.** Build the standard `painapple-code:base` image from this
   repo's own Dockerfile (no modifications).
2. **Stage 2.** Synthesize a wrapper Dockerfile that:
   - replaces your **final** `FROM` line with `FROM painapple-code:base`
     (earlier `FROM` lines in a multi-stage build are kept verbatim, so
     `COPY --from=builder` still works)
   - strips `CMD` and `ENTRYPOINT` instructions so the server's
     entrypoint isn't clobbered
   - leaves everything else (`RUN`, `COPY`, `ENV`, `ARG`, `USER`,
     `WORKDIR`, `LABEL`, `EXPOSE`, …) untouched
3. Build that wrapper against **your project directory** as the build
   context, so any `COPY src/ /app` paths inside your Dockerfile resolve
   the way you'd expect.

The final image is tagged as your normal `$IMAGE` (default
`painapple-code:latest`). Switching back is just
`./painapple-docker.sh build --no-dockerfile`.

### Usage

```bash
# One-shot — doesn't change saved config.
./painapple-docker.sh build --dockerfile ./examples/personalize-dockerfile

# Save it so subsequent builds personalize automatically.
./painapple-docker.sh config set DOCKERFILE_PATH=./examples/personalize-dockerfile
./painapple-docker.sh build

# Verify the tools landed in the image:
./painapple-docker.sh up -d
./painapple-docker.sh shell -c 'jq --version && rg --version && fd --version'
```

The `DOCKERFILE_PATH` value can be either a `Dockerfile` directly or a
directory containing one. Alternate filenames (`Dockerfile.dev` etc.)
need to be passed as an explicit file path.

### What gets rewritten vs preserved

| Instruction | Behavior |
|-------------|----------|
| Final `FROM` line | rewritten to `FROM painapple-code:base` (preserves any `AS <alias>` suffix) |
| Earlier `FROM` lines | preserved (multi-stage builders keep working) |
| `CMD` | stripped (server entrypoint stays intact) |
| `ENTRYPOINT` | stripped (same reason) |
| `RUN`, `COPY`, `ADD` | preserved verbatim |
| `ENV`, `ARG`, `LABEL` | preserved |
| `USER`, `WORKDIR`, `EXPOSE` | preserved |

If you need to swap out the server entrypoint too, do it in
`painapple-docker.sh up` arguments — not the Dockerfile.

### When to use this vs `--devcontainer`

| You have… | Use |
|-----------|-----|
| A `devcontainer.json` with `"features"` | [`--devcontainer`](../personalize/) — one-liners like Go 1.22 / AWS CLI / Terraform via OCI features. |
| A `Dockerfile` for your project | `--dockerfile` (this example) — drops your exact install steps onto the base. |
| Neither | Use the standard build (no flag). |
| Both | Pick one — they extend the same base; only one is in effect per build. |

### Tips

- Anything you'd normally do in a project Dockerfile works here — apt /
  brew / curl-install, copying configs, setting envs, switching users.
  Just remember the **base** is Debian (whatever painapple-code's own
  Dockerfile uses) regardless of what you put in your file's `FROM`.
- The wrapper Dockerfile lives in a `mktemp` directory; the path is
  printed if the build fails so you can inspect and rerun manually.
- Build context = the directory containing your `Dockerfile`. Pass the
  project root and `COPY src /app`-style instructions Just Work.
