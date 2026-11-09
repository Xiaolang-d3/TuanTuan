import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PresentationService } from "./presentation-service";
import { PresentationPreview } from "./PresentationPreview";

beforeEach(() => vi.stubGlobal("URL", class extends URL { static revokeObjectURL = vi.fn(); }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const previews = [1, 2, 3].map(number => ({ id: `page-${number}`, version: 1, filename: `P0${number}.png`, size: 10, media_type: "image/png" }));
function fixture() {
  return { preview: vi.fn(artifact => Promise.resolve(`blob:${artifact.id}:${artifact.version}`)) } as unknown as PresentationService;
}

it("jumps from thumbnails, keeps the selected page visible, and retains download controls", async () => {
  const download = vi.fn(), select = vi.fn();
  render(<PresentationPreview service={fixture()} previews={previews} busy={false} error="" onDownload={download} onClose={vi.fn()} onSelectPage={select} />);
  const navigation = within(screen.getByRole("navigation", { name: "幻灯片缩略图" }));
  expect(navigation.getByRole("button", { name: "预览第 1 页" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(navigation.getByRole("button", { name: "预览第 3 页" }));
  await screen.findByAltText("第 3 页预览");
  expect(select).toHaveBeenLastCalledWith("page-3:1");
  expect(navigation.getByRole("button", { name: "预览第 3 页" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Home" });
  await screen.findByAltText("第 1 页预览");
  expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  fireEvent.keyDown(document, { key: "End" });
  await screen.findByAltText("第 3 页预览");
  fireEvent.click(screen.getByRole("button", { name: "下载 PPTX" }));
  expect(download).toHaveBeenCalledOnce();
  // Native select navigation must not dispatch a second page change.
  select.mockClear();
  fireEvent.keyDown(screen.getByLabelText("选择幻灯片"), { key: "ArrowLeft" });
  expect(select).not.toHaveBeenCalled();
});

it("resolves remembered pages by artifact identity and handles changed or empty results", async () => {
  const service = fixture(), close = vi.fn();
  const props = { service, busy: false, error: "", onClose: close, initialPage: "page-2:1" };
  const result = render(<PresentationPreview {...props} previews={previews} />);
  await screen.findByAltText("第 2 页预览");
  result.rerender(<PresentationPreview {...props} previews={[previews[1], previews[2]]} />);
  await screen.findByAltText("第 1 页预览");
  await waitFor(() => expect(screen.getByAltText("第 1 页预览")).toHaveAttribute("src", "blob:page-2:1"));
  result.rerender(<PresentationPreview {...props} previews={[{ ...previews[2], version: 2 }]} />);
  await waitFor(() => expect(screen.getByAltText("第 1 页预览")).toHaveAttribute("src", "blob:page-3:2"));
  result.rerender(<PresentationPreview {...props} previews={[]} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
