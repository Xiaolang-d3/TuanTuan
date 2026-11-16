import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeWorkspaceBar } from "./HomeWorkspaceBar";
import type { HomeWorkspaceResponse } from "./types";

const now = new Date(2026, 9, 8, 12, 0, 0);

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("HomeWorkspaceBar", () => {
  it("shows skeletons while the first workspace response is loading", () => {
    render(<HomeWorkspaceBar workspace={null} loading error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getByRole("status", { name: "工作区加载中" })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("reports a failed first load and retries on demand", () => {
    const onRefresh = vi.fn();
    render(<HomeWorkspaceBar workspace={null} loading={false} error="工作区连接失败" now={now} onRefresh={onRefresh} />);
    expect(screen.getByRole("alert")).toHaveTextContent("工作区连接失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("links conversations to the chat, jobs to the task center, weixin to channels, and library rows to the library", () => {
    const workspace = fixtureWorkspace();
    workspace.conversations.items = [
      { id: 1, title: "周报整理", last_message_at: "2026-10-08T01:00:00Z", task_status: "active" },
      { id: 2, title: "方案讨论", last_message_at: null, task_status: "" }
    ];
    workspace.jobs.running = [
      { id: "j1", kind: "task", display_title: "整理资料", status: "running", created_at: "2026-10-08T00:30:00Z" },
      { id: "j2", kind: "task", display_title: "生成周报", status: "running", created_at: "2026-10-08T00:10:00Z" }
    ];
    workspace.jobs.pending_confirmations = [{ id: "j3", kind: "task", display_title: "确认执行方案", status: "pending", created_at: "2026-10-08T00:20:00Z" }];
    workspace.weixin = { connected: true, unread_count: 3 };
    workspace.library_recent.items = [{ id: 1, title: "架构笔记", kind: "note", created_at: "2026-10-07T02:00:00Z" }];
    render(<HomeWorkspaceBar workspace={workspace} loading={false} error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getByRole("link", { name: /周报整理/ })).toHaveAttribute("href", "#/chat/1");
    expect(screen.getByRole("link", { name: /整理资料/ })).toHaveAttribute("href", "#/settings/extensions");
    expect(screen.getByRole("link", { name: /确认执行方案/ })).toHaveAttribute("href", "#/settings/extensions");
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByText("2 个进行中")).toBeInTheDocument();
    const weixinCard = screen.getByRole("heading", { name: "微信" }).closest("section")!;
    expect(weixinCard).toHaveTextContent("有 3 条未读消息");
    expect(within(weixinCard).getByRole("link", { name: "去查看" })).toHaveAttribute("href", "#/settings/channels");
    expect(screen.getByRole("link", { name: /架构笔记/ })).toHaveAttribute("href", "#/chat/library");
  });

  it("caps conversations at three and jobs at five", () => {
    const workspace = fixtureWorkspace();
    workspace.conversations.items = Array.from({ length: 4 }, (_, index) => ({ id: index, title: `会话 ${index}`, last_message_at: null, task_status: "" }));
    workspace.jobs.running = Array.from({ length: 6 }, (_, index) => ({ id: `j${index}`, kind: "task", display_title: `任务 ${index}`, status: "running", created_at: null }));
    render(<HomeWorkspaceBar workspace={workspace} loading={false} error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getAllByRole("link", { name: /^会话 / })).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: /^任务 / })).toHaveLength(5);
  });

  it("shows block errors instead of broken lists", () => {
    const workspace = fixtureWorkspace();
    workspace.conversations.items = [{ id: 0, title: "会话 0", last_message_at: null, task_status: "" }];
    workspace.conversations.error = "会话加载失败";
    workspace.library_recent.error = "资料库加载失败";
    render(<HomeWorkspaceBar workspace={workspace} loading={false} error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getByText("会话加载失败")).toBeInTheDocument();
    expect(screen.getByText("资料库加载失败")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^会话 / })).not.toBeInTheDocument();
  });

  it("guides empty states to the matching entry points", () => {
    render(<HomeWorkspaceBar workspace={fixtureWorkspace()} loading={false} error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getByRole("heading", { name: "最近会话" }).querySelector(".lucide-message-circle")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始一个新会话" })).toHaveAttribute("href", "#/chat");
    expect(screen.getByRole("link", { name: "打开任务中心" })).toHaveAttribute("href", "#/settings/extensions");
    expect(screen.getByRole("link", { name: "绑定微信" })).toHaveAttribute("href", "#/settings/channels");
    expect(screen.getByRole("link", { name: "打开资料库" })).toHaveAttribute("href", "#/chat/library");
  });

  it("shows a quiet weixin state without unread messages", () => {
    const workspace = fixtureWorkspace();
    workspace.weixin = { connected: true, unread_count: 0 };
    render(<HomeWorkspaceBar workspace={workspace} loading={false} error={null} now={now} onRefresh={() => {}} />);
    expect(screen.getByText("暂无未读消息。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "微信设置" })).toHaveAttribute("href", "#/settings/channels");
  });

  it("prefers the live SSE weixin status over the workspace snapshot", () => {
    const workspace = fixtureWorkspace();
    workspace.weixin = { connected: true, unread_count: 3 };
    render(<HomeWorkspaceBar workspace={workspace} loading={false} error={null} now={now} onRefresh={() => {}} weixinLive={{ connected: true, unread_count: 7 }} />);
    const weixinCard = screen.getByRole("heading", { name: "微信" }).closest("section")!;
    expect(weixinCard).toHaveTextContent("有 7 条未读消息");
  });

  it("keeps cards visible during a background refresh", () => {
    const workspace = fixtureWorkspace();
    workspace.conversations.items = [{ id: 1, title: "周报整理", last_message_at: null, task_status: "" }];
    render(<HomeWorkspaceBar workspace={workspace} loading error={null} now={now} onRefresh={() => {}} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /周报整理/ })).toBeInTheDocument();
  });
});
