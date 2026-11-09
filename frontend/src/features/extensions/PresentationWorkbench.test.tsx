import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresentationWorkbench } from "./PresentationWorkbench";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function confirmOutline() {
  fireEvent.change(screen.getByLabelText("演示主题"), { target: { value: "产品季度复盘" } });
  fireEvent.click(screen.getByRole("button", { name: "预览大纲" }));
  fireEvent.change(screen.getByLabelText("第 2 页标题"), { target: { value: "我们的进展" } });
}

describe("presentation preview lifecycle", () => {
  it("retains modal focus after a stage removes the focused button", async () => {
    render(<PresentationWorkbench onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("演示主题"), { target: { value: "季度复盘" } });
    const button = screen.getByRole("button", { name: "预览大纲" });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("edits the visible cover subtitle instead of hidden content points", async () => {
    vi.useFakeTimers();
    render(<PresentationWorkbench onClose={vi.fn()} />);
    confirmOutline();
    fireEvent.click(screen.getByRole("button", { name: "确认大纲，开始预览" }));
    await act(() => vi.runAllTimersAsync());
    fireEvent.click(screen.getByRole("button", { name: /查看第 1 页/ }));
    fireEvent.click(screen.getByRole("button", { name: "修改当前页" }));
    expect(screen.queryByLabelText("要点（每行一项，最多三项）")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("封面副标题"), { target: { value: "让团队看见每一步进展" } });
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    expect(screen.getByText("让团队看见每一步进展")).toBeInTheDocument();
  });

  it("requires outline confirmation, previews pages and applies local edits without a fake download", async () => {
    vi.useFakeTimers();
    render(<PresentationWorkbench onClose={vi.fn()} />);
    confirmOutline();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认大纲，开始预览" }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("heading", { name: "预览完成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 PPTX" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看第 2 页：我们的进展" }));
    fireEvent.click(screen.getByRole("button", { name: "修改当前页" }));
    fireEvent.change(screen.getByLabelText("页面标题"), { target: { value: "新的里程碑" } });
    fireEvent.change(screen.getByLabelText("要点（每行一项，最多三项）"), { target: { value: "完成首轮上线\n收到十条反馈" } });
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    expect(screen.getByRole("heading", { name: "新的里程碑" })).toBeInTheDocument();
    expect(screen.getByText("收到十条反馈")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("修改已应用到本地预览");
  });

  it("does not complete a cancelled run and can retry the preserved outline", async () => {
    vi.useFakeTimers();
    render(<PresentationWorkbench onClose={vi.fn()} />);
    confirmOutline();
    fireEvent.click(screen.getByRole("button", { name: "确认大纲，开始预览" }));
    fireEvent.click(screen.getByRole("button", { name: "取消预览" }));
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("heading", { name: "预览已取消" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "预览完成" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试预览" }));
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("heading", { name: "预览完成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看第 2 页：我们的进展" })).toBeInTheDocument();
  });

  it("shows an export error and retries once failure simulation is cleared", async () => {
    vi.useFakeTimers();
    render(<PresentationWorkbench onClose={vi.fn()} />);
    confirmOutline();
    fireEvent.click(screen.getByText("预览选项"));
    fireEvent.click(screen.getByRole("checkbox", { name: "模拟导出失败" }));
    fireEvent.click(screen.getByRole("button", { name: "确认大纲，开始预览" }));
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("alert")).toHaveTextContent("模拟导出失败");
    fireEvent.click(screen.getByRole("button", { name: "重试预览" }));
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("heading", { name: "预览完成" })).toBeInTheDocument();
  });

  it("keeps keyboard focus in the modal and cancels timers when unmounted", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<PresentationWorkbench onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "预览大纲" })).toHaveFocus();
    confirmOutline();
    fireEvent.click(screen.getByRole("button", { name: "确认大纲，开始预览" }));
    unmount();
    await act(() => vi.runAllTimersAsync());
    expect(vi.getTimerCount()).toBe(0);
  });
});
