import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import { UnifiedModelInspector } from "./UnifiedModelInspector";

vi.mock("./ModelProfileCapabilities", () => ({ ModelProfileCapabilities: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>能力检测</button> }));
afterEach(cleanup);
const profile = { id: "p1", connection_id: "c1", model_name: "test", enabled: true, revision: 1, parameters: { temperature: 0.5 } };
const fetchJson = vi.fn().mockResolvedValue({ protocol: "responses", capabilities: { reasoning: { status: "supported" } } }) as unknown as ReturnType<typeof createApiClient>;

it("aggregates drafts, retains collapsed capability edits and saves with the latest revision", async () => {
  const onMutate = vi.fn().mockResolvedValue(false);
  const onDirtyChange = vi.fn();
  const onSavingChange = vi.fn();
  const props = { profile, fetchJson, busy: false, error: "", onMutate, onClose: vi.fn(), openCapabilities: true, onDirtyChange, onSavingChange };
  const { rerender } = render(<UnifiedModelInspector {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑能力" }));
  fireEvent.change(screen.getByLabelText("test 图片生成"), { target: { value: "supported" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  const capabilities = screen.getByText("高级能力与上下文").closest("details")!;
  capabilities.open = false;
  fireEvent(capabilities, new Event("toggle"));
  expect(screen.getByLabelText("test 图片生成")).toHaveValue("supported");
  rerender(<UnifiedModelInspector {...props} profile={{ ...profile, revision: 2, capabilities: { chat: "supported", vision: "unsupported" } }} />);
  capabilities.open = true;
  fireEvent(capabilities, new Event("toggle"));
  fireEvent.click(screen.getByRole("button", { name: "保存模型能力" }));
  await waitFor(() => expect(onMutate).toHaveBeenCalledWith("/agent/model-profiles/p1", "PATCH", { capabilities: { chat: "supported", vision: "unsupported", image_generation: "supported", video_generation: "unknown" }, expected_revision: 2 }));
  await screen.findByRole("alert");
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(onSavingChange.mock.calls.some(([value]) => value === true)).toBe(true);
  await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("retains request edits through thinking autosave and uses the refreshed revision", async () => {
  const onMutate = vi.fn().mockResolvedValue(true);
  const onDirtyChange = vi.fn();
  const props = { profile, fetchJson, busy: false, error: "", onMutate, onClose: vi.fn(), onDirtyChange };
  const { rerender } = render(<UnifiedModelInspector {...props} />);
  screen.getByText("请求参数（可选）").closest("details")!.open = true;
  fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
  fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.9" } });
  fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "high" } });
  await waitFor(() => expect(screen.getByLabelText("思考程度")).toBeEnabled());
  rerender(<UnifiedModelInspector {...props} profile={{ ...profile, revision: 2, reasoning_effort: "high", parameters: { temperature: 0.5, max_output_tokens: 2000 } }} />);
  expect(screen.getByLabelText("温度")).toHaveValue("0.9");
  expect(screen.getByLabelText("最大输出 token")).toHaveValue("2000");
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "保存请求参数" }));
  await waitFor(() => expect(onMutate).toHaveBeenLastCalledWith("/agent/model-profiles/p1", "PATCH", { parameters: { temperature: 0.9, max_output_tokens: 2000 }, context_limit: null, expected_revision: 2 }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it("blocks closing while saving and reports all parameter saves", async () => {
  let finish!: (value: boolean) => void;
  const onMutate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const onSavingChange = vi.fn();
  render(<UnifiedModelInspector profile={profile} fetchJson={fetchJson} busy={false} error="" onMutate={onMutate} onClose={vi.fn()} onSavingChange={onSavingChange} />);
  fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "high" } });
  expect(screen.getByRole("button", { name: "收起参数" })).toBeDisabled();
  expect(onSavingChange).toHaveBeenLastCalledWith(true);
  finish(true);
  await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
});

it("opens capability guidance and leaves disabled models and previews read-only", () => {
  const onMutate = vi.fn();
  const props = { profile, fetchJson, busy: false, error: "", onMutate, onClose: vi.fn(), openCapabilities: true };
  const { rerender } = render(<UnifiedModelInspector {...props} readOnly />);
  expect(screen.getByText("高级能力与上下文").closest("details")).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "编辑能力" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "能力检测" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("思考程度")).toBeDisabled();
  rerender(<UnifiedModelInspector {...props} profile={{ ...profile, enabled: false }} />);
  expect(screen.getByRole("button", { name: "编辑请求参数", hidden: true })).toBeDisabled();
  expect(screen.getByRole("button", { name: "编辑能力" })).toBeDisabled();
  expect(onMutate).not.toHaveBeenCalled();
});
