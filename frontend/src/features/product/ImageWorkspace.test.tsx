import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageWorkspace } from "./ImageWorkspace";
import type { ImageWorkspaceProps } from "./ImageWorkspace";
import type { ChatAttachment } from "../chat/types";
import { downloadBlob } from "../chat/result-files";

vi.mock("../chat/result-files", () => ({ downloadBlob: vi.fn() }));

const asset: ChatAttachment = { id: "first", origin: "generated", kind: "image", original_filename: "第一张.png", parse_status: "parsed", width: 1024, height: 768 };
const otherAsset: ChatAttachment = { ...asset, id: "second", original_filename: "第二张.png" };

function props(overrides: Partial<ImageWorkspaceProps> = {}): ImageWorkspaceProps {
  return {
    ready: true,
    busy: false,
    error: null,
    images: [],
    hasConversation: false,
    onGenerate: vi.fn().mockResolvedValue(undefined),
    onOpenConversation: vi.fn(),
    onOpenSettings: vi.fn(),
    onLoadImage: vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: vi.fn().mockReturnValue("blob:generated"),
    revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("ImageWorkspace", () => {
  it("requires a nonempty description, inserts examples and submits the trimmed text", async () => {
    const callbacks = props();
    render(<ImageWorkspace {...callbacks} />);
    const input = screen.getByRole("textbox", { name: "画面描述" });
    const generate = screen.getByRole("button", { name: "生成图片" });
    expect(generate).toBeDisabled();
    fireEvent.change(input, { target: { value: "  \n " } });
    fireEvent.submit(input.closest("form")!);
    expect(callbacks.onGenerate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "童话插画" }));
    expect((input as HTMLTextAreaElement).value).toContain("小狐狸");
    fireEvent.change(input, { target: { value: "  海边的灯塔\n " } });
    fireEvent.click(generate);
    await waitFor(() => expect(callbacks.onGenerate).toHaveBeenCalledWith("海边的灯塔"));
    expect(input).toHaveValue("  海边的灯塔\n ");
    expect(screen.getByText("优先使用默认图片模型")).toBeInTheDocument();
    expect(screen.getByText("从一个想法开始")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下载原图/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置图片模型" }));
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("blocks repeated submissions and preserves a draft edited while a request fails", async () => {
    const request = deferred<void>();
    const callbacks = props({ onGenerate: vi.fn().mockReturnValue(request.promise) });
    render(<ImageWorkspace {...callbacks} />);
    const input = screen.getByRole("textbox", { name: "画面描述" });
    fireEvent.change(input, { target: { value: "第一版描述" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("button", { name: "正在生成…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在生成图片");
    fireEvent.submit(input.closest("form")!);
    expect(callbacks.onGenerate).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "继续编辑的草稿" } });
    await act(async () => { request.reject(new Error("生成失败，请检查模型")); });
    expect(screen.getByRole("alert")).toHaveTextContent("生成失败，请检查模型");
    expect(input).toHaveValue("继续编辑的草稿");
    expect(screen.getByRole("button", { name: "生成图片" })).toBeEnabled();
  });

  it("distinguishes preparation from generation and keeps a failed conversation accessible", () => {
    const callbacks = props({ ready: false, error: "连接中断，请在对话中核查", hasConversation: true });
    const view = render(<ImageWorkspace {...callbacks} />);
    fireEvent.change(screen.getByRole("textbox", { name: "画面描述" }), { target: { value: "一只小猫" } });
    expect(screen.getByRole("button", { name: "正在准备…" })).toBeDisabled();
    expect(screen.queryByText("正在生成图片，请稍候…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("连接中断，请在对话中核查");
    fireEvent.click(screen.getByRole("button", { name: "查看所属对话" }));
    expect(callbacks.onOpenConversation).toHaveBeenCalledOnce();
    view.rerender(<ImageWorkspace {...callbacks} ready busy error={null} />);
    expect(screen.getByRole("button", { name: "正在生成…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看所属对话" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "画面描述" })).toHaveValue("一只小猫");
    expect(callbacks.onGenerate).not.toHaveBeenCalled();
  });

  it("loads the authenticated original for preview and download", async () => {
    const blob = new Blob(["original"], { type: "image/png" });
    const load = vi.fn().mockResolvedValue(blob);
    const callbacks = props({ images: [asset], resultPrompt: "一幅海边画面", hasConversation: true, onLoadImage: load });
    const view = render(<ImageWorkspace {...callbacks} />);
    await screen.findByRole("img", { name: "第一张.png" });
    expect(load).toHaveBeenCalledWith(asset, expect.any(AbortSignal));
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(screen.getByText("1024 × 768")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看生成描述"));
    expect(screen.getByText("一幅海边画面")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下载原图 第一张.png" }));
    expect(downloadBlob).toHaveBeenCalledWith(blob, "第一张.png");
    const previewButton = screen.getAllByRole("button", { name: "查看原图 第一张.png" })[0];
    previewButton.focus();
    fireEvent.click(previewButton);
    const dialog = screen.getByRole("dialog", { name: "第一张.png 原图预览" });
    expect(within(dialog).getByRole("img", { name: "第一张.png" })).toHaveAttribute("src", "blob:generated");
    expect(within(dialog).getByRole("button", { name: "关闭原图预览" })).toHaveFocus();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "关闭原图预览" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(previewButton).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "查看所属对话" }));
    expect(callbacks.onOpenConversation).toHaveBeenCalledOnce();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated");
  });

  it("aborts replaced images, ignores late results and revokes the current URL", async () => {
    const first = deferred<Blob>(), second = deferred<Blob>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const callbacks = props({ images: [asset], onLoadImage: load });
    const view = render(<ImageWorkspace {...callbacks} />);
    const firstSignal = load.mock.calls[0][1] as AbortSignal;
    view.rerender(<ImageWorkspace {...callbacks} images={[otherAsset]} />);
    const secondSignal = load.mock.calls[1][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { first.resolve(new Blob(["late"])); await first.promise; });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByText("第一张.png")).not.toBeInTheDocument();
    const newBlob = new Blob(["new"]);
    await act(async () => { second.resolve(newBlob); await second.promise; });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(screen.getByRole("img", { name: "第二张.png" })).toBeInTheDocument();
    view.unmount();
    expect(secondSignal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated");
  });

  it("shows image loading errors and retries without losing the result", async () => {
    const blob = new Blob(["image"]);
    const load = vi.fn().mockRejectedValueOnce(new Error("读取原图失败")).mockResolvedValueOnce(blob);
    render(<ImageWorkspace {...props({ images: [asset], onLoadImage: load })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取原图失败");
    expect(screen.getByRole("button", { name: "下载原图 第一张.png" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("img", { name: "第一张.png" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "下载原图 第一张.png" })).toBeEnabled();
  });
});
