import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import type { ProfileCapabilityReport } from "../../types";
import { ComposerModelParameters, type ComposerModelSettings } from "./ComposerModelParameters";

const report = { protocol: "responses", capabilities: { reasoning: { status: "supported" } }, max_output_tokens: { tokens: 8192 } } as ProfileCapabilityReport;
function setup(overrides: Partial<ComposerModelSettings> = {}, disabled = false) {
  const settings: ComposerModelSettings = {
    profile: { id: "p1", connection_id: "c1", model_name: "test-model", revision: 4, enabled: true, parameters: { temperature: 0.5 } },
    fetchJson: vi.fn().mockResolvedValue(report) as unknown as ReturnType<typeof createApiClient>,
    onSave: vi.fn().mockResolvedValue(true), ...overrides
  };
  const view = render(<ComposerModelParameters settings={settings} disabled={disabled} />);
  return { settings, ...view };
}
afterEach(cleanup);

describe("ComposerModelParameters", () => {
  it("shows only thinking controls and saves only reasoning with the profile revision", async () => {
    const { settings } = setup();
    await screen.findByTitle(/思考越深入/);
    expect(screen.queryByLabelText("温度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("最大输出 token")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "high" } });
    await waitFor(() => expect(settings.onSave).toHaveBeenCalledWith("p1", 4, { reasoning_effort: "high" }));
    expect(settings.profile.parameters).toEqual({ temperature: 0.5 });
    expect(screen.getByText(/此模型全部对话/)).toBeInTheDocument();
  });

  it("clears only reasoning when choosing automatic, preserving other saved parameters", async () => {
    const { settings } = setup({ profile: { id: "p2", connection_id: "c1", model_name: "test", enabled: true, revision: 2, reasoning_effort: "high", parameters: { temperature: 0.6, max_output_tokens: 2048 } } });
    fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "" } });
    await waitFor(() => expect(settings.onSave).toHaveBeenCalledWith("p2", 2, { reasoning_effort: null }));
    expect(settings.profile.parameters).toEqual({ temperature: 0.6, max_output_tokens: 2048 });
  });

  it("keeps edits after a failed save and permits retry", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    setup({ onSave });
    fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "high" } });
    await screen.findByRole("alert");
    expect(screen.getByLabelText("思考程度")).toHaveValue("high");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it("retains failed thinking choices across revision refresh and retries with the latest revision", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onDirtyChange = vi.fn();
    const onSavingChange = vi.fn();
    const { settings, rerender } = setup({ onSave });
    rerender(<ComposerModelParameters settings={settings} disabled={false} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />);
    fireEvent.change(screen.getByLabelText("思考程度"), { target: { value: "high" } });
    await screen.findByRole("alert");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    // The alert can commit before the effect reports that saving has finished.
    await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
    rerender(<ComposerModelParameters settings={{ ...settings, profile: { ...settings.profile, revision: 5, reasoning_effort: "low" } }} disabled={false} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} />);
    expect(screen.getByLabelText("思考程度")).toHaveValue("high");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith("p1", 5, { reasoning_effort: "high" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("refreshes clean thinking choices and supports read-only preview", () => {
    const { settings, rerender } = setup();
    rerender(<ComposerModelParameters settings={{ ...settings, profile: { ...settings.profile, revision: 5, reasoning_effort: "low" } }} disabled={false} readOnly />);
    expect(screen.getByLabelText("思考程度")).toHaveValue("low");
    expect(screen.getByLabelText("思考程度")).toBeDisabled();
    expect(settings.onSave).not.toHaveBeenCalled();
  });

  it("disables unsupported reasoning levels but allows clearing an old value", async () => {
    setup({ fetchJson: vi.fn().mockResolvedValue({ ...report, capabilities: { reasoning: { status: "unsupported" } } }) as unknown as ReturnType<typeof createApiClient> });
    await screen.findByText(/此模型仅支持自动/);
    expect(screen.getByRole("option", { name: "深度" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "自动" })).not.toBeDisabled();
  });

  it("does not expose text parameter editing for image-only models", async () => {
    setup({ protocol: "images", fetchJson: vi.fn().mockResolvedValue({ ...report, protocol: "images" }) as unknown as ReturnType<typeof createApiClient> });
    expect(screen.getByLabelText("思考程度")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();
    await screen.findByText(/图片模型/);
  });
});
