import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationDialog } from "./ConversationDialog";

const conversation = {
  id: 1,
  title: "项目表达练习",
  status: "active" as const,
  summary: "",
  message_count: 4,
  task_status: "completed" as const,
  updated_at: "2026-08-11T00:00:00Z"
};

function pressBackdrop() {
  const backdrop = document.querySelector(".action-dialog-backdrop")!;
  fireEvent.mouseDown(backdrop, { button: 0 });
  fireEvent.mouseUp(backdrop, { button: 0 });
  fireEvent.click(backdrop, { button: 0 });
}

describe("ConversationDialog", () => {
  afterEach(cleanup);

  it("selects the current title, ignores unchanged/blank values, and saves a trimmed title without dismissing", async () => {
    const onRename = vi.fn();
    const onClose = vi.fn();
    render(<ConversationDialog dialog={{ kind: "rename", conversation }} onClose={onClose} onRename={onRename} onDelete={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "重命名对话" })).toHaveAccessibleDescription("用一个容易识别的名称保存这段准备。");
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "对话名称" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(conversation.title.length);
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "  " } });
    expect(save).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  项目复盘  " } });
    expect(save).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledExactlyOnceWith(conversation, "项目复盘");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks dismissal and saving while busy, then dismisses by Escape or the backdrop and restores the opener", async () => {
    const onRename = vi.fn();
    const onClose = vi.fn();
    function App({ busy }: { busy: boolean }) {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>更多对话操作</button>
        {open && <ConversationDialog dialog={{ kind: "rename", conversation }} busy={busy} onClose={() => {
          onClose();
          setOpen(false);
        }} onRename={onRename} onDelete={vi.fn()} />}
      </>;
    }
    const view = render(<App busy />);
    const opener = screen.getByRole("button", { name: "更多对话操作" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("textbox", { name: "对话名称" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "新名称" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    pressBackdrop();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(<App busy={false} />);
    expect(input).toHaveValue("新名称");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "对话名称" })).toHaveFocus());
    pressBackdrop();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses a protected alert dialog and leaves async deletion open until the caller finishes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onDelete = vi.fn(() => pending);
    const onClose = vi.fn();
    function App() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      return open && <ConversationDialog dialog={{ kind: "delete", conversation }} busy={busy} onClose={onClose} onRename={vi.fn()} onDelete={(target) => {
        setBusy(true);
        void onDelete().then(() => setOpen(false));
        expect(target).toEqual(conversation);
      }} />;
    }
    render(<App />);
    const dialog = screen.getByRole("alertdialog", { name: "删除对话" });
    expect(dialog).toHaveAccessibleDescription("删除“项目表达练习”后无法恢复。");
    const cancel = screen.getByRole("button", { name: "取消" });
    await waitFor(() => expect(cancel).toHaveFocus());
    pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();

    const remove = screen.getByRole("button", { name: "删除" });
    fireEvent.click(remove);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    expect(remove).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { finish(); });
    expect(dialog).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
