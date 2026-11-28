import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreationEntry } from "./CreationEntry";

afterEach(cleanup);

function props() {
  return {
    draft: "", files: [], onFiles: vi.fn(), onDraft: vi.fn(), onOpen: vi.fn(),
    onOpenVideo: vi.fn(), onOpenDocuments: vi.fn(), onOpenSkills: vi.fn(),
    voiceInput: { prepare: vi.fn(), open: vi.fn() }, ready: true, busy: false,
    webSearchAvailable: true, webSearchEnabled: false, onWebSearchChange: vi.fn(),
  };
}

it("shows a default-off web search toggle next to attachments and allows toggling both ways", () => {
  const options = props();
  const { rerender } = render(<CreationEntry {...options} />);
  const search = screen.getByRole("button", { name: "联网搜索" });
  expect(search.parentElement).toContainElement(screen.getByRole("button", { name: "添加资料" }));
  expect(search).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(search);
  expect(options.onWebSearchChange).toHaveBeenLastCalledWith(true);
  rerender(<CreationEntry {...options} webSearchEnabled />);
  expect(search).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(search);
  expect(options.onWebSearchChange).toHaveBeenLastCalledWith(false);
});

it("keeps the toggle visible but disabled when search is unavailable or the workspace is busy", () => {
  const options = props();
  const { rerender } = render(<CreationEntry {...options} webSearchEnabled webSearchAvailable={false} />);
  const search = screen.getByRole("button", { name: "联网搜索" });
  expect(search).toBeDisabled();
  expect(search).toHaveAttribute("aria-pressed", "false");
  expect(search).toHaveAttribute("title", "联网搜索服务未启用");
  fireEvent.click(search);
  expect(options.onWebSearchChange).not.toHaveBeenCalled();
  rerender(<CreationEntry {...options} busy />);
  expect(search).toBeDisabled();
  rerender(<CreationEntry {...options} ready={false} />);
  expect(search).toBeDisabled();
});

it("keeps an accessible icon-only attachment action and the model picker inside the input frame", () => {
  const options = props();
  render(<CreationEntry {...options} modelPicker={<button type="button">选择模型</button>} />);
  const attachment = screen.getByRole("button", { name: "添加资料" });
  expect(attachment).toHaveAttribute("title", "添加资料");
  expect(attachment.textContent).toBe("");
  const input = screen.getByRole("textbox", { name: "工作台草稿" });
  expect(input.closest("form")).toContainElement(screen.getByRole("button", { name: "选择模型" }));
});
