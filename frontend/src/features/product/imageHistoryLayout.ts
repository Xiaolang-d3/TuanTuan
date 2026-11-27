const GAP = 8;
const BORDER = 2;
const CAPTION = 36;
const CARD_CHROME = BORDER + CAPTION;

export type HistoryTile = { index: number; x: number; y: number; width: number; height: number };

function rowImageHeight(ratios: number[], width: number) {
  const imageWidth = width - (ratios.length - 1) * GAP - ratios.length * BORDER;
  return imageWidth / ratios.reduce((sum, ratio) => sum + ratio, 0);
}

export function layoutImageHistory(imageRatios: number[], width: number) {
  const ratios = imageRatios.map(ratio => Number.isFinite(ratio) && ratio > 0
    ? Math.min(3, Math.max(0.4, ratio))
    : 4 / 3);
  const tiles: HistoryTile[] = [];
  const target = Math.min(210, width * 0.38);
  const rowLimit = width < 340 ? 1 : width < 560 ? 2 : width < 850 ? 3 : 5;
  let y = 0;

  function addRow(indices: number[], top: number, rowWidth: number, maxHeight = Infinity) {
    const imageHeight = Math.min(maxHeight, rowImageHeight(indices.map(index => ratios[index]), rowWidth));
    const height = imageHeight + CARD_CHROME;
    let x = 0;
    for (const index of indices) {
      const tileWidth = imageHeight * ratios[index] + BORDER;
      tiles.push({ index, x, y: top, width: tileWidth, height });
      x += tileWidth + GAP;
    }
    return height;
  }

  for (let start = 0; start < ratios.length;) {
    const indices = ratios.slice(start, start + 5).map((_, offset) => start + offset);
    const portrait = indices.find(index => ratios[index] <= 0.8);
    const landscape = indices.filter(index => ratios[index] >= 1);
    if (width >= 640 && portrait !== undefined && landscape.length === 4) {
      const first = landscape.slice(0, 2);
      const second = landscape.slice(2);
      // Solve for the left column width so both rows and the portrait share an outer height.
      const heightPerPixel = 1 / (ratios[first[0]] + ratios[first[1]])
        + 1 / (ratios[second[0]] + ratios[second[1]]);
      const portraitRatio = ratios[portrait];
      const leftWidth = (width - GAP - BORDER
        - portraitRatio * (CARD_CHROME + GAP - heightPerPixel * (GAP + 2 * BORDER)))
        / (1 + portraitRatio * heightPerPixel);
      const firstHeight = addRow(first, y, leftWidth);
      const secondTop = y + firstHeight + GAP;
      const totalHeight = firstHeight + GAP + rowImageHeight(second.map(index => ratios[index]), leftWidth) + CARD_CHROME;
      tiles.push({ index: portrait, x: leftWidth + GAP, y, width: width - leftWidth - GAP, height: totalHeight });
      addRow(second, secondTop, leftWidth);
      y += totalHeight + GAP;
      start += 5;
      continue;
    }

    let row = indices.slice(0, 1);
    let best = Infinity;
    for (let count = 1; count <= Math.min(rowLimit, indices.length); count++) {
      const height = rowImageHeight(ratios.slice(start, start + count), width);
      const leavesOne = ratios.length - start - count === 1 && rowLimit > 1;
      const score = Math.abs(Math.log(height / target)) + (leavesOne ? 0.35 : 0);
      if (score < best) {
        best = score;
        row = indices.slice(0, count);
      }
    }
    y += addRow(row, y, width, rowLimit === 1 ? Infinity : target * 1.75) + GAP;
    start += row.length;
  }

  return { tiles, height: Math.max(0, y - GAP) };
}
