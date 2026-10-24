# Architecture and maintenance

`runtime-images.json` is the image catalog. `src/config.ts` validates it before any build is started. The root package is private tooling; Docker Hub is the publication destination.

| Module                       | Responsibility                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `src/versions.ts`            | Resolve Bun and Deno stable releases and currently supported Node release lines               |
| `src/matrix.ts`              | Build a deterministic plan, pin exact runtime patches, allocate non-conflicting tags          |
| `src/container.ts`           | Validate the selected engine and qualify Podman's Docker Hub references                       |
| `src/docker.ts`              | Construct Docker/Podman argument arrays, run builds, validate result digests, promote aliases |
| `src/cli.ts`                 | Validate command options and coordinate the workflow                                          |
| `docker/bun-node/Dockerfile` | Add Bun to the official Node base image                                                       |
| `docker/bun-deno/Dockerfile` | Add Bun to the official Deno base image                                                       |
| `docker/entrypoint.sh`       | Select Bun for scripts and flags, then exec the requested process                             |

## Runtime discovery

Bun comes from its npm registry release metadata, Node from `@nodevu/core` (which combines `nodejs.org/dist/index.json` with the official Node release schedule), and Deno from its latest stable GitHub release. Node releases are filtered by support start/end dates; the newest patch in every Current, Active LTS, and Maintenance LTS major is used. The newest LTS receives default aliases once its scheduled LTS start date is reached. An upstream error fails the plan instead of silently treating a missing version as success. HTTP calls have bounded timeouts and retry transient failures. Exact CLI version overrides allow fully offline plan generation.

Official `oven/bun` stages supply the binary; this repository does not duplicate Bun's download and signature verification installer. Alpine variants copy the musl build and Debian variants copy the glibc build. Deno's own Alpine base supplies its glibc compatibility libraries; copying only the Deno binary into plain Alpine would omit them. See the [official Deno Dockerfiles](https://github.com/denoland/deno_docker) and [Bun Dockerfiles](https://github.com/oven-sh/bun/tree/main/dockerhub).

Two shared Dockerfiles define the Node and Deno image families. Exact runtime versions are passed as image build arguments. Docker builds use the repository root as their context, with `.dockerignore` limiting files to image assets and the license. Every final image has Tini, a writable application directory and caches, a `bunx` symlink, and a non-root default user.

## Release sequence

1. Validate the TypeScript tooling and unit tests.
2. Discover releases once and upload the JSON plan as a workflow artifact.
3. Build every plan entry for both architectures and push its versioned tag; Docker adds SBOM and provenance attestations.
4. Run TypeScript scenarios against that build's exact manifest digest on both architectures.
5. Upload digest metadata only for builds that pass their scenarios.
6. After all jobs succeed, validate every result digest before promoting any alias.

Release jobs are serialized. A failing matrix row prevents promotion, although versioned tags from successful rows remain available. A registry failure during promotion can still leave only some aliases updated; rerun promotion with the same plan and results to finish. Retain the workflow artifacts for auditing or retrying a promotion.

The `--container-executable` flag selects `docker` or `podman`, defaulting to `CONTAINER_EXECUTABLE` or Docker. Manual releases expose the same choice; scheduled releases use Docker. CI verifies both engines. Shared setup installs QEMU, then prepares Docker Buildx or native Podman. Authentication, builds, smoke tests, and promotion use the selected engine.

Docker uses Buildx to publish multi-platform images with attestations. Podman uses `build --manifest` and `manifest push --all --digestfile`, then writes the registry digest into the same `containerimage.digest` metadata field used by Buildx. Podman promotion imports each tested digest with `manifest create --all` and publishes its aliases with `manifest push --all`. Temporary manifests are removed after success or failure. Podman does not receive Docker-only Buildx flags. See the [Podman build](https://docs.podman.io/en/latest/markdown/podman-build.1.html) and [manifest push](https://docs.podman.io/en/latest/markdown/podman-manifest-push.1.html) references.

Daily full rebuilds intentionally avoid a global version-state file. This prevents a successful variant from suppressing retries for a failed variant and refreshes OS packages even when runtime versions are unchanged.

## Common changes

Change the namespace, image names, platform list, or enabled variants in `runtime-images.json`. If renaming the GitHub repository, update its `source` URL there. The CLI validates saved plans against the current catalog, so regenerate a plan after changing the configuration.

For a new distro, add its base image selection to `src/matrix.ts`, enable it in the configuration validator, and ensure the appropriate Dockerfile handles its package manager and runtime libraries. Add a container scenario only when the new distro introduces new behavior; existing scenarios run automatically for each plan entry.

Update `.bun-version` and `package.json` together when changing the tooling runtime. Use `bun install` to refresh `bun.lock`, and verify with a frozen install. Dependency updates are handled by Dependabot for Bun, Docker, and GitHub Actions.
