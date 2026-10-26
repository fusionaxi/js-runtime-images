# FusionAxi Bun + Deno

Bun tooling and the official Deno runtime in one container image. Use Bun for package management, TypeScript tooling, and build steps, then run your application with Deno.

- Image: `fusionaxi/bun-deno`
- Architectures: `linux/amd64` and `linux/arm64`
- Default variant: `debian`
- Default user: `bun` (UID/GID `1001:1001`)
- Working directory: `/app`

[Source code](https://github.com/fusionaxi/js-runtime-images) · [Dockerfile](https://github.com/fusionaxi/js-runtime-images/blob/main/docker/bun-deno/Dockerfile) · [Available tags](https://hub.docker.com/r/fusionaxi/bun-deno/tags) · [Report an issue](https://github.com/fusionaxi/js-runtime-images/issues)

## Quick start

```sh
docker pull fusionaxi/bun-deno:latest
docker run --rm fusionaxi/bun-deno:latest bun --version
docker run --rm fusionaxi/bun-deno:latest deno --version
```

Run a local TypeScript file with Deno:

```sh
docker run --rm -v "$PWD:/app" fusionaxi/bun-deno:debian deno run ./main.ts
```

For an application that needs network access, grant Deno that permission explicitly:

```sh
docker run --rm -p 8000:8000 -v "$PWD:/app" \
  fusionaxi/bun-deno:debian deno run --allow-net ./main.ts
```

The application must listen on port `8000` on a container-accessible address such as `0.0.0.0` for this port mapping to work. Add other Deno permissions as required by your application.

## Variants

| Variant  | Runtime base         | Included tooling                     |
| -------- | -------------------- | ------------------------------------ |
| `debian` | Official Deno Debian | Bun, `bunx`, Deno, Tini              |
| `alpine` | Official Deno Alpine | Bun's musl build, `bunx`, Deno, Tini |

The Alpine variant preserves the official Deno image's glibc compatibility setup and adds Bun's musl binary. The Debian variant uses Bun's glibc binary.

## Tags

| Tag pattern                              | Meaning                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `latest`                                 | Latest stable Deno, `debian` variant                      |
| `<variant>`                              | Latest stable Deno with the selected variant              |
| `<deno-major>-<variant>`                 | Selected stable Deno release in that major                |
| `<deno-version>-<variant>`               | Exact Deno version with the release's selected stable Bun |
| `<bun-version>-<deno-version>-<variant>` | Exact Bun and Deno versions with the selected variant     |

Version placeholders use numeric versions without a leading `v`. Releases select the latest stable Bun and latest stable Deno. Bun canary and prereleases are excluded. The release plan tracks one stable Deno release; it does not maintain every historical Deno major.

Versioned tags can be rebuilt to refresh their operating system packages. Pin a published digest (`fusionaxi/bun-deno@sha256:...`) when you need an immutable reference. Consult the available tags page for published versions.

## Use in your Dockerfile

For a project with a dependency-free `main.ts`, use this Dockerfile:

```dockerfile
FROM fusionaxi/bun-deno:debian

COPY --chown=bun:bun main.ts /app/main.ts

CMD ["deno", "run", "main.ts"]
```

```sh
docker build -t my-bun-deno-app .
docker run --rm my-bun-deno-app
```

Bun is available during image builds for dependency installation and TypeScript build scripts. Configure Deno dependency caching for your application's imports. See the [Deno example](https://github.com/fusionaxi/js-runtime-images/tree/main/examples/deno).

## Container behavior

The default command is `bun --help`. Explicit executable commands such as `bun`, `deno`, and `sh` run directly. Flag-only arguments and non-executable script paths are passed to Bun. To select Deno, specify it explicitly: `deno run ./main.ts`.

Tini runs as the init process, and the entrypoint executes the selected command to preserve signals and exit codes. Container startup makes no telemetry requests.

| Setting                | Value                   |
| ---------------------- | ----------------------- |
| `BUN_INSTALL`          | `/home/bun/.bun`        |
| `BUN_INSTALL_BIN`      | `/home/bun/.bun/bin`    |
| `DENO_DIR`             | `/home/bun/.cache/deno` |
| `DENO_INSTALL_ROOT`    | `/home/bun/.deno`       |
| `DENO_NO_UPDATE_CHECK` | `1`                     |
| `DENO_NO_PROMPT`       | `1`                     |

Bun and Deno installation directories and the Deno cache are writable by `bun`. `/home/bun/.bun/bin` and `/home/bun/.deno/bin` are on `PATH`. Bun's runtime transpiler cache is disabled through `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. Deno update checks and interactive permission prompts are disabled; pass required permissions on the command line.

Use `COPY --chown=bun:bun` for application files. Bind-mounted directories must allow UID `1001` to write if the application needs to modify them. When adding system packages in a derived image, switch to `USER root` for installation and back to `USER bun` afterward.

## Updates and verification

The [release workflow](https://github.com/fusionaxi/js-runtime-images/blob/main/.github/workflows/release.yml) runs daily at 00:00 UTC and can be triggered manually from `main`. Each release rebuilds every configured combination and publishes versioned images with SBOM and provenance attestations.

Published manifest digests are smoke-tested on both architectures, including runtime versions, TypeScript execution, dependency installation, writable directories, exit codes, and signal forwarding. Floating tags advance only after every build in the release passes. A failed release can leave versioned images published without advancing floating tags. Alias updates occur individually on Docker Hub.

## License and related image

The image definitions and repository tooling are [MIT licensed](https://github.com/fusionaxi/js-runtime-images/blob/main/LICENSE). Bundled runtimes and operating system packages retain their respective licenses.

For Bun tooling paired with Node.js, see [fusionaxi/bun-node](https://hub.docker.com/r/fusionaxi/bun-node).
