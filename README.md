# FusionAxi JavaScript Runtime Images

Container images pairing Bun's package manager and TypeScript tooling with a second JavaScript runtime. The repository tooling runs entirely on Bun and TypeScript.

| Purpose       | Docker Hub image     | Variants                                 |
| ------------- | -------------------- | ---------------------------------------- |
| Bun + Node.js | `fusionaxi/bun-node` | `alpine`, `alpine-git`, `debian`, `slim` |
| Bun + Deno    | `fusionaxi/bun-deno` | `alpine`, `debian`                       |

The private tooling package is `@fusionaxi/js-runtime-images`. The project repository is [fusionaxi/js-runtime-images](https://github.com/fusionaxi/js-runtime-images). Image source labels use the repository URL configured in `runtime-images.json`.

Both images support `linux/amd64` and `linux/arm64`. They use official runtime images, run as user `bun` (UID/GID 1001), provide writable package caches, and forward process signals through Tini. Container startup makes no telemetry requests.

## Usage

These references become available after the first successful FusionAxi release:

```sh
docker run --rm fusionaxi/bun-node:latest bun --version
docker run --rm fusionaxi/bun-node:latest node --version
docker run --rm fusionaxi/bun-deno:latest deno --version
```

Bun is the default command handler. An explicit `node`, `deno`, `bun`, or shell command runs directly. A flag-only command or non-executable script path runs through Bun:

```sh
docker run --rm fusionaxi/bun-node:latest --version
docker run --rm -v "$PWD:/app" fusionaxi/bun-node:latest ./main.ts
docker run --rm -v "$PWD:/app" fusionaxi/bun-deno:latest deno run --allow-net ./main.ts
```

Use `COPY --chown=bun:bun` in derived images. Install system packages as `USER root`, then switch back to `USER bun`. Bind-mounted directories must permit UID 1001 to write if the application needs to modify them. Global Bun packages install into `/home/bun/.bun`; Deno installs into `/home/bun/.deno` and caches under `/home/bun/.cache/deno`.

See the minimal [Node example](examples/node/README.md) and [Deno example](examples/deno/README.md).

## Tags and release policy

Versioned tags include both exact runtime versions:

```text
fusionaxi/bun-node:<bun-version>-<node-version>-<variant>
fusionaxi/bun-deno:<bun-version>-<deno-version>-<variant>
```

For example, `fusionaxi/bun-node:1.4.3-24.11.1-slim` and `fusionaxi/bun-deno:1.4.3-2.5.4-debian`. These are illustrations, not a guarantee that particular tags have been published.

Floating aliases include `<runtime-major>-<variant>`, `<runtime-version>-<variant>`, and `<variant>`. Node's `latest` selects the newest supported LTS with the `slim` variant. Deno's `latest` selects the latest stable release with the `debian` variant. Other supported Node majors receive their own aliases. Bun canary and other prereleases are intentionally excluded.

Daily releases reuse existing versioned images when all configured architectures are present and their build-input fingerprints match. Missing images, missing architectures, and changed Dockerfiles, entrypoint, license, Docker ignore rules, or build settings trigger a rebuild. Images published before fingerprinting was introduced are rebuilt once. Manual releases can enable `force_rebuild` to refresh base images and OS packages. Versioned tags can change after these rebuilds; pin `image@sha256:...` when you need an immutable reference. Floating aliases advance only after every image has passed scenarios on both architectures. Promotion uses the tested manifest digests. Docker Hub updates aliases individually, so promotion itself is not an atomic transaction across all tags.

## Development

Install Bun using the version in [.bun-version](.bun-version). Container builds and integration tests require Docker with Buildx or Podman.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run format
bun run lint:fix
bun run check
bun run test:coverage

# Discover stable releases and print a JSON build matrix.
bun run matrix

# Save a plan without Docker or network access, using explicit versions.
bun run matrix --bun 1.4.3 --node 24.11.1 --deno 2.5.4 --output .artifacts/plan.json

# Build and load one image for your host architecture.
bun run images build --plan .artifacts/plan.json --id node-24-slim

# Without a plan, choose the newest supported LTS or latest stable Deno.
bun run images build --runtime node --variant slim
bun run images build --runtime deno --variant debian

# Verify a locally built image. Use the image reference printed by the build.
TEST_IMAGE=fusionaxi/bun-node:1.4.3-24.11.1-slim \
  TEST_RUNTIME=node TEST_VARIANT=slim bun run test:images
```

Use `--platform linux/amd64` or `--platform linux/arm64` for a local cross-platform build; emulation must be installed when the architecture differs from your host. Local builds never push unless `--push` is supplied. Run `bun run images --help` for all commands.

To build and publish every configured platform in one image tag, use `--push`. The default platform list comes from the build plan; you can also pass it explicitly:

```sh
bun run images build --plan .artifacts/plan.json --id node-24-slim \
  --platform linux/amd64,linux/arm64 --push
```

Choose the container engine with `--container-executable docker|podman`. Docker is the default; `CONTAINER_EXECUTABLE` sets a default for CLI commands and container scenarios, and an explicit flag overrides it.

```sh
bun run images build --runtime node --variant alpine --container-executable podman
# or
bun run images promote --plan .artifacts/plan.json --results .artifacts/results --container-executable podman
# or
CONTAINER_EXECUTABLE=podman TEST_IMAGE='image-reference-from-build' TEST_RUNTIME=node bun run test:images
```

Start the selected engine before building. On macOS or Windows, Podman needs a running Podman machine. Podman uses native builds and manifest publishing; Docker uses Buildx. SBOM and provenance attestations are currently generated only by Docker builds. With Podman, `--metadata` requires `--push` and records the published manifest digest.

`bun run format` applies Prettier formatting; `bun run lint:fix` applies ESLint's automatic fixes. Use `bun run format:check` and `bun run lint` for checks without modifying files. `bun run check` runs formatting checks, linting, TypeScript checking, and unit tests. ESLint includes TypeScript rules and type-aware checks for unhandled or misused promises in the tooling and tests. Generated files and dependency directories are excluded. CI enforces formatting and linting.

`bun run test:coverage` prints line and function coverage and writes LCOV results to `coverage/lcov.info`. The unit suite covers CLI commands, offline release discovery, plan validation, build metadata, promotion failures, and child-process exit codes. CLI tests use an injected command runner and isolated temporary files, so they require no Docker installation or registry credentials. Container scenarios remain a separate check through `bun run test:images`.

## Publishing

Create the `fusionaxi/bun-node` and `fusionaxi/bun-deno` repositories on Docker Hub. Configure repository Actions secrets `DOCKER_USERNAME` and `DOCKER_TOKEN` for an account allowed to push to the `fusionaxi` namespace. The GitHub Actions release workflow runs daily or manually from `main`. Release runs use Docker. Manual runs offer a `force_rebuild` option to bypass image reuse.

CI builds and tests every configured variant on each architecture using both engines without registry credentials. Release jobs authenticate with the selected engine and explicitly build every platform in the plan (`linux/amd64` and `linux/arm64` by default) into a shared versioned tag. QEMU enables cross-platform builds and tests. Each published digest is tested on every configured platform before aliases are promoted. Docker releases include SBOM and provenance attestations. No workflow commits generated source files or stores global version state in a GitHub Release.

Configure image names, variants, platforms, and source labels in [runtime-images.json](runtime-images.json). See [architecture and maintenance](docs/architecture.md) and [contributing](CONSTRIBUTION.md).

## Inspiration

Inspired by [ImBIOS/bun-node](https://github.com/ImBIOS/bun-node).

## License

Licensed under the [MIT license](LICENSE).
