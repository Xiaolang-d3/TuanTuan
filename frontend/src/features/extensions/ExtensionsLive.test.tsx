import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionsPage } from "./ExtensionsPage";
import { ExtensionPreviewProvider } from "./ExtensionPreviewContext";
import { SkillPicker } from "./SkillPicker";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("discovers a remote skill, refreshes installed items and enables it for chat", async () => {
  let items: Array<Record<string, unknown>> = [];
  const origin = { repository: "acme/reports", commit: "a".repeat(40), path: "skills/report", skill_id: "weekly-report" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (url.includes("/skills/search?")) body = { skills: [{ name: "weekly-report", source: origin.repository, installs: 42, installed: false }] };
    else if (url.endsWith("/skills/preview")) body = { preview_id: "preview-1", ...origin, skills: [{ name: "weekly-report", path: origin.path, description: "在线周报", content: "真实正文", files: [] }], skipped: 0 };
    else if (url.endsWith("/skills/install")) {
      items = [{ id: "online-1", kind: "skill", name: "weekly-report", description: "在线周报", source: "github", origin, enabled: false, permissions: [], content: "真实正文" }];
      body = items[0];
    } else if (init?.method === "PATCH") { items = items.map(item => ({ ...item, enabled: true })); body = items[0]; }
    else body = url.endsWith("/extensions") ? { extensions: items, connections: [], execution: { available: false, reason: "缺少隔离环境" } } : items[0];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const select = vi.fn();
  render(<ExtensionPreviewProvider apiBase="/api" accessToken="test-session"><ExtensionsPage /><SkillPicker onSelectSkill={select} /></ExtensionPreviewProvider>);
  fireEvent.click(screen.getByRole("button", { name: "发现技能" }));
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览 weekly-report" }));
  expect(await screen.findByText("真实正文")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
  expect(await screen.findByText(/安装完成，当前为停用状态/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  fireEvent.click(screen.getByRole("button", { name: "已安装" }));
  expect(await screen.findByRole("switch", { name: "启用 weekly-report" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "查看 weekly-report" }));
  expect(await screen.findByRole("link", { name: "acme/reports" })).toHaveAttribute("href", `https://github.com/acme/reports/tree/${origin.commit}/skills/report`);
  fireEvent.click(within(screen.getByRole("dialog", { name: "weekly-report" })).getByRole("button", { name: "启用技能" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "启用技能" })).not.toBeInTheDocument());
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭窗口" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "停用 weekly-report" })).toBeChecked());
  fireEvent.click(screen.getByRole("button", { name: "技能" }));
  fireEvent.click(await screen.findByRole("button", { name: "weekly-report" }));
  expect(select).toHaveBeenCalledWith("online-1");
});

it("persists imported skills through the API and selects an enabled skill for chat", async () => {
  let items: Array<Record<string, unknown>> = [{ id: "model-only", kind: "skill", name: "仅模型调用", description: "禁止手动选中", source: "user", enabled: true, user_invocable: false, permissions: [] }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    if (method === "POST") items.push({ id: "server-skill", kind: "skill", name: "周报助手", description: "归纳工作", revision: "a".repeat(64), source: "user", enabled: false, status: "installed", permissions: [] });
    if (method === "PATCH") items = items.map((item) => ({ ...item, enabled: JSON.parse(String(init?.body)).enabled }));
    const body = url.endsWith("/extensions") ? { extensions: items, connections: [], execution: { available: false, reason: "缺少隔离环境" } } : items[0];
    return new Response(JSON.stringify(body), { status: method === "POST" ? 201 : 200 });
  }));
  const select = vi.fn();
  const content = <ExtensionPreviewProvider apiBase="/api" accessToken="test-session"><ExtensionsPage /><SkillPicker onSelectSkill={select} /></ExtensionPreviewProvider>;
  const first = render(content);
  expect(await screen.findByText("仅模型调用")).toBeInTheDocument();
  expect(screen.queryByText("PPT Master")).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "添加技能" })[0]);
  fireEvent.click(screen.getByRole("button", { name: /粘贴技能内容/ }));
  fireEvent.change(screen.getByLabelText("SKILL.md 内容"), { target: { value: "---\nname: 周报助手\ndescription: 归纳工作\n---\n正文" } });
  fireEvent.click(screen.getByRole("button", { name: "继续检查" }));
  fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
  expect(await screen.findByRole("heading", { name: "技能已导入" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "去启用" }));
  expect(await screen.findByText("周报助手")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("switch", { name: "启用 周报助手" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "停用 周报助手" })).toBeChecked());
  first.unmount();
  render(content);
  expect(await screen.findByText("周报助手")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "停用 周报助手" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "技能" }));
  expect(screen.queryByRole("button", { name: "仅模型调用" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "可用技能" })).getByRole("button", { name: /PPT Master.*制作 PPT/ })).toHaveAttribute("title", "缺少隔离环境");
  fireEvent.click(await screen.findByRole("button", { name: "周报助手" }));
  expect(select).toHaveBeenCalledWith("server-skill");
});
