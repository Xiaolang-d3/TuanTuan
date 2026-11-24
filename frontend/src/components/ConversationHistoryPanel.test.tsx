import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationHistoryPanel,
  formatConversationTime,
  groupConversationsByTime
} from "./ConversationHistoryPanel";

const conversation = {
  id: 1,
  title: "项目表达练习",
  status: "active" as const,
  summary: "",
  message_count: 4,
  task_status: "completed" as const,
  updated_at: "2026-08-11T00:00:00Z"
};

function renderPanel(open = true) {
  const props = {
    conversations: [conversation],
    currentConversationId: 1,
    busy: false,
    open,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onRemove: vi.fn()
  };
  const view = render(<ConversationHistoryPanel {...props} />);
  return { ...props, view };
}

describe("ConversationHistoryPanel", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("searches titles and summaries, identifies the current conversation and clears an empty search with Escape", () => {
    const { view, ...props } = renderPanel();
    const longTitle = "很长的开发记录".repeat(12);
    view.rerender(<ConversationHistoryPanel {...props} conversations={[conversation, { ...conversation, id: 2, title: longTitle, summary: "Agent 工具研究" }]} />);
    expect(screen.getByTitle(conversation.title)).toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle(longTitle)).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "搜索对话标题、摘要或正文" });
    fireEvent.change(search, { target: { value: "agent" } });
    expect(screen.queryByTitle(conversation.title)).not.toBeInTheDocument();
    expect(screen.getByTitle(longTitle)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "没有这条对话" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配的对话");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("supports menu keyboard navigation and restores its trigger on Escape", async () => {
    const props = renderPanel();
    const trigger = screen.getByRole("button", { name: "项目表达练习 的更多操作" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const rename = screen.getByRole("menuitem", { name: "重命名" });
    const archive = screen.getByRole("menuitem", { name: "归档" });
    const remove = screen.getByRole("menuitem", { name: "删除" });
    await waitFor(() => expect(rename).toHaveFocus());
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    await waitFor(() => expect(archive).toHaveFocus());
    fireEvent.keyDown(archive, { key: "End" });
    await waitFor(() => expect(remove).toHaveFocus());
    fireEvent.keyDown(remove, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("renders the complete menu outside the short list and handles pointer actions there", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "项目表达练习 的更多操作" }));
    const menu = screen.getByRole("menu");
    expect(props.view.container.querySelector(".conversation-history-list")).not.toContainElement(menu);
    expect(screen.getByRole("complementary", { name: "对话记录" })).toContainElement(menu);
    const archive = screen.getByRole("menuitem", { name: "归档" });
    fireEvent.pointerDown(archive);
    expect(menu).toBeInTheDocument();
    fireEvent.click(archive);
    expect(props.onArchive).toHaveBeenCalledWith(conversation);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes an open row menu when the drawer closes", () => {
    const { view, ...props } = renderPanel();
    const trigger = screen.getByRole("button", { name: "项目表达练习 的更多操作" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    view.rerender(<ConversationHistoryPanel {...props} open={false} />);
    view.rerender(<ConversationHistoryPanel {...props} open />);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dismisses the menu when clicking outside it", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "项目表达练习 的更多操作" }));
    fireEvent.pointerDown(screen.getByRole("searchbox"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("creates a conversation from the chat-side history panel", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));

    expect(props.onCreate).toHaveBeenCalledOnce();
  });

  it("keeps conversation management actions in the right-panel menu", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "项目表达练习 的更多操作" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));

    expect(props.onArchive).toHaveBeenCalledWith(conversation);
  });

  it("stays closed until opened as a drawer", () => {
    renderPanel(false);

    expect(screen.queryByRole("button", { name: "新建对话" })).not.toBeInTheDocument();
  });

  it("closes the drawer from the panel header", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "关闭对话记录" }));

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("pins a conversation above the time groups and can unpin it", () => {
    const onTogglePin = vi.fn();
    const pinned = { ...conversation, id: 8, title: "固定项目" };
    const props = renderPanel();
    props.view.rerender(<ConversationHistoryPanel {...props} conversations={[conversation, pinned]} pinnedIds={[8]} onTogglePin={onTogglePin} />);
    expect(screen.getByRole("region", { name: "置顶" })).toContainElement(screen.getByTitle("固定项目"));
    fireEvent.click(screen.getByRole("button", { name: "固定项目 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
    expect(onTogglePin).toHaveBeenCalledWith(pinned);
  });

  it("keeps a conversation in its folder above the time groups", () => {
    const onAssign = vi.fn();
    const onCreateFolder = vi.fn();
    const props = renderPanel();
    props.view.rerender(<ConversationHistoryPanel {...props} folders={[{ id: "project", name: "项目" }]} folderAssignments={{ 1: "project" }} onAssignFolder={onAssign} onCreateFolder={onCreateFolder} />);
    expect(screen.getByRole("region", { name: "项目" })).toContainElement(screen.getByTitle("项目表达练习"));
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    fireEvent.change(screen.getByRole("textbox", { name: "文件夹名称" }), { target: { value: "求职" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreateFolder).toHaveBeenCalledWith("求职");
    fireEvent.click(screen.getByRole("button", { name: "项目表达练习 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出项目" }));
    expect(onAssign).toHaveBeenCalledWith(conversation, null);
  });

  it("shows conversations matched by message text from the server", async () => {
    const onSearch = vi.fn().mockResolvedValue([{ ...conversation, id: 9, title: "正文里的方案" }]);
    const props = renderPanel();
    props.view.rerender(<ConversationHistoryPanel {...props} onSearch={onSearch} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索对话标题、摘要或正文" }), { target: { value: "方案细节" } });
    expect(await screen.findByTitle("正文里的方案")).toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledWith("方案细节");
  });

  it("groups conversations by recency instead of a generic recent label", () => {
    const now = new Date(2026, 7, 13, 8, 0, 0);
    const groups = groupConversationsByTime([
      { ...conversation, id: 1, title: "今天的练习", updated_at: new Date(2026, 7, 13, 10, 20, 0).toISOString() },
      { ...conversation, id: 2, title: "昨天的复盘", updated_at: new Date(2026, 7, 12, 9, 0, 0).toISOString() },
      { ...conversation, id: 3, title: "更早的对话", updated_at: new Date(2026, 6, 1, 9, 0, 0).toISOString() }
    ], now);

    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "更早"]);
    expect(formatConversationTime(new Date(2026, 7, 13, 10, 20, 0).toISOString(), now)).toMatch(/10:20/);
  });
});
