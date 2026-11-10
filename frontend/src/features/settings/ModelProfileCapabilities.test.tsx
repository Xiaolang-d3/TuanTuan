import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import type { ModelCatalog, ProfileCapabilityReport } from "../../types";
import { ModelConnectionManager } from "./ModelConnectionManager";
import { ModelProfileCapabilities } from "./ModelProfileCapabilities";

type Client = ReturnType<typeof createApiClient>;
afterEach(cleanup);

function capability(label: string, status: "supported" | "unsupported" | "unknown", source: "user" | "probe" | "litellm" | "heuristic" | "none") {
  return { status, source, detail: "测试数据", label, overridden: source === "user", probe_status: null, litellm_status: null };
}
function report(overrides: Partial<ProfileCapabilityReport["capabilities"]> = {}): ProfileCapabilityReport {
  return {
    profile_id: "p1", model_name: "claude-sonnet-4-5", protocol: "anthropic",
    capabilities: {
      vision: capability("视觉", "supported", "probe"),
      tools: capability("工具", "supported", "litellm"),
      reasoning: capability("推理", "supported", "litellm"),
      structured_output: capability("结构化输出", "unknown", "none"),
      pdf: capability("PDF", "supported", "litellm"),
      prompt_caching: capability("缓存", "supported", "litellm"),
      ...overrides
    },
    context_window: { tokens: 200000, source: "litellm" },
    max_output_tokens: { tokens: 64000, source: "litellm" },
    litellm_known: true,
    pricing: { input_per_million_usd: 3, output_per_million_usd: 15 }
  };
}

describe("ModelProfileCapabilities", () => {
  it("reports an in-flight override until it finishes", async () => {
    let finish!: (value: ProfileCapabilityReport) => void;
    const fetchJson = vi.fn().mockResolvedValueOnce(report()).mockImplementationOnce(() => new Promise<ProfileCapabilityReport>(resolve => { finish = resolve; }));
    const onSavingChange = vi.fn();
    render(<ModelProfileCapabilities profileId="p1" modelName="m" fetchJson={fetchJson as unknown as Client} disabled={false} onSavingChange={onSavingChange} />);
    fireEvent.change(await screen.findByLabelText("m 工具 能力"), { target: { value: "unsupported" } });
    expect(onSavingChange).toHaveBeenLastCalledWith(true);
    finish(report());
    await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
  });
  it("shows capability tags with their source and the context window", async () => {
    const fetchJson = vi.fn().mockResolvedValue(report());
    render(<ModelProfileCapabilities profileId="p1" modelName="claude-sonnet-4-5" fetchJson={fetchJson as unknown as Client} disabled={false} />);
    expect(await screen.findByText("支持 · 实测")).toBeInTheDocument();
    expect(screen.getAllByText("支持 · LiteLLM").length).toBe(4);
    expect(screen.getByText("200K")).toBeInTheDocument();
    expect(screen.getByText("64K")).toBeInTheDocument();
    expect(fetchJson).toHaveBeenCalledWith("/agent/model-profiles/p1/capabilities");
  });

  it("saves a manual override and clears it with 自动", async () => {
    const fetchJson = vi.fn()
      .mockResolvedValueOnce(report())
      .mockResolvedValueOnce(report({ tools: capability("工具", "unsupported", "user") }))
      .mockResolvedValueOnce(report());
    render(<ModelProfileCapabilities profileId="p1" modelName="m" fetchJson={fetchJson as unknown as Client} disabled={false} />);
    fireEvent.change(await screen.findByLabelText("m 工具 能力"), { target: { value: "unsupported" } });
    await screen.findByText("不支持 · 手动");
    expect(JSON.parse(fetchJson.mock.calls[1][1].body)).toEqual({ overrides: { tools: "unsupported" } });
    expect(fetchJson.mock.calls[1][1].method).toBe("PUT");
    fireEvent.change(screen.getByLabelText("m 工具 能力"), { target: { value: "" } });
    await waitFor(() => expect(JSON.parse(fetchJson.mock.calls[2][1].body)).toEqual({ overrides: { tools: null } }));
  });

  it("runs a live vision probe and shows its error", async () => {
    const fetchJson = vi.fn().mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(), probe_error: "图片输入检测超时，请重试" });
    render(<ModelProfileCapabilities profileId="p1" modelName="m" fetchJson={fetchJson as unknown as Client} disabled={false} />);
    await screen.findByText("200K");
    fireEvent.click(screen.getByRole("button", { name: "实测视觉" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("图片输入检测超时");
    expect(fetchJson.mock.calls[1][0]).toBe("/agent/model-profiles/p1/capabilities/probe");
  });
});

describe("ModelConnectionManager capability panel", () => {
  const catalog: ModelCatalog = {
    connections: [{ id: "c1", name: "主连接", model_base_url: "https://first.example.test/v1", model_protocol: "openai", api_key_configured: true, enabled: true, revision: 1 }],
    profiles: [{ id: "p1", connection_id: "c1", model_name: "deepseek-chat", enabled: true, revision: 1 }],
    default_profile_id: null
  };

  it("loads capabilities on demand and disables reasoning effort for non-reasoning models", async () => {
    const fetchJson = vi.fn().mockImplementation(async (path: string) => path.endsWith("/discover") ? { models: ["deepseek-chat"] } : report({ reasoning: capability("推理", "unsupported", "litellm") }));
    render(<ModelConnectionManager catalog={catalog} loading={false} busy={false} error="" fetchJson={fetchJson as unknown as Client}
      onReload={vi.fn()} onMutate={vi.fn().mockResolvedValue(true)} onDefaultChanged={vi.fn()} />);
    expect(fetchJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /主连接/ }));
    fireEvent.click(await screen.findByRole("button", { name: "deepseek-chat 设置" }));
    fireEvent.click(screen.getByText("更多选项"));
    await screen.findByText("200K");
    await waitFor(() => expect(screen.getByRole("option", { name: "深度" })).toBeDisabled());
    expect(screen.getByText(/此模型仅支持自动/)).toBeInTheDocument();
  });
});
