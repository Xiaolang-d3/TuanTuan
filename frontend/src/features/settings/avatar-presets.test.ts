import { describe, expect, it } from "vitest";
import { avatarPresets } from "./avatar-presets";

/** 契约表格里的顺序与文案，页面和 e2e 都按这个顺序展示。 */
const expected: readonly (readonly [string, string])[] = [
  ["nailong-smile", "开心奶龙"],
  ["nailong-wink", "眨眼奶龙"],
  ["nailong-sleep", "打盹奶龙"],
  ["nailong-surprise", "惊喜奶龙"],
  ["nailong-cool", "酷酷奶龙"],
  ["nailong-cheer", "加油奶龙"],
  ["nailong-snack", "吃货奶龙"],
  ["nailong-study", "学霸奶龙"],
  ["nailong-space", "宇航奶龙"],
  ["nailong-chef", "厨师奶龙"],
  ["nailong-flower", "花花奶龙"],
  ["nailong-music", "音乐奶龙"]
];

describe("avatarPresets", () => {
  it("ships the twelve nailong avatars in contract order", () => {
    expect(avatarPresets).toHaveLength(12);
    expect(avatarPresets.map((preset) => [preset.id, preset.label])).toEqual(
      expected.map(([id, label]) => [id, label])
    );
  });

  it("keeps ids and labels unique so aria-pressed and 使用X 的按钮名可区分", () => {
    expect(new Set(avatarPresets.map((preset) => preset.id)).size).toBe(avatarPresets.length);
    expect(new Set(avatarPresets.map((preset) => preset.label)).size).toBe(avatarPresets.length);
    for (const preset of avatarPresets) {
      expect(preset.label.endsWith("奶龙")).toBe(true);
      expect(preset.label.trim()).toBe(preset.label);
    }
  });
});
