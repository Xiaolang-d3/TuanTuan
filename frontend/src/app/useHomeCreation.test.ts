import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { createApiClient } from "../api/client";
import type { Conversation } from "../types";
import { useHomeCreation } from "./useHomeCreation";

afterEach(() => { cleanup(); sessionStorage.clear(); });

function setup() {
  const conversation: Conversation = { id: 11, title: "新对话", status: "active", summary: "", updated_at: "", model_profile_id: null };
  const fetchJson = vi.fn().mockResolvedValue(conversation);
  const options = {
    fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>,
    userEmail: "a@example.test", creationScope: "a", databaseReady: true, chatBusy: false,
    webSearchAvailable: true, selectNewConversationWebSearch: vi.fn(),
    clearChatMessages: vi.fn(), selectNewConversationSkill: vi.fn(), setErrorMessage: vi.fn(), setNoticeMessage: vi.fn(),
    navigateRoute: vi.fn(), currentConversationId: null as number | null, conversationBusy: false, setConversationBusy: vi.fn(),
    invalidateConversationReads: vi.fn(), setConversations: vi.fn(), selectConversation: vi.fn(),
  };
  const hook = renderHook(() => useHomeCreation(options));
  return { ...hook, options, conversation };
}

it("工作台对话输入直接进入待发送状态，不再作为输入框草稿", async () => {
  const { result, options, conversation } = setup();
  act(() => result.current.updateForm(form => ({ ...form, draft: "帮我写周报" })));
  act(() => result.current.openCreationWorkspace("帮我写周报"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(conversation.id));
  expect(result.current.autoSendDraft).toMatchObject({ conversationId: conversation.id, content: "帮我写周报" });
  expect(result.current.conversationDraft).toBeNull();
  expect(result.current.form.draft).toBe("");
  expect(options.setNoticeMessage).toHaveBeenCalledWith("");

  act(() => result.current.claimAutoSendDraft(result.current.autoSendDraft!.id, false));
  expect(result.current.autoSendDraft).toBeNull();
  expect(result.current.conversationDraft).toMatchObject({ content: "帮我写周报" });
});

it("带附件的对话仍交给输入框，由用户确认上传后发送", async () => {
  const { result, options } = setup();
  const file = new File(["x"], "资料.txt", { type: "text/plain" });
  act(() => result.current.setHomeFiles([file]));
  act(() => result.current.openCreationWorkspace("总结附件"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalled());
  expect(result.current.autoSendDraft).toBeNull();
  expect(result.current.conversationDraft).toMatchObject({ content: "总结附件" });
  expect(options.setNoticeMessage).toHaveBeenCalledWith("对话草稿已准备，编辑后发送");
});

it("生图描述同样进入对话直接发送，由团团生成图片", async () => {
  const { result, options, conversation } = setup();
  act(() => result.current.updateForm(form => ({ ...form, draft: "画一张雪山日出" })));
  act(() => result.current.openCreationWorkspace("画一张雪山日出"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(conversation.id));
  expect(result.current.autoSendDraft).toMatchObject({ content: "画一张雪山日出" });
  expect(result.current.form.draft).toBe("");
  expect(options.navigateRoute).not.toHaveBeenCalled();
});

it("恢复旧版按模式保存的工作台草稿", () => {
  sessionStorage.setItem("tuantuan-home-draft:a", JSON.stringify({ mode: "images", drafts: { chat: "", images: "海边灯塔" } }));
  const { result } = setup();
  expect(result.current.form.draft).toBe("海边灯塔");
  expect(result.current.form.webSearch).toBe(false);
});

it.each([false, true])("首页联网选择 %s 随首条消息交接，且在切换对话前保存", async enabled => {
  const { result, options, conversation } = setup();
  act(() => result.current.updateForm(form => ({ ...form, webSearch: enabled })));
  act(() => result.current.openCreationWorkspace("查找资料"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(conversation.id));
  expect(result.current.autoSendDraft).toMatchObject({ webSearch: enabled });
  expect(options.selectNewConversationWebSearch).toHaveBeenCalledWith(conversation.id, enabled);
  expect(options.selectNewConversationWebSearch.mock.invocationCallOrder[0]).toBeLessThan(options.selectConversation.mock.invocationCallOrder[0]);
});

it("附件草稿同样沿用联网选择", async () => {
  const { result, options, conversation } = setup();
  act(() => {
    result.current.updateForm(form => ({ ...form, webSearch: true }));
    result.current.setHomeFiles([new File(["x"], "资料.txt")]);
  });
  act(() => result.current.openCreationWorkspace("总结附件"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(conversation.id));
  expect(result.current.autoSendDraft).toBeNull();
  expect(options.selectNewConversationWebSearch).toHaveBeenCalledWith(conversation.id, true);
});

it("搜索服务不可用时不沿用草稿保存的开启状态", async () => {
  sessionStorage.setItem("tuantuan-home-draft:a", JSON.stringify({ webSearch: true }));
  const { result, options, rerender } = setup();
  options.webSearchAvailable = false;
  rerender();
  act(() => result.current.openCreationWorkspace("查找资料"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalled());
  expect(result.current.autoSendDraft).toMatchObject({ webSearch: false });
  expect(options.selectNewConversationWebSearch).toHaveBeenCalledWith(11, false);
});

it("联网选择随账号草稿恢复且互相隔离", () => {
  sessionStorage.setItem("tuantuan-home-draft:a", JSON.stringify({ draft: "查资料", webSearch: true }));
  const { result, options, rerender } = setup();
  expect(result.current.form.webSearch).toBe(true);
  options.creationScope = "b";
  rerender();
  expect(result.current.form.webSearch).toBe(false);
  options.creationScope = "a";
  rerender();
  expect(result.current.form.webSearch).toBe(true);
});

it("首页发起的对话沿用创作输入框，切换其他对话和账号时独立，刷新后恢复", async () => {
  const { result, options, rerender, unmount } = setup();
  act(() => result.current.openCreationWorkspace("写一份计划"));
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(11));
  options.currentConversationId = 11;
  rerender();
  expect(result.current.creationComposer).toBe(true);
  options.currentConversationId = 12;
  rerender();
  expect(result.current.creationComposer).toBe(false);
  options.currentConversationId = 11;
  options.creationScope = "b";
  rerender();
  expect(result.current.creationComposer).toBe(false);
  options.creationScope = "a";
  rerender();
  expect(result.current.creationComposer).toBe(true);
  unmount();
  const restored = setup();
  restored.options.currentConversationId = 11;
  restored.rerender();
  expect(restored.result.current.creationComposer).toBe(true);
});

it("项目或技能创建的会话不继承首页输入框", async () => {
  const { result, options, rerender } = setup();
  act(() => { void result.current.openNewChatDraft("技能任务", "已准备", "weekly"); });
  await waitFor(() => expect(options.selectConversation).toHaveBeenCalledWith(11));
  options.currentConversationId = 11;
  rerender();
  expect(result.current.creationComposer).toBe(false);
});
