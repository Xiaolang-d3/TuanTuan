import { describe, expect, it } from "vitest";
import { layoutImageHistory } from "./imageHistoryLayout";

const screenshotRatios = [4 / 3, 2 / 3, 16 / 9, 4 / 3, 4 / 3];

describe("图片历史拼贴", () => {
  it("四张横图拼成两行，竖图在右侧贯穿两行", () => {
    const width = 972;
    const { tiles, height } = layoutImageHistory(screenshotRatios, width);
    const [first, second, poster, third, fourth] = tiles;
    expect(tiles.map(tile => tile.index)).toEqual([0, 2, 1, 3, 4]);
    expect(poster.x + poster.width).toBeCloseTo(width);
    expect(poster.height).toBeCloseTo(height);
    expect(second.x + second.width + 8).toBeCloseTo(poster.x);
    expect(fourth.x + fourth.width + 8).toBeCloseTo(poster.x);
    expect(third.y).toBeCloseTo(first.height + 8);
    expect(third.y + third.height).toBeCloseTo(height);
    expect((poster.width - 2) / (poster.height - 38)).toBeCloseTo(2 / 3);
  });

  it.each([120, 340, 540, 640, 972, 1600])("在 %ipx 内放下每张卡片且互不重叠", width => {
    const ratios = [...screenshotRatios, 0, Infinity, 8, 0.2, 1, 2, 0.75];
    const { tiles, height } = layoutImageHistory(ratios, width);
    expect(tiles.map(tile => tile.index).sort((a, b) => a - b)).toEqual(ratios.map((_, index) => index));
    for (const [index, tile] of tiles.entries()) {
      expect(tile.width).toBeGreaterThan(0);
      expect(tile.height).toBeGreaterThan(38);
      expect(tile.x + tile.width).toBeLessThanOrEqual(width + 0.0001);
      expect(tile.y + tile.height).toBeLessThanOrEqual(height + 0.0001);
      for (const other of tiles.slice(index + 1)) {
        const horizontal = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
        const vertical = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
        expect(Math.min(horizontal, vertical)).toBeLessThan(0.0001);
      }
    }
  });
});
