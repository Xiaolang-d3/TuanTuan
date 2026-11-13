import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionsPage } from "./ExtensionsPage";
import { SkillPicker } from "./SkillPicker";
import { ExtensionPreviewProvider } from "./ExtensionPreviewContext";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("extensions UI", () => {
  it("toggles the built-in PPT skill preview without opening a separate workbench", () => {
    render(<ExtensionPreviewProvider key="one"><ExtensionsPage /></ExtensionPreviewProvider>);
    expect(screen.getByRole("switch", { name: "停用 PPT Master" })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "停用 PPT Master" }));
    expect(screen.getByRole("switch", { name: "启用 PPT Master" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "启用 PPT Master" }));
    expect(screen.getByRole("switch", { name: "停用 PPT Master" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "体验流程" })).not.toBeInTheDocument();
  });

  it("supports keyboard tabs and a searchable empty state", () => {
    render(<ExtensionsPage />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /技能/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /插件/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /插件/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("搜索扩展"), { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的扩展")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("演示文稿工具包")).toBeInTheDocument();
  });

  it("opens details in a focused dialog and returns to the selected row", async () => {
    render(<ExtensionsPage />);
    const trigger = screen.getByRole("button", { name: "查看 PPT Master" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "PPT Master" });
    expect(within(dialog).getByText("在聊天中使用")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("guides a skill import from source selection through review and completion", async () => {
    render(<ExtensionsPage />);
    expect(screen.getByText(/尚未连接执行服务/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加技能" }));
    expect(screen.getByRole("heading", { name: "你准备好技能了吗？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /粘贴技能内容/ }));
    fireEvent.change(screen.getByLabelText("SKILL.md 内容"), { target: { value: "---\nname: 周报助手\ndescription: 汇总每周工作\n---\n整理材料" } });
    fireEvent.click(screen.getByRole("button", { name: "继续检查" }));
    expect(screen.getByRole("heading", { name: "确认技能内容" })).toBeInTheDocument();
    expect(screen.getByText("汇总每周工作")).toBeInTheDocument();
    expect(screen.getAllByText(/默认停用/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    expect(await screen.findByRole("heading", { name: "技能已导入" })).toBeInTheDocument();
    expect(screen.getByText(/回到聊天使用/)).toBeInTheDocument();
  });

  it("explains how to use an imported skill from its detail panel", async () => {
    render(<ExtensionsPage />);
    fireEvent.click(screen.getByRole("button", { name: "添加技能" }));
    fireEvent.click(screen.getByRole("button", { name: /粘贴技能内容/ }));
    fireEvent.change(screen.getByLabelText("SKILL.md 内容"), { target: { value: "---\nname: 周报助手\ndescription: 汇总每周工作\n---\n整理材料" } });
    fireEvent.click(screen.getByRole("button", { name: "继续检查" }));
    fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    expect(await screen.findByRole("heading", { name: "技能已导入" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看使用说明" }));
    expect(await screen.findByText("在聊天中使用")).toBeInTheDocument();
    expect(screen.getByText(/先在这里启用技能/)).toBeInTheDocument();
    expect(screen.getByText(/点输入框旁的“技能”/)).toBeInTheDocument();
  });

  it("validates MCP drafts and never shows a successful real connection", async () => {
    render(<ExtensionsPage />);
    fireEvent.click(screen.getByRole("tab", { name: /MCP/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "添加 MCP" })[0]);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "资料服务" } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "file:///secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP");
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "https://example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("资料服务")).toBeInTheDocument();
    expect(screen.getByText(/配置草稿 · 未连接/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /技能/ }));
    expect(screen.queryByText("资料服务")).not.toBeInTheDocument();
  });

  it("presents only skill icons and names without a separate normal conversation option", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      extensions: [{ id: "weekly", kind: "skill", name: "周报助手", description: "归纳每周工作并整理行动项", source: "user", enabled: true, permissions: [], user_invocable: true }],
      connections: [], execution: { available: false, reason: "执行环境未配置" }
    }), { status: 200 })));
    render(<ExtensionPreviewProvider apiBase="/api" accessToken="test-token"><SkillPicker selectedSkillId={null} onSelectSkill={() => undefined} /></ExtensionPreviewProvider>);
    fireEvent.click(screen.getByRole("button", { name: "技能" }));

    const picker = await screen.findByRole("region", { name: "可用技能" });
    const skill = await within(picker).findByRole("button", { name: "周报助手" });
    expect(within(picker).queryByRole("heading")).not.toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: "普通对话" })).not.toBeInTheDocument();
    expect(skill).toHaveAttribute("aria-pressed", "false");
    expect(within(picker).getByRole("list", { name: "可选技能" })).toHaveTextContent("周报助手");
    expect(skill.textContent).toBe("周报助手");
    expect(skill.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(skill).toHaveAttribute("title", "归纳每周工作并整理行动项");
    expect(within(picker).queryByText("归纳每周工作并整理行动项")).not.toBeInTheDocument();
    expect(within(picker).queryByText("已连接")).not.toBeInTheDocument();
    expect(within(picker).getByRole("link", { name: "管理技能" })).toHaveAttribute("href", "#/settings/extensions");
  });

  it("deselects the active skill by clicking its row again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      extensions: [{ id: "weekly", kind: "skill", name: "周报助手", description: "归纳每周工作", source: "user", enabled: true, permissions: [], user_invocable: true }],
      connections: [], execution: { available: false, reason: "执行环境未配置" }
    }), { status: 200 })));
    const onSelectSkill = vi.fn();
    render(<ExtensionPreviewProvider apiBase="/api" accessToken="test-session"><SkillPicker selectedSkillId="weekly" onSelectSkill={onSelectSkill} /></ExtensionPreviewProvider>);
    const trigger = screen.getByRole("button", { name: "技能" });
    fireEvent.click(trigger);
    const option = await screen.findByRole("button", { name: "周报助手" });
    expect(option).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(option);
    expect(onSelectSkill).toHaveBeenCalledWith(null);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("region", { name: "可用技能" })).not.toBeInTheDocument();
  });

  it("selects a skill from its list row and restores focus to the trigger", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      extensions: [{ id: "weekly", kind: "skill", name: "周报助手", description: "归纳每周工作", source: "user", enabled: true, permissions: [], user_invocable: true }],
      connections: [], execution: { available: false, reason: "执行环境未配置" }
    }), { status: 200 })));
    const onSelectSkill = vi.fn();
    render(<ExtensionPreviewProvider apiBase="/api" accessToken="test-token"><SkillPicker selectedSkillId={null} onSelectSkill={onSelectSkill} /></ExtensionPreviewProvider>);
    const trigger = screen.getByRole("button", { name: "技能" });
    fireEvent.click(trigger);
    const option = await screen.findByRole("button", { name: "周报助手" });
    fireEvent.click(option);
    expect(onSelectSkill).toHaveBeenCalledWith("weekly");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("region", { name: "可用技能" })).not.toBeInTheDocument();
  });
});
