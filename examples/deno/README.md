# Bun tooling, Deno runtime

After publishing the FusionAxi base images, run from this directory:

```sh
docker build -t fusionaxi-example-deno .
docker run --rm fusionaxi-example-deno
```

The build exercises Bun's TypeScript support; the container runs the same source with Deno. This example has no external dependencies and needs no Deno permissions.
