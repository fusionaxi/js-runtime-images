import { describe, expect, test } from "bun:test";
import { createPlan, parsePlan } from "../../src/matrix.ts";
import { config, versions } from "./fixtures.ts";

describe("build plans", () => {
  test("covers both runtime families and all configured variants", () => {
    const plan = createPlan(config, versions);
    expect(plan.include).toHaveLength(14);
    expect(plan.include.filter((entry) => entry.runtime === "deno")).toHaveLength(2);
    expect(plan.include.every((entry) => entry.image.startsWith("fusionaxi/"))).toBe(true);
    expect(
      plan.include.every((entry) => entry.platforms.join(",") === "linux/amd64,linux/arm64"),
    ).toBe(true);
  });
  test("pins exact runtime patches and matches Bun libc to the base image", () => {
    const plan = createPlan(config, versions);
    expect(plan.include.find((entry) => entry.id === "node-24-slim")).toMatchObject({
      runtimeImage: "node:24.11.1-bookworm-slim",
      bunImage: "oven/bun:1.4.3-debian",
      image: "fusionaxi/bun-node:1.4.3-24.11.1-slim",
    });
    expect(plan.include.find((entry) => entry.id === "deno-2-alpine")).toMatchObject({
      runtimeImage: "denoland/deno:alpine-2.5.4",
      bunImage: "oven/bun:1.4.3-alpine",
      image: "fusionaxi/bun-deno:1.4.3-2.5.4-alpine",
    });
  });
  test("assigns latest once per image and chooses LTS for Node", () => {
    const plan = createPlan(config, versions);
    expect(
      plan.include
        .filter((entry) => entry.aliases.includes("fusionaxi/bun-node:latest"))
        .map((entry) => entry.id),
    ).toEqual(["node-24-slim"]);
    expect(
      plan.include
        .filter((entry) => entry.aliases.includes("fusionaxi/bun-deno:latest"))
        .map((entry) => entry.id),
    ).toEqual(["deno-2-debian"]);
    const aliases = plan.include.flatMap((entry) => entry.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
  test("filters to one family and variant", () => {
    const plan = createPlan(config, versions, { runtime: "deno", variant: "debian" });
    expect(plan.include.map((entry) => entry.id)).toEqual(["deno-2-debian"]);
    expect(() => createPlan(config, versions, { runtime: "deno", variant: "slim" })).toThrow(
      "does not support",
    );
  });
  test("rejects releases with no default or multiple defaults", () => {
    expect(() => createPlan(config, { ...versions, node: [] })).toThrow("exactly one default");
    expect(() =>
      createPlan(config, {
        ...versions,
        node: versions.node.map((release) => ({ ...release, default: true })),
      }),
    ).toThrow("exactly one default");
  });
  test("rejects multiple patch versions that would race on a major alias", () => {
    expect(() =>
      createPlan(config, {
        ...versions,
        deno: [
          { version: "2.5.4", default: true },
          { version: "2.5.3", default: false },
        ],
      }),
    ).toThrow("Duplicate build id");
  });
  test("round-trips a serialized plan", () => {
    const plan = createPlan(config, versions);
    expect(parsePlan(JSON.parse(JSON.stringify(plan)), config)).toEqual(plan);
  });
  test.each(["image", "dockerfile", "runtimeImage", "bunImage", "platforms", "source"])(
    "rejects a modified %s",
    (key) => {
      const plan = createPlan(config, versions);
      const row = plan.include[0]! as unknown as Record<string, unknown>;
      row[key] = "unexpected";
      expect(() => parsePlan(plan, config)).toThrow(`Invalid ${key}`);
    },
  );
  test("rejects unexpected registry aliases and empty plans", () => {
    const plan = createPlan(config, versions);
    plan.include[0]!.aliases.push("someone-else/image:latest");
    expect(() => parsePlan(plan, config)).toThrow("aliases");
    expect(() => parsePlan({ include: [] }, config)).toThrow("nonempty");
  });

  test("rejects plans beyond GitHub Actions' matrix limit", () => {
    const node = Array.from({ length: 65 }, (_, index) => ({
      version: `${100 + index}.0.0`,
      default: index === 0,
    }));
    expect(() => createPlan(config, { ...versions, node })).toThrow("256-job matrix limit");
  });

  test.each([null, { runtime: "unknown" }].map((entry) => ({ entry })))(
    "rejects missing or unknown plan runtimes: %j",
    ({ entry }) => {
      expect(() => parsePlan({ include: [entry] }, config)).toThrow("Invalid runtime");
    },
  );

  test("rejects unsupported plan variants", () => {
    const plan = createPlan(config, versions, { runtime: "deno" });
    plan.include[0]!.variant = "slim";
    expect(() => parsePlan(plan, config)).toThrow("Invalid variant");
  });

  test("rejects duplicate aliases inside a plan entry", () => {
    const plan = createPlan(config, versions);
    plan.include[0]!.aliases.push(plan.include[0]!.aliases[0]!);
    expect(() => parsePlan(plan, config)).toThrow("Unexpected aliases");
  });
});
