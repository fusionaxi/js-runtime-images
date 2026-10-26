# Contributing

Use Bun for dependency installation, scripts, and testing. The project has no Python test dependency and does not use npm, pnpm, Jest, or Vitest to run its tooling.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run format
bun run lint:fix
bun run check
bun run test:coverage
```

Prettier handles formatting, and ESLint handles code quality using the TypeScript recommended rules plus type-aware promise checks for `src/` and the test suites. Configuration lives in `.prettierrc.json`, `.prettierignore`, and `eslint.config.js`. All commands run through Bun. `bun run check` checks formatting, linting, types, and unit tests without rewriting files; CI also enforces these checks.

Keep runtime policy and tag generation in `src/`, image setup in `docker/`, and scenarios in `tests/`. Change `runtime-images.json` to configure image names, variants, and platforms. Do not add generated Dockerfiles for each runtime version.

Unit tests run offline with release fixtures. Cover behavior such as release selection, unsupported inputs, alias conflicts, command failures, and promotion requirements. Container scenarios use `bun:test`; do not introduce pytest or Python fixtures. CI builds both architectures with Docker and Podman and runs the same scenarios for every image variant.

To run container tests locally, build one image and supply its reference:

```sh
bun run images build --runtime deno --variant debian
TEST_IMAGE=<image-reference-from-build> TEST_RUNTIME=deno TEST_VARIANT=debian bun run test:images
```

Select Podman with `bun run images build --runtime deno --variant debian --container-executable podman`, then set `CONTAINER_EXECUTABLE=podman` when running container scenarios. Docker is the default engine. Both engines must already be available; cross-platform builds need emulation.

Optional test variables are `TEST_PLATFORMS` (comma-separated; defaults to the host architecture), `EXPECTED_BUN`, and `EXPECTED_RUNTIME`. If `TEST_IMAGE` is absent, container scenarios are skipped; unit tests require no container engine. The suite checks version identity, runtime execution, script arguments, unprivileged permissions, local and global dependency installs without network access, exit codes, and signal handling.

Before proposing a change, run `bun run check` and review the generated plan. Update the relevant documentation for changes to tag names, defaults, supported variants, or publishing behavior. Preserve copyright and license notices when modifying code.
