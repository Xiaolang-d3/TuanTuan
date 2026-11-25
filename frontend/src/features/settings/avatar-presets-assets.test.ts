import { describe, expect, it } from "vitest";
import { avatarPresets } from "./avatar-presets";

const sources = import.meta.glob<string>("./avatars/*.webp", {
  eager: true,
  query: "?url",
  import: "default"
});

describe("built-in nailong artwork", () => {
  it("builds and uses one WebP per preset", () => {
    const expectedPaths = avatarPresets.map(({ id }) => `./avatars/${id}.webp`);
    expect(Object.keys(sources).sort()).toEqual(expectedPaths.sort());

    for (const { id, src } of avatarPresets) {
      expect(src).toBe(sources[`./avatars/${id}.webp`]);
      expect(src).toMatch(/\.webp$/);
    }
    expect(new Set(avatarPresets.map(({ src }) => src)).size).toBe(avatarPresets.length);
  });
});
