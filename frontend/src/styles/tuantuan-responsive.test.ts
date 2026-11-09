// The application tsconfig is browser-only, while Vitest provides these Node APIs at runtime.
// @ts-expect-error Node types are intentionally not part of the production frontend.
import { readFileSync } from "node:fs";
// @ts-expect-error Node types are intentionally not part of the production frontend.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workingDirectory = (globalThis as typeof globalThis & { process: { cwd(): string } }).process.cwd();
const tuantuanStyles = ["src/styles/tuantuan.css", "src/features/chat/styles-theme.css"]
  .map((path) => readFileSync(resolve(workingDirectory, path), "utf8")).join("\n");
const settingsStyles = readFileSync(
  resolve(workingDirectory, "src/features/settings/settings-workspace.css"),
  "utf8"
);

function mediaBlocks(styles: string, query: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < styles.length) {
    const start = styles.indexOf(`@media ${query}`, cursor);
    if (start === -1) break;

    const openingBrace = styles.indexOf("{", start);
    let depth = 1;
    let end = openingBrace + 1;
    while (depth > 0 && end < styles.length) {
      if (styles[end] === "{") depth += 1;
      if (styles[end] === "}") depth -= 1;
      end += 1;
    }

    blocks.push(styles.slice(openingBrace + 1, end - 1));
    cursor = end;
  }

  return blocks;
}

describe("responsive application shell styles", () => {
  it("keeps the desktop application top bar unchanged", () => {
    const desktopTopbar = tuantuanStyles.match(/\.app-topbar\s*\{([^}]*)\}/)?.[1];

    expect(desktopTopbar).toContain("position: sticky");
    expect(desktopTopbar).toContain("display: flex");
    expect(desktopTopbar).toContain("height: var(--app-topbar-height)");
  });

  it("hides only titleless application top bars at the mobile breakpoint", () => {
    const mobileStyles = mediaBlocks(tuantuanStyles, "(max-width: 820px)").join("\n");
    const mobileTopbarRules = [...mobileStyles.matchAll(/\.app-topbar[^{]*\{([^}]*)\}/g)]
      .map((match) => match[1].trim().replace(/\s+/g, " "));

    expect(mobileTopbarRules.some((rule) => rule.includes("display: none"))).toBe(true);
    expect(mobileStyles).toMatch(/\.app-topbar\.is-titleless/);
    expect(mobileStyles).toMatch(/\.app-topbar:not\(:has\(\.app-topbar-context\)\)/);
    expect(mobileStyles).not.toMatch(/^\s*\.app-topbar\s*\{[^}]*display:\s*none/m);
  });

  it("sizes page and chat content from the fixed mobile navigation only", () => {
    const tabletStyles = mediaBlocks(tuantuanStyles, "(max-width: 820px)").join("\n");
    const phoneStyles = mediaBlocks(tuantuanStyles, "(max-width: 600px)").join("\n");

    expect(tabletStyles).toContain("margin-top: 62px");
    expect(tabletStyles).toContain("height: calc(100dvh - 62px)");
    expect(phoneStyles).toContain("margin-top: 58px");
    expect(phoneStyles).toContain("height: calc(100dvh - 58px)");
  });

  it("uses shared desktop spacing for settings and drops it with the mobile top bar", () => {
    const settingsWorkspace = settingsStyles.match(/\.settings-workspace\s*\{([^}]*)\}/)?.[1];
    const mobileSettings = mediaBlocks(settingsStyles, "(max-width: 820px)").join("\n");

    expect(settingsWorkspace).toContain("padding: var(--space-5) 0 var(--space-10)");
    expect(mobileSettings).toContain(".settings-workspace { padding-top: 0; }");
  });
});
