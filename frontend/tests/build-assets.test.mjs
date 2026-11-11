// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function assetDirectory(revision) {
  vi.stubEnv("GITHUB_SHA", revision);
  vi.resetModules();
  const { default: config } = await import("../vite.config.ts");
  return config.build.assetsDir;
}

it("uses separate resource URLs for each CI release, including unchanged chunks", async () => {
  const first = await assetDirectory("a".repeat(40));
  const second = await assetDirectory("b".repeat(40));
  expect(first).toBe(`assets/${"a".repeat(40)}`);
  expect(second).toBe(`assets/${"b".repeat(40)}`);
  expect(first).not.toBe(second);
});

it("keeps local builds usable without a CI revision", async () => {
  expect(await assetDirectory("")).toBe("assets");
});

it("rejects invalid revision paths", async () => {
  await expect(assetDirectory("../previous-release")).rejects.toThrow("full commit SHA");
});
