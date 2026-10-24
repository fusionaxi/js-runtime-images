import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { getJSON } from "../../src/versions.ts";

const fetchMock = spyOn(globalThis, "fetch");
const originalToken = Bun.env.GITHUB_TOKEN;
afterAll(() => fetchMock.mockRestore());

afterEach(() => {
  fetchMock.mockReset();
  if (originalToken === undefined) delete Bun.env.GITHUB_TOKEN;
  else Bun.env.GITHUB_TOKEN = originalToken;
});

describe("release feed HTTP client", () => {
  test("reads JSON responses with a bounded request timeout", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ version: "1.4.3" }));
    expect(await getJSON("https://registry.npmjs.org/bun/latest")).toEqual({ version: "1.4.3" });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
  test("retries transient failures and succeeds", async () => {
    fetchMock.mockResolvedValueOnce(new Response("retry", { status: 503 }));
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await getJSON("https://example.com/releases")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test("does not retry a missing feed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(getJSON("https://example.com/releases")).rejects.toThrow("HTTP 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("bounds retries when an upstream keeps failing", async () => {
    fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(getJSON("https://example.com/releases")).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  test("bounds network failure retries", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(getJSON("https://example.com/releases")).rejects.toThrow("Cannot fetch");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  test("sends the GitHub token only to the GitHub API", async () => {
    Bun.env.GITHUB_TOKEN = "fixture-token";
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await getJSON("https://api.github.com/repos/denoland/deno/releases/latest");
    await getJSON("https://registry.npmjs.org/bun/latest");
    const githubHeaders = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    const registryHeaders = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(githubHeaders.Authorization).toBe("Bearer fixture-token");
    expect(registryHeaders.Authorization).toBeUndefined();
  });
});
