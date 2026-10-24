import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerExecutable, containerImage } from "../../src/container.ts";
import {
  buildCommand,
  buildImage,
  promote,
  promotionCommands,
  type Run,
} from "../../src/docker.ts";
import { createPlan } from "../../src/matrix.ts";
import { config, versions } from "./fixtures.ts";

const plan = createPlan(config, versions, { runtime: "node", variant: "alpine" });
const build = plan.include.find((entry) => entry.id === "node-24-alpine")!;
const digest = `sha256:${"c".repeat(64)}`;

describe("container engine selection", () => {
  test("accepts Docker and Podman and rejects executable injection", () => {
    expect(containerExecutable("docker")).toBe("docker");
    expect(containerExecutable("podman")).toBe("podman");
    expect(() => containerExecutable("podman; echo injected")).toThrow("docker or podman");
    expect(() => containerExecutable("")).toThrow("docker or podman");
  });

  test("qualifies Docker Hub references only for Podman", () => {
    expect(containerImage("node:24-alpine", "podman")).toBe("docker.io/library/node:24-alpine");
    expect(containerImage("oven/bun:1.4.3-alpine", "podman")).toBe(
      "docker.io/oven/bun:1.4.3-alpine",
    );
    expect(containerImage("docker.io/fusionaxi/bun-node:alpine", "podman")).toBe(
      "docker.io/fusionaxi/bun-node:alpine",
    );
    expect(containerImage("fusionaxi/bun-node:alpine", "docker")).toBe("fusionaxi/bun-node:alpine");
  });
});

describe("native Podman commands", () => {
  test("builds locally without Docker Buildx flags", () => {
    const command = buildCommand(build, { containerExecutable: "podman" });
    expect(command.slice(0, 3)).toEqual(["podman", "build", "--pull=always"]);
    expect(command).toContain("BUN_IMAGE=docker.io/oven/bun:1.4.3-alpine");
    expect(command).toContain("RUNTIME_IMAGE=docker.io/library/node:24.11.1-alpine");
    expect(command).toContain(`docker.io/${build.image}`);
    for (const flag of [
      "buildx",
      "--load",
      "--push",
      "--provenance=mode=max",
      "--sbom=true",
      "--metadata-file",
    ]) {
      expect(command).not.toContain(flag);
    }
  });

  test("uses a manifest for multi-platform publishing", () => {
    const command = buildCommand(
      build,
      { containerExecutable: "podman", push: true, metadata: "result.json" },
      "localhost/build:test",
    );
    expect(command).toContain("linux/amd64,linux/arm64");
    expect(command).toContain("--manifest");
    expect(command).toContain("localhost/build:test");
    expect(command).not.toContain("--tag");
    expect(command).not.toContain("--metadata-file");
  });

  test("rejects metadata for an unpublished Podman build", () => {
    expect(() =>
      buildCommand(build, { containerExecutable: "podman", metadata: "result.json" }),
    ).toThrow("requires --push");
  });

  test("allocates a separate manifest per promotion and imports every architecture by digest", () => {
    const digests = Object.fromEntries(plan.include.map((entry) => [entry.id, digest]));
    const commands = promotionCommands(plan, digests, "podman");
    const imports = commands.filter((command) => command[2] === "create");
    expect(imports).toHaveLength(plan.include.length);
    expect(new Set(imports.map((command) => command[4])).size).toBe(plan.include.length);
    expect(
      imports.every(
        (command) =>
          command[3] === "--all" &&
          command.at(-1) === `docker://docker.io/fusionaxi/bun-node@${digest}`,
      ),
    ).toBe(true);
    const pushes = commands.filter((command) => command[2] === "push");
    expect(pushes).toHaveLength(plan.include.flatMap((entry) => entry.aliases).length);
    expect(pushes.every((command) => command[3] === "--all")).toBe(true);
  });

  test("validates all promotion digests before generating commands", () => {
    expect(() => promotionCommands(plan, { [plan.include[0]!.id]: digest }, "podman")).toThrow(
      "digest",
    );
  });
});

