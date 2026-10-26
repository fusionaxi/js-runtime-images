# FusionAxi Bun + Node.js

Bun tooling and the official Node.js runtime in one container image. Use Bun to install dependencies, run TypeScript, and build your application, then run the resulting JavaScript with Node.js.

- Image: `fusionaxi/bun-node`
- Architectures: `linux/amd64` and `linux/arm64`
- Default variant: `slim`
- Default user: `bun` (UID/GID `1001:1001`)
- Working directory: `/app`

[Source code](https://github.com/fusionaxi/js-runtime-images) · [Dockerfile](https://github.com/fusionaxi/js-runtime-images/blob/main/docker/bun-node/Dockerfile) · [Available tags](https://hub.docker.com/r/fusionaxi/bun-node/tags) · [Report an issue](https://github.com/fusionaxi/js-runtime-images/issues)

## Quick start

```sh
docker pull fusionaxi/bun-node:latest
docker run --rm fusionaxi/bun-node:latest bun --version
docker run --rm fusionaxi/bun-node:latest node --version
```

Run a local TypeScript file with Bun:

```sh
docker run --rm -v "$PWD:/app" fusionaxi/bun-node:slim ./main.ts
```

Install project dependencies with Bun:

```sh
docker run --rm -v "$PWD:/app" fusionaxi/bun-node:slim bun install
```

Bind-mounted directories must allow UID `1001` to write when installing dependencies or producing build output.

## Variants

| Variant      | Runtime base                          | Included tooling                                 |
| ------------ | ------------------------------------- | ------------------------------------------------ |
| `slim`       | Official Node.js Debian Bookworm slim | Bun, `bunx`, Node.js, Tini                       |
| `debian`     | Official Node.js Debian Bookworm      | Bun, `bunx`, Node.js, Tini                       |
| `alpine`     | Official Node.js Alpine               | Bun's musl build, `bunx`, Node.js, Tini          |
| `alpine-git` | Official Node.js Alpine               | Alpine tooling plus Git, Git LFS, OpenSSH client |

The `alpine-git` variant initializes Git LFS at the system level. Choose a Debian variant when your application requires a glibc-based environment.

## Tags

| Tag pattern                              | Meaning                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `latest`                                 | Newest supported Node.js LTS, `slim` variant                 |
| `<variant>`                              | Newest supported Node.js LTS with the selected variant       |
| `<node-major>-<variant>`                 | Latest selected patch in a supported Node.js major           |
| `<node-version>-<variant>`               | Exact Node.js version with the release's selected stable Bun |
| `<bun-version>-<node-version>-<variant>` | Exact Bun and Node.js versions with the selected variant     |

Version placeholders use numeric versions without a leading `v`. Releases select the latest stable Bun and the newest Node.js patch in each supported Current, Active LTS, and Maintenance LTS major. Bun canary and prereleases are excluded.

Versioned tags can be rebuilt to refresh their operating system packages. Pin a published digest (`fusionaxi/bun-node@sha256:...`) when you need an immutable reference. Consult the available tags page for published versions.

## Build with Bun, run with Node.js

For a project with `main.ts`, use this Dockerfile:

```dockerfile
FROM fusionaxi/bun-node:slim

COPY --chown=bun:bun main.ts /app/main.ts
RUN bun build main.ts --target=node --outdir=dist

CMD ["node", "dist/main.js"]
```

```sh
docker build -t my-bun-node-app .
docker run --rm my-bun-node-app
```

For projects with dependencies, copy `package.json` and `bun.lock`, run `bun install --frozen-lockfile`, and then copy and build the application source. See the [Node.js example](https://github.com/fusionaxi/js-runtime-images/tree/main/examples/node).

## Container behavior

The default command is `bun --help`. Explicit executable commands such as `bun`, `node`, and `sh` run directly. Flag-only arguments and non-executable script paths are passed to Bun, so `docker run --rm fusionaxi/bun-node:slim --version` prints the Bun version.

Tini runs as the init process, and the entrypoint executes the selected command to preserve signals and exit codes. Container startup makes no telemetry requests.

Global Bun packages install under `/home/bun/.bun`, with executables in `/home/bun/.bun/bin` on `PATH`. The application directory and Bun installation directory are writable by `bun`. Bun's runtime transpiler cache is disabled through `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.

Use `COPY --chown=bun:bun` for application files. When adding system packages in a derived image, switch to `USER root` for installation and back to `USER bun` afterward.

## Updates and verification

The [release workflow](https://github.com/fusionaxi/js-runtime-images/blob/main/.github/workflows/release.yml) runs daily at 00:00 UTC and can be triggered manually from `main`. Each release rebuilds every configured combination and publishes versioned images with SBOM and provenance attestations.

Published manifest digests are smoke-tested on both architectures, including runtime versions, TypeScript execution, dependency installation, writable directories, exit codes, and signal forwarding. Floating tags advance only after every build in the release passes. A failed release can leave versioned images published without advancing floating tags. Alias updates occur individually on Docker Hub.

## License and related image

The image definitions and repository tooling are [MIT licensed](https://github.com/fusionaxi/js-runtime-images/blob/main/LICENSE). Bundled runtimes and operating system packages retain their respective licenses.

For Bun tooling paired with Deno, see [fusionaxi/bun-deno](https://hub.docker.com/r/fusionaxi/bun-deno).
