# Bun build, Node runtime

After publishing the FusionAxi base images, run from this directory:

```sh
docker build -t fusionaxi-example-node .
docker run --rm fusionaxi-example-node
```

Bun bundles the TypeScript entry point; Node executes the resulting JavaScript. No dependencies need to be downloaded. The root project still uses Bun for all maintenance scripts and tests.
