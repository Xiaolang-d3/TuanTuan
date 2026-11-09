import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../../types";
import { ModelUsageRules } from "./ModelUsageRules";

afterEach(cleanup);
const catalog: ModelCatalog = {
  connections: [{ id: "shared", name: "我的服务", model_base_url: "https://example.test/v1", model_protocol: "auto", api_key_configured: true, enabled: true, revision: 1 }],
  profiles: [
    { id: "chat", connection_id: "shared", model_name: "chat-model", enabled: true, revision: 1, supported_purposes: ["chat"] },
    { id: "image", connection_id: "shared", model_name: "gpt-image-2", enabled: true, revision: 1, supported_purposes: ["image"] },
    { id: "video", connection_id: "shared", model_name: "sora-2", enabled: true, revision: 1, supported_purposes: [] }
  ], default_profile_id: "chat", purpose_defaults: { chat: "chat", image: null }, purpose_version: 4
};

describe("ModelUsageRules", () => {
  it("offers eligible models from every service and labels their source", () => {
    const second: ModelCatalog = { ...catalog, service_connection_id: "shared", connections: [...catalog.connections, { ...catalog.connections[0], id: "other", name: "第二服务" }], profiles: [...catalog.profiles, { ...catalog.profiles[1], id: "other-image", connection_id: "other" }] };
    render(<ModelUsageRules catalog={second} busy={false} loading={false} onMutate={vi.fn()} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "更换图片生成模型" }));
    expect(screen.getByRole("option", { name: /第二服务.*gpt-image-2|gpt-image-2.*第二服务/ })).toHaveValue("other-image");
  });
  it("shows summaries until editing, filters by purpose and cancels without saving", () => {
    const onMutate = vi.fn();
    render(<ModelUsageRules catalog={catalog} busy={false} loading={false} onMutate={onMutate} onApplied={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更换图片生成模型" }));
    expect(screen.getByRole("option", { name: /gpt-image-2/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /chat-model|sora-2/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "image" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
    expect(screen.getByText("暂未接入")).toBeInTheDocument();
  });
  it("saves only the edited purpose using its original version", async () => {
    const onMutate = vi.fn().mockResolvedValue(true);
    render(<ModelUsageRules catalog={catalog} busy={false} loading={false} onMutate={onMutate} onApplied={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "更换图片生成模型" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "image" } });
    fireEvent.click(screen.getByRole("button", { name: "保存图片生成规则" }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledWith("/agent/model-defaults/image", "POST", { profile_id: "image", expected_version: 4 }));
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
  });
  it("preserves the draft when the server rejects the save", async () => {
    render(<ModelUsageRules catalog={catalog} busy={false} loading={false} onMutate={vi.fn().mockResolvedValue(false)} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "更换聊天与工作模型" }));
    fireEvent.click(screen.getByRole("button", { name: "保存聊天与工作规则" }));
    expect(await screen.findByText(/保存未确认/)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("chat");
  });
});