describe("Podman execution and result metadata", () => {
  let directory: string;
  let commands: string[][];
  let execute: Run;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fusionaxi-podman-tests-"));
    commands = [];
    execute = async (command) => {
      commands.push(command);
      const index = command.indexOf("--digestfile");
      if (index !== -1) await Bun.write(command[index + 1]!, `${digest}\n`);
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("builds locally without pushing or creating temporary manifests", async () => {
    await buildImage(build, { containerExecutable: "podman" }, execute);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.slice(0, 2)).toEqual(["podman", "build"]);
  });

  test("publishes a manifest, normalizes its registry digest, and cleans up", async () => {
    const metadata = join(directory, "results", "build.json");
    await buildImage(build, { containerExecutable: "podman", push: true, metadata }, execute);
    expect(commands).toHaveLength(3);
    const manifest = commands[0]![commands[0]!.indexOf("--manifest") + 1]!;
    expect(manifest).toStartWith("localhost/fusionaxi-build-node-24-alpine:");
    expect(commands[1]).toContain(manifest);
    expect(commands[1]!.at(-1)).toBe(`docker://docker.io/${build.image}`);
    expect(await Bun.file(metadata).json()).toEqual({ "containerimage.digest": digest });
    expect(commands[2]).toEqual(["podman", "manifest", "rm", manifest]);
    const digestFile = commands[1]![commands[1]!.indexOf("--digestfile") + 1]!;
    expect(await Bun.file(digestFile).exists()).toBe(false);
  });

  test("can publish without saving build metadata", async () => {
    await buildImage(build, { containerExecutable: "podman", push: true }, execute);
    expect(commands.map((command) => command[2])).toEqual(["--pull=always", "push", "rm"]);
  });

  test("does not publish after a failed build and preserves the failure if cleanup also fails", async () => {
    await expect(
      buildImage(build, { containerExecutable: "podman", push: true }, async (command) => {
        commands.push(command);
        throw new Error(command[1] === "build" ? "build failed" : "cleanup failed");
      }),
    ).rejects.toThrow("build failed");
    expect(commands).toHaveLength(2);
    expect(commands.some((command) => command[2] === "push")).toBe(false);
    expect(commands[1]!.slice(0, 3)).toEqual(["podman", "manifest", "rm"]);
  });

  test("does not save success metadata after a push failure", async () => {
    const metadata = join(directory, "build.json");
    await expect(
      buildImage(
        build,
        { containerExecutable: "podman", push: true, metadata },
        async (command) => {
          commands.push(command);
          if (command[2] === "push") throw new Error("registry unavailable");
        },
      ),
    ).rejects.toThrow("registry unavailable");
    expect(await Bun.file(metadata).exists()).toBe(false);
    expect(commands.at(-1)!.slice(0, 3)).toEqual(["podman", "manifest", "rm"]);
  });

  test("rejects an invalid registry digest and cleans up the manifest", async () => {
    const metadata = join(directory, "build.json");
    await expect(
      buildImage(
        build,
        { containerExecutable: "podman", push: true, metadata },
        async (command) => {
          commands.push(command);
          const index = command.indexOf("--digestfile");
          if (index !== -1) await Bun.write(command[index + 1]!, "invalid");
        },
      ),
    ).rejects.toThrow("digest");
    expect(await Bun.file(metadata).exists()).toBe(false);
    expect(commands.at(-1)![2]).toBe("rm");
  });

  test("promotes every alias and removes temporary manifests", async () => {
    await Promise.all(
      plan.include.map((entry) =>
        Bun.write(
          join(directory, `${entry.id}.json`),
          JSON.stringify({ "containerimage.digest": digest }),
        ),
      ),
    );
    await promote(plan, directory, execute, "podman");
    expect(commands.filter((command) => command[2] === "push")).toHaveLength(
      plan.include.flatMap((entry) => entry.aliases).length,
    );
    expect(commands.filter((command) => command[2] === "rm")).toHaveLength(plan.include.length);
  });

  test("stops alias promotion on failure and still attempts cleanup", async () => {
    await Promise.all(
      plan.include.map((entry) =>
        Bun.write(
          join(directory, `${entry.id}.json`),
          JSON.stringify({ "containerimage.digest": digest }),
        ),
      ),
    );
    await expect(
      promote(
        plan,
        directory,
        async (command) => {
          commands.push(command);
          if (command[2] === "push") throw new Error("promotion failed");
          if (command[2] === "rm") throw new Error("cleanup failed");
        },
        "podman",
      ),
    ).rejects.toThrow("promotion failed");
    expect(commands.map((command) => command[2])).toEqual(["create", "push", "rm"]);
  });
});
