import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMessageText } from "./messageCopy";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function setClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
}

function setExecCommand(command: unknown) {
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("copyMessageText", () => {
  it("writes the complete message with the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    setClipboard({ writeText });
    setExecCommand(execCommand);
    const message = "中文消息\n第二行\n```ts\nconst a = 1;\n```";
    await copyMessageText(message);
    expect(writeText).toHaveBeenCalledWith(message);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("uses the legacy copy command when the Clipboard API is unavailable", async () => {
    setClipboard(undefined);
    const previousFocus = document.createElement("button");
    document.body.appendChild(previousFocus);
    previousFocus.focus();
    const message = "完整消息\n第二行";
    const execCommand = vi.fn(() => {
      const selected = document.activeElement as HTMLTextAreaElement;
      expect(selected.tagName).toBe("TEXTAREA");
      expect(selected.value).toBe(message);
      expect(selected.selectionStart).toBe(0);
      expect(selected.selectionEnd).toBe(message.length);
      return true;
    });
    setExecCommand(execCommand);
    await copyMessageText(message);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(previousFocus);
  });

  it.each([
    ["returns false", () => false],
    ["throws", () => { throw new Error("unavailable"); }]
  ])("cleans up and reports failure when the legacy command %s", async (_name, command) => {
    setClipboard(undefined);
    const previousFocus = document.createElement("button");
    document.body.appendChild(previousFocus);
    previousFocus.focus();
    setExecCommand(command);
    await expect(copyMessageText("旧剪贴板不应被当成成功")).rejects.toThrow();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(previousFocus);
  });

  it.each([true, false])("restores a DOM text selection after legacy copy (success=%s)", async (success) => {
    setClipboard(undefined);
    const paragraph = document.createElement("p");
    paragraph.textContent = "保留选中的文字";
    document.body.appendChild(paragraph);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 2);
    range.setEnd(paragraph.firstChild!, 6);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const original = selection.toString();
    setExecCommand(() => success);
    if (success) await copyMessageText("消息");
    else await expect(copyMessageText("消息")).rejects.toThrow();
    expect(selection.toString()).toBe(original);
    expect(document.activeElement).toBe(button);
    selection.removeAllRanges();
  });

  it("restores an input selection after legacy copy", async () => {
    setClipboard(undefined);
    const editor = document.createElement("textarea");
    editor.value = "保留输入框的选区";
    document.body.appendChild(editor);
    editor.focus();
    editor.setSelectionRange(1, 4, "backward");
    setExecCommand(() => true);
    await copyMessageText("消息");
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(4);
    expect(editor.selectionDirection).toBe("backward");
  });

  it("does not bypass a denied Clipboard API write", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn();
    setClipboard({ writeText });
    setExecCommand(execCommand);
    await expect(copyMessageText("消息")).rejects.toThrow("denied");
    expect(execCommand).not.toHaveBeenCalled();
  });
});
