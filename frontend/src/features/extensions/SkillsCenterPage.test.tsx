import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client";
import type { AgentCapabilities } from "../../types";
import type { StudioPreview } from "../product/imageStudioApi";
import { ExtensionPreviewProvider } from "./ExtensionPreviewContext";
import { SkillsCenterPage } from "./SkillsCenterPage";

const configured: AgentCapabilities = {
  configured: true, active_model_provider: "mock", active_model_name: "mock-chat", active_platform: "local",
  model_providers: [], platforms: [], tools: [],
};
const report = { id: "weekly", kind: "skill", name: "周报助手", source: "user", description: "整理周报", permissions: [], enabled: true, status: "installed", user_invocable: true };
const ppt = { ...report, id: "ppt-master", name: "PPT Master", source: "builtin", description: "制作演示文稿" };
const imageMissing: StudioPreview = { eligible: false, selection: null, comparison_key: null, requires_confirmation: false, reason_code: "credential_missing", candidates: [] };
const model = { profile_id: "image-model", model_name: "Mock Image", service_name: "Mock Service", eligible: true };
const imageReady: StudioPreview = {
  ...imageMissing, eligible: true, reason_code: null, comparison_key: "mock-image-key",
  selection: { ...model, reason: "default", sizes: ["1024x1024"] }, candidates: [model],
};

function setup({ live = true, capabilities = configured }: { live?: boolean; capabilities?: AgentCapabilities } = {}) {
  const onOpenSkill = vi.fn(async (_id: string) => {});
  const onOpenImage = vi.fn();
  const onOpenExtensions = vi.fn();
  const onOpenAgentSettings = vi.fn();
  const onOpenModelSettings = vi.fn();
  render(<ExtensionPreviewProvider apiBase={live ? "/service" : undefined} accessToken={live ? "test-token" : undefined}>
    <SkillsCenterPage apiBase="/service" accessToken="test-token" fetchJson={createApiClient("/service", "test-token")}
      conversationBusy={false} capabilities={capabilities} {...{ onOpenSkill, onOpenImage, onOpenExtensions, onOpenAgentSettings, onOpenModelSettings }} />
  </ExtensionPreviewProvider>);
  return { onOpenSkill, onOpenImage, onOpenExtensions, onOpenAgentSettings, onOpenModelSettings };
}

const imageCard = () => within(screen.getByRole("article", { name: "图片生成" }));
const inCard = async (name: string) => within(await screen.findByRole("article", { name }));
const imageAction = () => imageCard().getByRole("button", { name: "打开图片工作区" });
const skillAction = (card: ReturnType<typeof within>) => card.getByRole("button", { name: "在新对话中选择" });
const catalog = (extensions: unknown[], execution = { available: false, reason: "缺少隔离运行环境", adapter: "quick-ppt" }) => ({ extensions, connections: [], execution });

function mockReadiness(extensions: ReturnType<typeof catalog>, preview: StudioPreview) {
  const requests: [string, string, string | null][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push([url, init?.method ?? "GET", init?.body ? String(init.body) : null]);
    if (url === "/service/extensions") return Response.json(extensions);
    if (url === "/service/agent/model-selection/preview") return Response.json(preview);
    throw new Error(`Unexpected request: ${url}`);
  }));
  return requests;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads only real capabilities and disables unavailable skills with their dependencies", async () => {
  const requests = mockReadiness(catalog([
    { ...report, permissions: ["declared-example"] }, ppt,
    { ...report, id: "disabled", name: "停用技能", enabled: false },
    { ...report, id: "model-only", name: "模型专用", user_invocable: false },
    { ...report, id: "missing", name: "缺失技能", status: "dependency_missing", unavailable_reason: "技能包不可读" },
    { ...report, id: "plugin", name: "未执行插件", kind: "plugin" },
    { ...report, id: "preview", name: "预览数据", source: "example" },
  ]), imageMissing);
  const actions = setup();
  fireEvent.click(screen.getByRole("button", { name: "智能体设置" }));
  expect(actions.onOpenAgentSettings).toHaveBeenCalledOnce();
  expect(actions.onOpenSkill).not.toHaveBeenCalled();
  expect(imageAction()).toBeDisabled();
  expect(await imageCard().findByText(/缺少 API Key/)).toBeInTheDocument();
  expect(imageAction()).toBeDisabled();
  fireEvent.click(imageCard().getByRole("button", { name: "管理图片模型" }));
  expect(actions.onOpenModelSettings).toHaveBeenCalledWith("image");
  const weekly = await inCard("周报助手");
  expect(weekly.getByText("声明：declared-example。声明不等于授权。", { exact: false })).toBeInTheDocument();
  expect(skillAction(weekly)).toBeEnabled();
  const presentation = await inCard("PPT Master");
  expect(presentation.getByText("缺少隔离运行环境")).toBeInTheDocument();
  expect(skillAction(presentation)).toBeDisabled();
  for (const [name, reason] of [["停用技能", "已停用"], ["模型专用", "不可手动选择"], ["缺失技能", "技能包不可读"]]) {
    const card = await inCard(name);
    expect(card.getByText(reason)).toBeInTheDocument();
    expect(skillAction(card)).toBeDisabled();
    fireEvent.click(skillAction(card));
  }
  expect(screen.queryByRole("article", { name: /未执行插件|预览数据|视频/ })).not.toBeInTheDocument();
  expect(actions.onOpenSkill).not.toHaveBeenCalled();
  expect(actions.onOpenImage).not.toHaveBeenCalled();
  fireEvent.click(skillAction(weekly));
  expect(actions.onOpenSkill).toHaveBeenCalledWith("weekly");
  expect(requests).toHaveLength(2);
  expect(requests).toContainEqual(["/service/extensions", "GET", null]);
  expect(requests).toContainEqual(["/service/agent/model-selection/preview", "POST", JSON.stringify({ operation: "image.generate", profile_id: null })]);
});

it("uses the PPT runtime independently of the chat default and only hands off when opened", async () => {
  mockReadiness(catalog([report, ppt], { available: true, reason: "", adapter: "quick-ppt" }), imageReady);
  const actions = setup({ capabilities: { ...configured, configured: false, setup_message: "请设置文本模型" } });
  const weekly = await inCard("周报助手");
  expect(weekly.getByText("请设置文本模型")).toBeInTheDocument();
  expect(skillAction(weekly)).toBeDisabled();
  fireEvent.click(weekly.getByRole("button", { name: "管理对话模型" }));
  expect(actions.onOpenModelSettings).toHaveBeenCalledWith("chat");
  const presentation = await inCard("PPT Master");
  expect(presentation.getByText(/系统提取脱敏文本/)).toBeInTheDocument();
  expect(skillAction(presentation)).toBeEnabled();
  fireEvent.click(skillAction(presentation));
  expect(actions.onOpenSkill).toHaveBeenCalledWith("ppt-master");
  await waitFor(() => expect(imageAction()).toBeEnabled());
  fireEvent.click(imageAction());
  expect(actions.onOpenImage).toHaveBeenCalledOnce();
});

it("allows opening the existing image picker when an eligible alternate exists", async () => {
  mockReadiness(catalog([]), { ...imageMissing, candidates: [model] });
  const actions = setup();
  expect(await imageCard().findByText("需选择模型")).toBeInTheDocument();
  fireEvent.click(imageAction());
  expect(actions.onOpenImage).toHaveBeenCalledOnce();
  expect(await screen.findByText(/尚未安装对话技能/)).toBeInTheDocument();
});

it("does not offer previews or request admission without an authenticated service", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  setup({ live: false });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(imageAction()).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});
