import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelOutputSettings } from "./ModelOutputSettings";
import type { ModelProfile } from "../../types";

afterEach(cleanup);
const profile = { id: "custom", connection_id: "shared", model_name: "custom-alias", enabled: true, revision: 3 };
it("shows capability controls only while editing and saves output abilities separately", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(<ModelOutputSettings profile={profile} busy={false} onSave={onSave} />);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "编辑能力" }));
  fireEvent.change(screen.getByLabelText("custom-alias 对话输出"), { target: { value: "supported" } });
  fireEvent.change(screen.getByLabelText("custom-alias 图片生成"), { target: { value: "unsupported" } });
  fireEvent.click(screen.getByRole("button", { name: "保存模型能力" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ chat: "supported", image_generation: "unsupported", video_generation: "unknown" }));
  await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
});
it("retains failed capability edits and refreshes untouched capabilities", async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true);
  const onDirtyChange = vi.fn();
  const onSavingChange = vi.fn();
  const initial: ModelProfile = { ...profile, capabilities: { chat: "supported", image_generation: "unknown" } };
  const { rerender } = render(<ModelOutputSettings profile={initial} busy={false} onSave={onSave} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑能力" }));
  fireEvent.change(screen.getByLabelText("custom-alias 图片生成"), { target: { value: "supported" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  rerender(<ModelOutputSettings profile={{ ...initial, revision: 4, capabilities: { chat: "unsupported", image_generation: "unknown", video_generation: "supported" } }} busy={false} onSave={onSave} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />);
  expect(screen.getByLabelText("custom-alias 对话输出")).toHaveValue("unsupported");
  expect(screen.getByLabelText("custom-alias 图片生成")).toHaveValue("supported");
  fireEvent.click(screen.getByRole("button", { name: "保存模型能力" }));
  expect(onSavingChange).toHaveBeenLastCalledWith(true);
  await screen.findByRole("alert");
  expect(screen.getByLabelText("custom-alias 图片生成")).toHaveValue("supported");
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "保存模型能力" }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ chat: "unsupported", image_generation: "supported", video_generation: "supported" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  expect(onSavingChange).toHaveBeenLastCalledWith(false);
});
it("disables capability editing for read-only and disabled models", () => {
  const onSave = vi.fn();
  const { rerender } = render(<ModelOutputSettings profile={{ ...profile, enabled: false }} busy={false} onSave={onSave} />);
  expect(screen.getByRole("button", { name: "编辑能力" })).toBeDisabled();
  rerender(<ModelOutputSettings profile={profile} busy={false} readOnly onSave={onSave} />);
  expect(screen.getByRole("button", { name: "编辑能力" })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
});
it("cancels without writing model capabilities", () => {
  const onSave = vi.fn();
  render(<ModelOutputSettings profile={profile} busy={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑能力" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
