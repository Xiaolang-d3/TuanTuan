import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import type { ChatAttachment } from "./types";
const asset: ChatAttachment = { id: "source", origin: "generated", kind: "image", original_filename: "图片.png", parse_status: "parsed", width: 1024, height: 768 };
afterEach(cleanup);

it("does not issue edits until explicitly submitted and keeps timeout retries on the same operation", async () => {
  const edit = vi.fn().mockRejectedValue(new Error("请求超时"));
  render(<ImageEditor attachment={asset} url="blob:test" onEdit={edit} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "移除背景" }));
  expect(edit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "生成编辑版本" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "生成编辑版本" }));
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
  expect(edit.mock.calls[0][1].operation_id).toBe(edit.mock.calls[1][1].operation_id);
  expect(edit.mock.calls[0][1].mode).toBe("background");
});

it("locks source aspect ratio and publishes a new selectable version", async () => {
  const next = { ...asset, id: "edited" }, navigate = vi.fn();
  const edit = vi.fn().mockResolvedValue({ assets: [next], message_id: 2, conversation_id: 1 });
  render(<ImageEditor attachment={asset} url="blob:test" onEdit={edit} onNavigate={navigate} />);
  fireEvent.click(screen.getByRole("button", { name: "调整大小" }));
  fireEvent.change(screen.getByLabelText("宽度（像素）"), { target: { value: "800" } });
  expect(screen.getByLabelText("高度（像素）")).toHaveValue(600);
  fireEvent.click(screen.getByRole("button", { name: "保存尺寸调整" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(next));
  expect(edit.mock.calls[0][1]).toMatchObject({ mode: "resize", width: 800, height: 600 });
  expect(screen.getByRole("button", { name: "版本 1" })).toBeInTheDocument();
});

it("requires a selection for erasing and a description for general editing", () => {
  render(<ImageEditor attachment={asset} url="blob:test" onEdit={vi.fn()} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "标注" }));
  expect(screen.getByRole("button", { name: "生成编辑版本" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "改成橙色" } });
  expect(screen.getByRole("button", { name: "生成编辑版本" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "擦除" }));
  expect(screen.getByRole("button", { name: "生成编辑版本" })).toBeDisabled();
});


it("starts as an image and tool strip, revealing settings only for the selected tool", () => {
  const edit = vi.fn();
  render(<ImageEditor attachment={asset} url="blob:test" onEdit={edit} onNavigate={vi.fn()} />);
  expect(screen.getByRole("img", { name: "正在编辑的图片" })).toBeInTheDocument();
  expect(screen.queryByLabelText("修改要求")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "生成编辑版本" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "原图" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "标注" }));
  expect(screen.getByLabelText("修改要求")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "标注" }));
  expect(screen.queryByLabelText("修改要求")).not.toBeInTheDocument();
  expect(edit).not.toHaveBeenCalled();
});


it("returns to the chat immediately after submission while the edit is still pending", async () => {
  let finish!: (value: unknown) => void;
  const edit = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const submitted = vi.fn();
  render(<ImageEditor attachment={asset} url="blob:test" onEdit={edit} onNavigate={vi.fn()} onSubmitted={submitted} />);
  fireEvent.click(screen.getByRole("button", { name: "移除背景" }));
  fireEvent.click(screen.getByRole("button", { name: "生成编辑版本" }));
  expect(submitted).toHaveBeenCalledOnce();
  expect(edit).toHaveBeenCalledOnce();
  finish({ assets: [{ ...asset, id: 'new' }], message_id: 12, conversation_id: 4 });
  await screen.findByRole("button", { name: "版本 1" });
});
