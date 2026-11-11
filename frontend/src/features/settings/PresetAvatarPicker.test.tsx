import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetAvatarPicker } from "./PresetAvatarPicker";
import { avatarPresets } from "./avatar-presets";
import type { AvatarPreset } from "./avatar-presets";

/**
 * vitest 默认 test.css=false，CSS 的 `?raw` 导入只会得到空字符串，
 * 所以作用域检查直接读同目录的源文件。仓库未安装 @types/node，
 * 这里用变量说明符的动态导入拿到 fs，避免给 tsc 引入额外的类型依赖。
 */
async function readOwnStylesheet(): Promise<string> {
  const specifier = `node:${"fs"}`;
  const nodeFs = await import(/* @vite-ignore */ specifier) as {
    readFileSync(path: string, encoding: "utf8"): string;
  };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  return nodeFs.readFileSync(`${cwd}/src/features/settings/preset-avatar-picker.css`, "utf8");
}

/** 抽出样式表里所有普通规则的选择器（跳过 @media 等 at-rule 前导），用于检查作用域。 */
function ruleSelectors(css: string): string[] {
  const selectors: string[] = [];
  let buffer = "";
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      const prelude = buffer.trim();
      if (prelude && !prelude.startsWith("@")) selectors.push(prelude);
      buffer = "";
    } else if (char === "}") {
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return selectors;
}

function props(overrides: Partial<Parameters<typeof PresetAvatarPicker>[0]> = {}) {
  return {
    presets: avatarPresets,
    activeId: null,
    busyId: null,
    disabled: false,
    onSelect: vi.fn<(preset: AvatarPreset) => void>(),
    ...overrides
  };
}

describe("PresetAvatarPicker", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders every preset as a labelled toggle button inside one group", () => {
    render(<PresetAvatarPicker {...props()} />);

    const group = screen.getByRole("group", { name: "奶龙头像" });
    expect(group).toHaveClass("avatar-preset-grid");
    expect(screen.getAllByRole("button")).toHaveLength(12);

    for (const preset of avatarPresets) {
      const button = screen.getByRole("button", { name: `使用${preset.label}` });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("title", preset.label);
      expect(button).toHaveAttribute("aria-pressed", "false");
      expect(button).toBeEnabled();

      const image = button.querySelector("img");
      expect(image).not.toBeNull();
      expect(image).toHaveAttribute("src", preset.src);
      expect(image).toHaveAttribute("alt", "");
      expect(image).toHaveAttribute("width", "64");
      expect(image).toHaveAttribute("height", "64");
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("draggable", "false");
    }
  });

  it("marks only the active preset as pressed", () => {
    render(<PresetAvatarPicker {...props({ activeId: "nailong-cool" })} />);

    const pressed = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveClass("is-active");
    expect(pressed[0]).toHaveAccessibleName("使用酷酷奶龙");
    expect(pressed[0].querySelector(".avatar-preset-check")).not.toBeNull();
  });

  it("disables the whole group and spins only the busy preset while it is processing", () => {
    render(<PresetAvatarPicker {...props({ activeId: "nailong-smile", busyId: "nailong-chef" })} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    const busy = screen.getByRole("button", { name: "使用厨师奶龙" });
    expect(busy).toHaveClass("is-busy");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelector(".spinning")).not.toBeNull();
    // 处理中不再展示对勾，避免和 loading 叠在一起。
    expect(busy.querySelector(".avatar-preset-check")).toBeNull();
    expect(document.querySelectorAll(".spinning")).toHaveLength(1);
  });

  it("disables every preset when the page reports it is not ready", () => {
    render(<PresetAvatarPicker {...props({ disabled: true })} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute("aria-busy");
    }
    expect(document.querySelector(".spinning")).toBeNull();
  });

  it("reports the chosen preset and stays silent while disabled", () => {
    const onSelect = vi.fn<(preset: AvatarPreset) => void>();
    const { rerender } = render(<PresetAvatarPicker {...props({ onSelect })} />);

    fireEvent.click(screen.getByRole("button", { name: "使用学霸奶龙" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(avatarPresets[7]);

    onSelect.mockClear();
    rerender(<PresetAvatarPicker {...props({ onSelect, disabled: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "使用学霸奶龙" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the stylesheet scoped to avatar-preset selectors", async () => {
    const selectors = ruleSelectors(await readOwnStylesheet());

    expect(selectors.length).toBeGreaterThanOrEqual(8);
    for (const selector of selectors) {
      // 只允许 `.avatar-preset*` 作用域，避免污染账号页既有的 .account-* 样式。
      expect(selector.startsWith(".avatar-preset")).toBe(true);
      expect(selector).not.toMatch(/\.account-/);
      expect(selector).not.toMatch(/(^|[\s,>+~])(body|html|:root)(?![-\w])/);
    }
  });
});
