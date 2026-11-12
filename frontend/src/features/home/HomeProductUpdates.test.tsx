import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeProductUpdates } from "./HomeProductUpdates";
import type { HomeWorkspaceResponse } from "./types";

function fixtureWorkspace(): HomeWorkspaceResponse {
  return {
    generated_at: "2026-10-08T02:00:00Z",
    conversations: { items: [], error: null },
    jobs: { running: [], pending_confirmations: [] },
    weixin: { connected: false, unread_count: 0 },
    changelog: { items: [], error: null },
    skills: { items: [], error: null },
    library_recent: { items: [], error: null }
  };
}

afterEach(() => { cleanup(); });

describe("HomeProductUpdates", () => {
  it("shows skeletons while the first workspace response is loading", () => {
    render(<HomeProductUpdates workspace={null} loading />);
    expect(screen.getByRole("status", { name: "团团动态加载中" })).toBeInTheDocument();
  });

  it("renders nothing when the workspace request failed", () => {
    const { container } = render(<HomeProductUpdates workspace={null} loading={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("expands and collapses changelog entries in place", () => {
    const workspace = fixtureWorkspace();
    workspace.changelog.items = [
      { category: "智能体", text: "支持更细粒度的工具调用权限配置。", version: "v1.2.0" },
      { category: "桌面端", text: "修复 Windows 下托盘菜单偶发失效的问题。", version: "v1.1.9" }
    ];
    render(<HomeProductUpdates workspace={workspace} loading={false} />);
    const card = screen.getByRole("heading", { name: "更新日志精选" }).closest("section")!;
    expect(within(card).getByText("智能体")).toBeInTheDocument();
    expect(within(card).getByText("v1.2.0")).toBeInTheDocument();
    const text = within(card).getByText("支持更细粒度的工具调用权限配置。");
    expect(text).toHaveClass("home-changelog-text--clamped");
    const toggle = within(card).getAllByRole("button", { name: "展开" })[0];
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("收起");
    expect(text).not.toHaveClass("home-changelog-text--clamped");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(text).toHaveClass("home-changelog-text--clamped");
  });

  it("shows at most six changelog entries and three skills", () => {
    const workspace = fixtureWorkspace();
    workspace.changelog.items = Array.from({ length: 7 }, (_, index) => ({ category: "智能体", text: `更新内容 ${index}`, version: `v1.${index}` }));
    workspace.skills.items = [
      { name: "浏览器自动化", summary: "打开网页、填表、截图一条龙。", source: "内置" },
      { name: "生成 PPT", summary: "从提纲直接生成演示文稿。", source: "官方" },
      { name: "翻译助手", summary: "多语言互译。", source: "社区" },
      { name: "多余的技能", summary: "不应显示。", source: "社区" }
    ];
    render(<HomeProductUpdates workspace={workspace} loading={false} />);
    const changelogCard = screen.getByRole("heading", { name: "更新日志精选" }).closest("section")!;
    expect(within(changelogCard).getAllByRole("button", { name: "展开" })).toHaveLength(6);
    expect(within(changelogCard).queryByText("更新内容 6")).not.toBeInTheDocument();
    const skillsCard = screen.getByRole("heading", { name: "新技能推荐" }).closest("section")!;
    const links = within(skillsCard).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute("href", "#/settings/extensions");
    expect(within(skillsCard).getByText("浏览器自动化")).toBeInTheDocument();
    expect(within(skillsCard).getByText("从提纲直接生成演示文稿。")).toBeInTheDocument();
    expect(within(skillsCard).getByText("内置")).toBeInTheDocument();
    expect(within(skillsCard).queryByText("多余的技能")).not.toBeInTheDocument();
  });

  it("guides empty states to the skill center", () => {
    render(<HomeProductUpdates workspace={fixtureWorkspace()} loading={false} />);
    expect(screen.getByText("暂时没有更新日志，新版本发布后会第一时间同步到这里。")).toBeInTheDocument();
    expect(screen.getByText("技能中心会持续上新，先看看已安装的技能。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开技能中心" })).toHaveAttribute("href", "#/settings/extensions");
  });

  it("shows block errors when the changelog or skills fail", () => {
    const workspace = fixtureWorkspace();
    workspace.changelog.error = "更新日志加载失败";
    workspace.skills.error = "技能加载失败";
    render(<HomeProductUpdates workspace={workspace} loading={false} />);
    expect(screen.getByText("更新日志加载失败")).toBeInTheDocument();
    expect(screen.getByText("技能加载失败")).toBeInTheDocument();
  });
});
