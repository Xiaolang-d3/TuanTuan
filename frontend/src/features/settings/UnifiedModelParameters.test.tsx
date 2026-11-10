import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnifiedModelParameters } from "./UnifiedModelParameters";

const profile = { id: "p1", connection_id: "c1", model_name: "test", enabled: true, revision: 1, parameters: { temperature: 0.5, max_output_tokens: 1000 }, context_limit: 8000 };
afterEach(cleanup);

it("refreshes untouched request fields while retaining changed fields and unknown parameters", async () => {
  const onSave = vi.fn().mockResolvedValue(false);
  const onDirtyChange = vi.fn();
  const { rerender } = render(<UnifiedModelParameters profile={profile} busy={false} onSave={onSave} onDirtyChange={onDirtyChange} />);
  screen.getByText("请求参数（可选）").closest("details")!.open = true;
  fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
  fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.9" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  rerender(<UnifiedModelParameters profile={{ ...profile, revision: 2, parameters: { temperature: 0.6, max_output_tokens: 2000, seed: 42 }, context_limit: 16000 }} busy={false} onSave={onSave} onDirtyChange={onDirtyChange} />);
  expect(screen.getByLabelText("温度")).toHaveValue("0.9");
  expect(screen.getByLabelText("最大输出 token")).toHaveValue("2000");
  expect(screen.getByLabelText("上下文限制")).toHaveValue("16000");
  fireEvent.submit(screen.getByRole("form", { name: "请求参数", hidden: true }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ parameters: { temperature: 0.9, max_output_tokens: 2000, seed: 42 }, context_limit: 16000 }));
  await screen.findByRole("alert", { hidden: true });
  expect(screen.getByLabelText("温度")).toHaveValue("0.9");
  fireEvent.click(screen.getByRole("button", { name: "取消参数修改", hidden: true }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("reports saving and clears dirty only on confirmed save", async () => {
  let finish!: (saved: boolean) => void;
  const onSave = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const onSavingChange = vi.fn();
  const onDirtyChange = vi.fn();
  render(<UnifiedModelParameters profile={profile} busy={false} onSave={onSave} onSavingChange={onSavingChange} onDirtyChange={onDirtyChange} />);
  screen.getByText("请求参数（可选）").closest("details")!.open = true;
  fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
  fireEvent.change(screen.getByLabelText("温度"), { target: { value: "1" } });
  fireEvent.submit(screen.getByRole("form", { name: "请求参数", hidden: true }));
  expect(onSavingChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByLabelText("温度")).toBeDisabled();
  finish(true);
  await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("does not edit a disabled model or a read-only preview", () => {
  const onSave = vi.fn();
  const { rerender } = render(<UnifiedModelParameters profile={{ ...profile, enabled: false }} busy={false} onSave={onSave} />);
  expect(screen.getByRole("button", { name: "编辑请求参数", hidden: true })).toBeDisabled();
  rerender(<UnifiedModelParameters profile={profile} busy={false} readOnly onSave={onSave} />);
  expect(screen.getByRole("button", { name: "编辑请求参数", hidden: true })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
});
