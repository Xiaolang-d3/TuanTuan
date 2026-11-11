import { describe, expect, it } from "vitest";
import { avatarPresets } from "./avatar-presets";

// Assets are read through Vite rather than node:fs so this stays inside the
// browser build's module graph and needs no extra type declarations.
const sources = import.meta.glob("../../../public/avatars/*.svg", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

const maxAvatarBytes = 20 * 1024;

function sourceOf(id: string) {
  return sources[`../../../public/avatars/${id}.svg`];
}

describe("built-in nailong avatars", () => {
  it("exists for every preset and ships no stray files", () => {
    const shipped = Object.keys(sources)
      .map(path => path.split("/").pop() as string)
      .sort();
    expect(shipped).toEqual(avatarPresets.map(preset => `${preset.id}.svg`).sort());
  });

  it.each(avatarPresets.map(preset => [preset.id, preset] as const))("keeps %s self-contained", (id) => {
    const source = sourceOf(id);
    expect(typeof source).toBe("string");
    expect(source.length).toBeLessThan(maxAvatarBytes);

    expect(source).toMatch(/<svg[\s>]/);
    expect(source).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(source).toContain('viewBox="0 0 512 512"');

    // The picker rasterises these in a canvas, so anything the browser would
    // have to fetch, run or lay out as text has to stay out of the file.
    expect(source).not.toMatch(/<script/i);
    expect(source).not.toMatch(/<foreignObject/i);
    expect(source).not.toMatch(/<text[\s>]/i);
    expect(source).not.toMatch(/<image/i);
    expect(source).not.toMatch(/(?:href|xlink:href)="(?:https?:)?\/\//i);
    expect(source).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i);
    expect(source).not.toMatch(/@import/i);
    expect(source).not.toMatch(/data:image\/(?!svg\+xml)/i);
    // Uploads are cropped to a circle, so the artwork needs an opaque backdrop.
    expect(source).toMatch(/<rect[^>]*(width="512"[^>]*height="512"|height="512"[^>]*width="512")/i);
  });

  it("uses one id per avatar and points every src at its own file", () => {
    const ids = avatarPresets.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of avatarPresets) {
      expect(preset.src).toBe(`/avatars/${preset.id}.svg`);
      expect(preset.label.trim()).not.toBe("");
    }
  });
});
