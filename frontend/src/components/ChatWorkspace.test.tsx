import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import type { AgentRunResult, ChatMessage, ChatRetryDraft, ChatAttachment, ChatComposerDraft, ChatWorkspaceProps } from "../features/chat/types";
import type { DocumentReviewService } from "../features/chat/document-review-service";
import type { DocumentService, SavedDocument } from "../features/chat/document-service";
import { ExtensionPreviewProvider } from "../features/extensions/ExtensionPreviewContext";

it("edits a text answer as a document while retaining the composer draft", async () => {
  const mixed = assistantMessage("整体回答");
  const doc: SavedDocument = { document_id: "d".repeat(32), version: 1, latest_version: 1, parent_document_version: null, conversation_id: 1, message_id: 12, title: "图文", markdown: "开头\n\n![图](resources/image.png)\n\n结尾", evidence: [], resources: [], citations: [], incomplete: false, created_at: "2026-11-09" };
  const documents = { create: vi.fn().mockResolvedValue(doc), latest: vi.fn().mockResolvedValue(doc), versions: vi.fn().mockResolvedValue({ versions: [{ version: 1, parent_document_version: null, created_at: doc.created_at }] }) } as unknown as DocumentService;
  const p = renderChat([message, mixed], { documentService: documents, onLoadResults: vi.fn().mockResolvedValue({ message_id: 12, snapshot: "a".repeat(64), incomplete: false, artifacts: [{ selector: "answer", kind: "answer", filename: "回答.md", mime_type: "text/markdown", content: "开头和结尾", can_index: true }] }) });
  const input = screen.getByRole("textbox", { name: "输入消息" });
  fireEvent.change(input, { target: { value: "不能丢失的聊天草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "编辑文档" }));
  expect(await screen.findByRole("textbox", { name: "文档正文" })).toHaveValue(doc.markdown);
  expect(p.onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭成果" }));
  expect(input).toHaveValue("不能丢失的聊天草稿");
});

const voiceCaptureMocks = vi.hoisted(() => ({
  supported: false,
  onLevel: null as ((level: number) => void) | null,
  emit: null as ((audio: Blob) => void) | null,
  close: vi.fn()
}));
vi.mock("../features/chat/voiceCapture", () => ({
  voiceCaptureSupported: () => voiceCaptureMocks.supported,
  VOICE_CHUNK_MS: 400,
  createVoiceCapture: (emit: (audio: Blob) => void, _onError: unknown, onLevel: (level: number) => void) => {
    voiceCaptureMocks.onLevel = onLevel;
    voiceCaptureMocks.emit = emit;
    return { start: async () => undefined, close: voiceCaptureMocks.close };
  }
}));

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn()
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn()
});

const conversation = {
  id: 1,
  title: "围绕一个项目追问我",
  status: "active" as const,
  summary: "",
  message_count: 1,
  task_status: "completed" as const,
  updated_at: "2026-08-11T00:00:00Z"
};

const message: ChatMessage = {
  id: 11,
  role: "user",
  content: "围绕一个项目追问我",
  created_at: "2026-08-11T00:00:00Z"
};

function assistantMessage(content: string, id = 12): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    created_at: "2026-08-11T00:01:00Z"
  };
}


function fencedMermaid(source: string): string {
  return ["```mermaid", source, "```"].join("\n");
}

function renderChat(messages: ChatMessage[] = [message], extras: {
  documentService?: DocumentService;
  onEditDocument?: ChatWorkspaceProps["onEditDocument"];
  documentReviewService?: DocumentReviewService;
  voiceInput?: ChatWorkspaceProps["voiceInput"];
  onLoadResults?: ChatWorkspaceProps["onLoadResults"];
  onSaveResult?: ChatWorkspaceProps["onSaveResult"];
  onLoadAttachment?: ChatWorkspaceProps["onLoadAttachment"];
  density?: "page" | "dock";
  chatBusy?: boolean;
  latestAgent?: AgentRunResult;
  retryDraft?: ChatRetryDraft | null;
  modelSelectionFeedback?: ChatWorkspaceProps["modelSelectionFeedback"];
  onDismissModelSelectionFeedback?: () => void;
  modelChecking?: boolean;
  modelUnavailable?: string;
  sendError?: string;
  modelConfigured?: boolean;
  currentModelName?: string;
  taskCancelBusy?: boolean;
  libraryAttachments?: { conversationId: number; attachments: ChatAttachment[] };
  onLibraryAttachmentsConsumed?: () => void;
  composerDraft?: ChatComposerDraft;
  onComposerDraftConsumed?: () => void;
  composerDrafts?: Map<number, string>;
  onPersistComposerDrafts?: () => void;
  onDeleteTurn?: ChatWorkspaceProps["onDeleteTurn"];
  onExportConversation?: () => void;
  replacementUndo?: ChatWorkspaceProps["replacementUndo"];
  onUndoReplacement?: () => Promise<void>;
  quickPpt?: boolean;
} = {}) {
  const props = {
    documentService: extras.documentService,
    onEditDocument: extras.onEditDocument,
    documentReviewService: extras.documentReviewService,
    voiceInput: extras.voiceInput,
    onLoadResults: extras.onLoadResults,
    onSaveResult: extras.onSaveResult,
    onLoadAttachment: extras.onLoadAttachment,
    libraryAttachments: extras.libraryAttachments,
    onLibraryAttachmentsConsumed: extras.onLibraryAttachmentsConsumed,
    composerDraft: extras.composerDraft,
    onComposerDraftConsumed: extras.onComposerDraftConsumed,
    density: extras.density,
    modelSelectionFeedback: extras.modelSelectionFeedback,
    onDismissModelSelectionFeedback: extras.onDismissModelSelectionFeedback,
    modelChecking: extras.modelChecking,
    modelUnavailable: extras.modelUnavailable,
    sendError: extras.sendError,
    modelConfigured: extras.modelConfigured,
    currentModelName: extras.currentModelName,
    onOpenModelSettings: vi.fn(),
    conversationTitle: conversation.title,
    messages,
    hiddenMessageCount: 0,
    chatBusy: extras.chatBusy ?? false,
    currentConversationId: conversation.id,
    onWebSearchChange: vi.fn(),
    conversations: [conversation],
    conversationBusy: false,
    waitingForUser: false,
    latestAgent: extras.latestAgent ?? [...messages].reverse().find((item) => item.role === "assistant")?.payload?.agent,
    taskCancelBusy: extras.taskCancelBusy ?? false,
    retryDraft: extras.retryDraft ?? null,
    chatEndRef: createRef<HTMLDivElement>(),
    chatInputRef: createRef<HTMLTextAreaElement>(),
    onLoadMore: vi.fn(),
    onSelectConversation: vi.fn(),
    onCreateConversation: vi.fn(),
    onRenameConversation: vi.fn(),
    onArchiveConversation: vi.fn(),
    onRemoveConversation: vi.fn(),
    attachmentBusy: false,
    attachmentConfig: null,
    onUploadAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onAttachmentInvalid: vi.fn(),
    onSuggestedAction: vi.fn(),
    onCancelTask: vi.fn(),
    onSend: vi.fn(),
    onRetry: vi.fn(),
    onStop: vi.fn(),
    onEdit: vi.fn(),
    onRegenerate: vi.fn(),
    onOpenLibrary: vi.fn(),
    composerDrafts: extras.composerDrafts,
    onPersistComposerDrafts: extras.onPersistComposerDrafts,
    onDeleteTurn: extras.onDeleteTurn,
    onExportConversation: extras.onExportConversation,
    replacementUndo: extras.replacementUndo,
    onUndoReplacement: extras.onUndoReplacement
  };
  const view = render(extras.quickPpt ? <ExtensionPreviewProvider apiBase="/api" accessToken="ppt-test-session"><ChatWorkspace {...props} selectedSkillId="ppt-master" /></ExtensionPreviewProvider> : <ChatWorkspace {...props} />);
  return { ...props, view };
}

describe("ChatWorkspace", () => {
  it.each(["主题", "仅上传资料"])("sends a quick PPT from the normal composer: %s", async mode => {
    const topic = mode === "主题" ? "智能体架构设计" : "";
    const attachment: ChatAttachment = { id: "ppt-source", original_filename: "讲稿.docx", kind: "document", parse_status: "parsed" };
    const calls: Array<{ topic: string; attachment_ids: string[]; conversation_id: number; idempotency_key: string }> = [];
    const job = { id: "quick-ppt-result", kind: "ppt.quick_generate", topic, source_count: topic ? 0 : 1, status: "queued", stage: "queued", revision: 1, conversation_id: 1, confirmation_required: false };
    const fetchPpt = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const path = String(url);
      if (path.includes("/quick/capabilities")) return Response.json({ composer: true, available: true, code: "ready", reason: "" });
      if (path.endsWith("/presentations/quick")) {
        calls.push(JSON.parse(String(options?.body)));
        if (calls.length === 1) return Response.json({ detail: "服务暂未响应" }, { status: 503 });
        return Response.json(job, { status: 201 });
      }
      if (path.includes("/presentations?")) return Response.json({ jobs: calls.length > 1 ? [job] : [], next_cursor: null });
      return Response.json({ extensions: [], connections: [], execution: { available: true, reason: "" } });
    });
    try {
      const chat = renderChat([], { quickPpt: true, libraryAttachments: topic ? undefined : { conversationId: 1, attachments: [attachment] } });
      const workspace = within(chat.view.container);
      const input = workspace.getByRole("textbox", { name: "输入消息" });
      if (topic) fireEvent.change(input, { target: { value: topic } });
      expect(workspace.queryByRole("form", { name: "PPT 制作要求" })).not.toBeInTheDocument();
      const send = workspace.getByRole("button", { name: "生成 PPT" });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
      expect(await workspace.findByRole("alert")).toHaveTextContent("服务暂未响应");
      expect(input).toHaveValue(topic);
      if (!topic) expect(workspace.getByRole("button", { name: "移除 讲稿.docx" })).toBeInTheDocument();
      if (topic) fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      else fireEvent.click(send);
      expect(await workspace.findByRole("article", { name: `PPT：${topic || "从资料制作 PPT"}` })).toBeInTheDocument();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[0]).toMatchObject({ topic, attachment_ids: topic ? [] : [attachment.id], conversation_id: 1 });
      expect(input).toHaveValue("");
      expect(workspace.queryByRole("button", { name: "移除 讲稿.docx" })).not.toBeInTheDocument();
      expect(chat.onSend).not.toHaveBeenCalled();
    } finally { fetchPpt.mockRestore(); }
  });

  it("starts explicit whole-document review of a history attachment without sending a chat message", async () => {
    const target = { source_kind: "attachment" as const, attachment_id: "document-one", source_revision: "a".repeat(64) };
    const service = { list: vi.fn().mockResolvedValue({ jobs: [] }), prepareAttachment: vi.fn().mockResolvedValue(target),
      create: vi.fn().mockResolvedValue({ id: "review", kind: "document.review", status: "queued", revision: 1, request: { target, conversation_id: 1 }, checkpoint: {}, cancel_requested: false }) } as unknown as DocumentReviewService;
    const p = renderChat([{ ...message, payload: { attachments: [{ id: "document-one", kind: "document", original_filename: "资料.txt", parse_status: "parsed" }] } }], { documentReviewService: service });
    fireEvent.click(await screen.findByText("全文审阅"));
    fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
    await waitFor(() => expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ target, conversation_id: 1 })));
    expect(p.onSend).not.toHaveBeenCalled();
  });
  it.each(["", "   \n  "])("explains a disabled empty send with a hover hint (%j)", async (draft) => {
    const props = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    if (draft) fireEvent.change(input, { target: { value: draft } });
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "找不到发送的内容");
    expect(send.parentElement).toHaveAttribute("title", "找不到发送的内容");
    fireEvent.click(send);
    expect(screen.queryByText("找不到发送的内容")).not.toBeInTheDocument();
    expect(props.onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue(draft);
    fireEvent.change(input, { target: { value: "你好" } });
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute("title", "发送消息");
    expect(send.parentElement).toHaveAttribute("title", "发送消息");
    fireEvent.click(send);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("你好", [], [], false));
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  it.each([{ state: "empty", messages: [] }, { state: "history", messages: [message] }])("keeps extension tools below the editor without submitting or clearing its draft ($state)", ({ messages }) => {
    const props = renderChat(messages);
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "整理这周的资料" } });
    const tools = screen.getByRole("group", { name: "技能与外部工具" });
    expect(input.closest("form")).not.toContainElement(tools);
    expect(within(tools).getByRole("link", { name: "外部连接" })).toHaveAttribute("href", "#/settings/extensions");
    const skill = within(tools).getByRole("button", { name: "技能" });
    fireEvent.click(skill);
    expect(screen.getByRole("region", { name: "可用技能" })).toBeInTheDocument();
    fireEvent.keyDown(skill, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "可用技能" })).not.toBeInTheDocument();
    expect(input).toHaveValue("整理这周的资料");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("shows dismissible model selection feedback in the composer", () => {
    const dismiss = vi.fn();
    const { view, ...props } = renderChat([message], { modelSelectionFeedback: { kind: "success", text: "已切换至图片模型" }, onDismissModelSelectionFeedback: dismiss });
    expect(within(screen.getByRole("log")).getByText("已切换至图片模型").closest("[role=status]")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭模型切换提示" }));
    expect(dismiss).toHaveBeenCalledOnce();
    view.rerender(<ChatWorkspace {...props} modelSelectionFeedback={{ kind: "error", text: "未能确认切换" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("未能确认切换");
  });

  it("shows image-only messages without an empty text bubble and keeps the caption outside preview", () => {
    const attachment: ChatAttachment = { id: "photo", kind: "image", original_filename: "示意图.png", parse_status: "parsed", vision_status: "consented" };
    const { view } = renderChat([{ ...message, content: "", payload: { attachments: [attachment] } }]);
    const userMessage = view.container.querySelector(".message.user")!;
    expect(userMessage.querySelector(".message-dialog")).toBeNull();
    const preview = screen.getByRole("button", { name: "预览 示意图.png" });
    expect(preview).not.toHaveTextContent("示意图.png");
    expect(screen.getByText("示意图.png")).toHaveAttribute("title", "示意图.png");
    expect(screen.getByText("模型看图")).toBeInTheDocument();
    expect(within(userMessage as HTMLElement).getByRole("button", { name: "编辑消息" })).toBeEnabled();
  });

  it("sends a natural image request directly without a design form or rewriting the prompt", async () => {
    const p = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    const prompt = "生成一张小猫玩小鱼玩具图，暖色光线，横向构图";
    expect(screen.queryByRole("button", { name: "Banner 设计台" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Banner 设计台" })).not.toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "直接说说你的想法…");
    fireEvent.change(input, { target: { value: prompt } });
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^发送$/ }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith(prompt, [], [], false));
    expect(p.onSend).toHaveBeenCalledTimes(1);
  });

  it("puts image save and download icons in the reply actions and keeps dimensions out of the thread", () => {
    const asset: ChatAttachment = { id: "generated", origin: "generated", kind: "image", original_filename: "生成图片.png", parse_status: "parsed", width: 1024, height: 1536 };
    const pure: ChatMessage = { ...assistantMessage(""), payload: { agent: { provider: "responses", platform: "local", rounds: 1, status: "done", events: [], assets: [asset], output_blocks: [{ type: "image", asset_id: asset.id }] } } };
    renderChat([message, pure], { onLoadResults: vi.fn(), onLoadAttachment: vi.fn(), onEditDocument: vi.fn() });
    expect(screen.getAllByRole("button", { name: "预览 生成图片.png" })).toHaveLength(1);
    expect(screen.queryByText("1024 × 1536")).not.toBeInTheDocument();
    const actions = within(screen.getByRole("button", { name: "复制图片" }).parentElement!);
    expect(screen.queryByRole("button", { name: "复制回答" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑文档" })).not.toBeInTheDocument();
    fireEvent.click(actions.getByLabelText("保存图片"));
    expect(actions.getByRole("button", { name: "保存到文件库" })).toBeVisible();
    expect(actions.getByRole("button", { name: "下载原图" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "导出 PNG" })).not.toBeInTheDocument();
  });

  it("can select the second image to save from a reply with multiple images", async () => {
    const first: ChatAttachment = { id: "first", origin: "generated", kind: "image", original_filename: "第一张.png", parse_status: "parsed" };
    const second = { ...first, id: "second", original_filename: "第二张.webp" };
    const reply: ChatMessage = { ...assistantMessage(""), payload: { agent: { provider: "responses", platform: "local", rounds: 1, status: "done", events: [], assets: [first, second] } } };
    const load = vi.fn().mockResolvedValue({ message_id: 12, snapshot: "a".repeat(64), incomplete: false, artifacts: [
      { selector: "asset:first", kind: "image", filename: first.original_filename, mime_type: "image/png", asset: first, can_index: false },
      { selector: "asset:second", kind: "image", filename: second.original_filename, mime_type: "image/webp", asset: second, can_index: false },
    ] });
    renderChat([message, reply], { onLoadResults: load, onSaveResult: vi.fn() });
    const trigger = screen.getByLabelText("图片操作");
    expect(trigger.parentElement).not.toHaveAttribute("open");
    fireEvent.click(trigger);
    expect(trigger.parentElement).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "保存 第二张.webp 到文件库" }));
    const dialog = await screen.findByRole("dialog", { name: "聊天成果" });
    expect(await within(dialog).findByRole("textbox", { name: "文件名" })).toHaveValue(second.original_filename);
  });

  it("shows the saved generation prompt for the matching image instead of reconstructing it from a repeat", () => {
    const asset: ChatAttachment = { id: "generated", origin: "generated", kind: "image", original_filename: "生成图片.png", parse_status: "parsed" };
    const prompt = "生成一张图片，沿用以下画面要求：小猫玩小鱼玩具。";
    const answer: ChatMessage = { ...assistantMessage(""), payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "done", events: [], assets: [asset], image_generation_prompt: prompt } } };
    const p = renderChat([{ ...message, content: "再生成一张" }, answer]);
    fireEvent.click(screen.getByText("生成提示词"));
    expect(screen.getByText(prompt)).toBeVisible();
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("renders ordered text and images once when a snapshot repeats an image reference", () => {
    const asset: ChatAttachment = { id: "generated", origin: "generated", kind: "image", original_filename: "生成图片.png", parse_status: "parsed" };
    const mixed: ChatMessage = { ...assistantMessage("前言\n后记"), payload: { agent: { provider: "responses", platform: "local", rounds: 1, status: "done", events: [], assets: [asset], output_blocks: [{ type: "text", text: "前言" }, { type: "image", asset_id: asset.id }, { type: "image", asset_id: asset.id }, { type: "text", text: "后记" }] } } };
    const p = renderChat([message, mixed], { onEditDocument: vi.fn(), onLoadAttachment: vi.fn() });
    expect(screen.queryByRole("button", { name: "编辑文档" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制文字" })).toBeEnabled();
    expect(screen.getAllByText("前言")).toHaveLength(1);
    expect(screen.getAllByText("后记")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "预览 生成图片.png" })).toHaveLength(1);
    const output = p.view.container.querySelector(".message-image-output")!;
    expect([...output.children].map(child => child.tagName)).toEqual(["DIV", "FIGURE", "DIV"]);
  });

  it("replaces the image-slot animation with a frameless image in the same result container", async () => {
    const imageEvent = { round: 1, tool_call_id: "image-1", tool_name: "image_generation", status: "running", message: "正在生成图片" };
    const pending: ChatMessage = { ...assistantMessage("", -1), payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "done", events: [imageEvent] } } };
    const props = renderChat([message, pending], { chatBusy: true });
    const output = screen.getByRole("region", { name: "输出结果" });
    expect(output).toHaveClass("message-image-output");
    expect(output).not.toHaveClass("message-dialog", "message-result");
    expect(screen.getByRole("status", { name: "正在生成图片" }).parentElement).toBe(output);
    expect(props.view.container.querySelector(".run-process")).toBeNull();
    const asset: ChatAttachment = { id: "generated", origin: "generated", kind: "image", original_filename: "生成图片.png", parse_status: "parsed", width: 1402, height: 1122 };
    const done: ChatMessage = { ...assistantMessage(""), payload: { agent: { ...pending.payload!.agent!, events: [{ ...imageEvent, status: "done", message: "已生成 1 张图片" }], assets: [asset] } } };
    props.view.rerender(<ChatWorkspace {...props} messages={[message, done]} chatBusy={false} />);
    await waitFor(() => expect(screen.getByRole("figure", { name: "模型生成图片" })).toBeVisible());
    expect(screen.queryByRole("status", { name: "正在生成图片" })).not.toBeInTheDocument();
    const completedOutput = screen.getByRole("region", { name: "输出结果" });
    expect(completedOutput).toHaveClass("message-image-output");
    expect(completedOutput).not.toHaveClass("message-dialog", "message-result");
    expect(screen.getByRole("figure", { name: "模型生成图片" }).parentElement).toBe(completedOutput);
    expect(screen.getByRole("figure", { name: "模型生成图片" })).toHaveStyle({ maxWidth: `${320 * 1402 / 1122}px` });
    expect(completedOutput.querySelector(".generated-image-preview")).not.toBeNull();
    expect(completedOutput.querySelector(".chat-history-attachment")).toBeNull();
  });
  it("opens image saving without altering the composer draft", async () => {
    const asset: ChatAttachment = { id: "generated", origin: "generated", kind: "image", original_filename: "生成图片.png", parse_status: "parsed" };
    const pure: ChatMessage = { ...assistantMessage(""), payload: { agent: { provider: "responses", platform: "local", rounds: 1, status: "done", events: [], assets: [asset], output_blocks: [{ type: "image", asset_id: asset.id }] } } };
    const load = vi.fn().mockResolvedValue({ message_id: 12, snapshot: "a".repeat(64), incomplete: false, artifacts: [{ selector: `asset:${asset.id}`, kind: "image", filename: asset.original_filename, mime_type: "image/png", asset, can_index: false }] });
    const p = renderChat([message, pure], { onLoadResults: load, onSaveResult: vi.fn() });
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "未发送草稿" } });
    fireEvent.click(screen.getByLabelText("保存图片"));
    fireEvent.click(screen.getByRole("button", { name: "保存到文件库" }));
    expect(await screen.findByRole("dialog", { name: "聊天成果" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(12, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "关闭成果" }));
    expect(input).toHaveValue("未发送草稿");
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("does not show a result button below text answers even when result services are available", () => {
    const load = vi.fn();
    renderChat([message, assistantMessage("完整回答")], { onLoadResults: load, onSaveResult: vi.fn() });
    expect(screen.queryByRole("button", { name: "查看与保存成果" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制回答" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新生成回答" })).toBeEnabled();
    expect(load).not.toHaveBeenCalled();
  });

  it("does not expose final-result actions on an optimistic streaming response", () => {
    const load = vi.fn();
    renderChat([message, assistantMessage("生成中", -12)], { chatBusy: true, onLoadResults: load });
    expect(screen.queryByRole("button", { name: "查看与保存成果" })).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("shows an image failure once, with a retry on the answer and no error-only artifact", () => {
    const error = "当前连接暂不支持生成图片。你可以继续聊天。";
    const failed = { ...assistantMessage(error), payload: { agent: {
      provider: "responses", platform: "local", rounds: 1, status: "failed" as const,
      error: { code: "image_generation_unsupported", message: error, retryable: false },
      events: [{ round: 1, tool_name: "image_generation", tool_call_id: "image-test", status: "failed", message: error }]
    } } };
    renderChat([message, failed], { onLoadResults: vi.fn(), currentModelName: "grok-4.7" });
    expect(screen.getAllByText(error)).toHaveLength(1);
    expect(screen.getByText("未生成图片")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看与保存成果" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试回答" })).toBeInTheDocument();
    expect(screen.queryByText("服务不可用")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("消息发送失败")).not.toBeInTheDocument();
  });

  it("shows the backend's uncertain-write guidance once during streaming and after the terminal snapshot", async () => {
    const guidance = "上次写入是否完成尚不确定。请先在文件库核对目标记录，确认缺失后再单独提交。";
    const event = { round: 1, tool_name: "propose_library_knowledge", tool_call_id: "write-1", status: "blocked", message: guidance, data: { uncertain_previous_execution: true } };
    const agent: AgentRunResult = { provider: "test", platform: "local", rounds: 1, status: "done", events: [event] };
    const props = renderChat([message, { ...assistantMessage(guidance, -12), payload: { agent } }], { chatBusy: true });
    expect(screen.getAllByText(guidance)).toHaveLength(1);
    const persisted = { ...assistantMessage(guidance), payload: { agent: { ...agent, status: "failed" as const, error: { code: "tool_execution_uncertain", message: guidance, retryable: false } } } };
    props.view.rerender(<ChatWorkspace {...props} messages={[message, persisted]} chatBusy={false} />);
    expect(await screen.findByText("写入结果待核对")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("已阻止重复写入")).toBeVisible();
    expect(screen.getAllByText(guidance)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /重试|重新生成|继续执行/ })).not.toBeInTheDocument();
  });

  it("replaces the generic retry instruction in a legacy uncertain-write answer", () => {
    const oldError = "上次本地写工具执行被中断，结果状态不确定，系统不会自动重放";
    renderChat([message, { ...assistantMessage(`${oldError}。本次执行已终止，请处理后重新提问。`), payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "failed", error: { code: "tool_execution_uncertain", message: oldError, retryable: false },
      events: [{ round: 1, tool_name: "propose_library_knowledge", tool_call_id: "write-old", status: "blocked", message: oldError, data: { uncertain_previous_execution: true } }]
    } } }]);
    const output = screen.getByRole("region", { name: "输出结果" });
    expect(output).toHaveTextContent("待确认和已确认知识");
    expect(output).toHaveTextContent("只有确认缺失时");
    expect(screen.queryByText(/处理后重新提问/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重试|重新生成/ })).not.toBeInTheDocument();
  });

  it("retains unpersisted send failures without marking the chat model unavailable", () => {
    renderChat([message], { sendError: "消息流连接中断", currentModelName: "grok-4.7", retryDraft: {
      content: "原始问题", attachmentIds: [], visionAttachmentIds: [], webSearch: false,
      webSearchTopic: "auto", webSearchSourcePreference: "none", reason: "send_failed"
    } });
    expect(screen.getByLabelText("消息发送失败")).toHaveTextContent("消息流连接中断");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("服务不可用")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "去设置模型" })).not.toBeInTheDocument();
  });

  it.each(["page", "dock"] as const)("returns to latest from the message overlay without changing the %s composer draft", (density) => {
    const p = renderChat([message, assistantMessage("已有回答")], { density });
    const viewport = screen.getByRole("log");
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "尚未发送的草稿" } });
    viewport.scrollTop = 217;
    fireEvent.scroll(viewport);
    const jump = screen.getByRole("button", { name: "回到最新" });
    expect(jump.querySelector(".lucide-arrow-down")).toHaveAttribute("aria-hidden", "true");
    expect(jump.closest(".chat-composer")).toBeNull();
    expect(viewport.contains(jump)).toBe(false);
    p.view.rerender(<ChatWorkspace {...p} messages={[message, assistantMessage("已有回答，追加内容")]} />);
    expect(viewport.scrollTop).toBe(217);
    fireEvent.click(screen.getByRole("button", { name: "有新内容 · 回到最新" }));
    expect(viewport.scrollTop).toBe(1500);
    expect(input).toHaveValue("尚未发送的草稿");
    expect(p.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /回到最新/ })).not.toBeInTheDocument();
  });

  it("appends continuous transcripts while listening and stops without sending or a status banner", async () => {
    const originalNavigator = window.navigator;
    const stop = vi.fn();
    voiceCaptureMocks.supported = true;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } });
    try {
      const session = { close: vi.fn().mockResolvedValue(undefined), accept: vi.fn().mockResolvedValueOnce([{ segmentId: 0, revision: 1, text: "第一自", final: false }]).mockResolvedValueOnce([{ segmentId: 0, revision: 2, text: "第一句。", final: true }]).mockResolvedValueOnce([{ segmentId: 1, revision: 1, text: "第二句。", final: true }]) };
      const voiceInput = { prepare: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue(session) };
      const p = renderChat([], { voiceInput });
      fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "原有草稿" } });
      fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
      await waitFor(() => expect(voiceInput.open).toHaveBeenCalledOnce());
      const recording = screen.getByRole("button", { name: "停止语音输入" });
      expect(recording).toHaveTextContent(/^语音$/);
      expect(recording).toHaveClass("is-recording");
      expect(recording).not.toHaveAttribute("title");
      expect(recording.querySelector(".composer-voice-wave")).toBeInTheDocument();
      act(() => voiceCaptureMocks.onLevel?.(0.75));
      expect(recording.querySelector(".composer-voice-icon")).toHaveStyle("--voice-level: 0.75");
      await act(async () => voiceCaptureMocks.emit?.(new Blob(["first"], { type: "audio/wav" })));
      expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("原有草稿第一自");
      expect(stop).not.toHaveBeenCalled();
      await act(async () => voiceCaptureMocks.emit?.(new Blob(["revision"], { type: "audio/wav" })));
      expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("原有草稿第一句。");
      await act(async () => voiceCaptureMocks.emit?.(new Blob(["second"], { type: "audio/wav" })));
      expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("原有草稿第一句。第二句。");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("aria-describedby", "composer-input-hint");
      fireEvent.click(screen.getByRole("button", { name: "停止语音输入" }));
      expect(screen.getByRole("button", { name: "语音输入" })).toHaveAttribute("aria-pressed", "false");
      expect(recording).not.toHaveClass("is-recording");
      expect(recording).toHaveTextContent(/^语音$/);
      expect(recording.querySelector(".composer-voice-wave")).not.toBeInTheDocument();
      expect(recording.querySelector(".composer-voice-icon")).toHaveStyle("--voice-level: 0");
      expect(stop).toHaveBeenCalled();
      await act(async () => voiceCaptureMocks.emit?.(new Blob(["late"])));
      expect(session.accept).toHaveBeenCalledTimes(3);
      expect(session.close).toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("原有草稿第一句。第二句。");
      expect(p.onSend).not.toHaveBeenCalled();
    } finally { cleanup(); vi.stubGlobal("navigator", originalNavigator); voiceCaptureMocks.supported = false; }
  });

  it("keeps only the icon state while preparing and can cancel preparation immediately", async () => {
    const originalNavigator = window.navigator;
    voiceCaptureMocks.supported = true;
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    let ready!: () => void;
    const prepare = new Promise<void>(resolve => { ready = resolve; });
    const voiceInput = { prepare: vi.fn().mockReturnValue(prepare), open: vi.fn() };
    try {
      const p = renderChat([], { voiceInput });
      fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
      const button = screen.getByRole("button", { name: "停止语音输入" });
      expect(button).toHaveTextContent(/^语音$/);
      expect(button).toHaveClass("is-recording");
      expect(p.view.container.querySelector("#composer-voice-feedback")).not.toBeInTheDocument();
      expect(screen.queryByText(/准备中|启动中|停止转录|下载.*%/)).not.toBeInTheDocument();
      fireEvent.click(button);
      expect(button).not.toHaveClass("is-recording");
      expect(button).toHaveAttribute("aria-pressed", "false");
      await act(async () => ready());
      expect(voiceInput.open).not.toHaveBeenCalled();
    } finally { cleanup(); vi.stubGlobal("navigator", originalNavigator); voiceCaptureMocks.supported = false; }
  });

  it("resets the icon on failure without adding visible prompts or tooltips", async () => {
    renderChat([]);
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    const button = screen.getByRole("button", { name: "语音输入" });
    expect(button).toHaveAttribute("aria-description", expect.stringContaining("不支持录音"));
    expect(button).toHaveTextContent(/^语音$/);
    expect(button).not.toHaveClass("is-recording");
    expect(button).not.toHaveAttribute("title");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("aria-describedby", "composer-input-hint");
  });

  it("adds every selected file until the eight-file limit", async () => {
    const p = renderChat([]);
    let count = 0;
    p.onUploadAttachment.mockImplementation(async (file: File) => ({ id: `file-${++count}`, kind: "document" as const, original_filename: file.name, parse_status: "parsed" as const }));
    const files = ["一.txt", "二.txt", "三.txt"].map((name) => new File(["正文"], name, { type: "text/plain" }));
    const picker = p.view.container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(picker.multiple).toBe(true);
    fireEvent.change(picker, { target: { files } });
    expect(await screen.findByRole("button", { name: "预览 一.txt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览 二.txt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览 三.txt" })).toBeInTheDocument();
    expect(p.onUploadAttachment).toHaveBeenCalledTimes(3);
  });

  it("asks about a selected passage, exports the conversation, and deletes one turn after confirmation", async () => {
    const onDeleteTurn = vi.fn().mockResolvedValue(undefined);
    const onExportConversation = vi.fn();
    const drafts = new Map<number, string>();
    const p = renderChat([message, assistantMessage("可以核对的句子")], { onDeleteTurn, onExportConversation, composerDrafts: drafts });
    const passage = screen.getByText("可以核对的句子");
    const range = document.createRange();
    range.selectNodeContents(passage);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(passage);
    fireEvent.click(screen.getByRole("button", { name: "针对这段提问" }));
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("> 可以核对的句子\n\n针对这段：");
    fireEvent.click(screen.getByRole("button", { name: "导出对话" }));
    expect(onExportConversation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "删除这轮问答" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除这轮问答" }));
    expect(onDeleteTurn).toHaveBeenCalledWith(message.id);
  });

  it("keeps an unsaved draft across a refresh and offers undo after a replacement", () => {
    const drafts = new Map<number, string>();
    const onPersistComposerDrafts = vi.fn();
    const onUndoReplacement = vi.fn().mockResolvedValue(undefined);
    const p = renderChat([message], { composerDrafts: drafts, onPersistComposerDrafts, replacementUndo: { conversationId: conversation.id }, onUndoReplacement });
    fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "还没发送" } });
    fireEvent(window, new Event("pagehide"));
    expect(drafts.get(conversation.id)).toBe("还没发送");
    expect(onPersistComposerDrafts).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onUndoReplacement).toHaveBeenCalledOnce();
    p.view.unmount();
  });

  it("opens newly added text attachments locally without sending or removing them", async () => {
    const p = renderChat([]);
    p.onUploadAttachment.mockResolvedValue({ id: "local-doc", kind: "document", original_filename: "资料.txt", parse_status: "parsed" });
    const file = Object.assign(new File(["待发送的原文"], "资料.txt", { type: "text/plain" }), { arrayBuffer: async () => new TextEncoder().encode("待发送的原文").buffer });
    const picker = p.view.container.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(picker, { target: { files: [file] } });
    const preview = await screen.findByRole("button", { name: "预览 资料.txt" });
    preview.focus();
    fireEvent.click(preview);
    expect(await screen.findByText("待发送的原文")).toBeInTheDocument();
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭附件预览" }));
    expect(preview).toHaveFocus();
    expect(screen.getByRole("button", { name: "移除 资料.txt" })).toBeInTheDocument();
    expect(p.onRemoveAttachment).not.toHaveBeenCalled();
  });

  it("opens sent attachments through the authenticated loader and closes on conversation change", async () => {
    const attached: ChatMessage = { ...message, payload: { attachments: [{ id: "history-doc", kind: "document", original_filename: "历史.txt", parse_status: "parsed" }] } };
    const p = renderChat([attached]);
    const load = vi.fn().mockResolvedValue({ file: { size: 10, arrayBuffer: async () => new TextEncoder().encode("历史原文").buffer } });
    p.view.rerender(<ChatWorkspace {...p} onLoadAttachment={load} />);
    fireEvent.click(screen.getByRole("button", { name: "预览 历史.txt" }));
    expect(await screen.findByText("历史原文")).toBeInTheDocument();
    expect(load.mock.calls[0][0].id).toBe("history-doc");
    p.view.rerender(<ChatWorkspace {...p} onLoadAttachment={load} currentConversationId={2} />);
    expect(screen.queryByRole("dialog", { name: "历史.txt 预览" })).not.toBeInTheDocument();
  });

  it("shows the session search toggle off and sends its explicit value on each new turn", async () => {
    const props = renderChat([message]);
    const toggle = screen.getByRole("button", { name: "联网搜索" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "搜索类别" })).not.toBeInTheDocument();
    async function send(content: string, enabled: boolean) {
      fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: content } });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(() => expect(props.onSend).toHaveBeenLastCalledWith(content, [], [], enabled));
    }
    await send("默认关闭", false);
    fireEvent.click(toggle);
    expect(props.onWebSearchChange).toHaveBeenLastCalledWith(true);
    props.view.rerender(<ChatWorkspace {...props} webSearchEnabled />);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await send("查一下最新资讯", true);
    await send("再查另一条", true);
    fireEvent.click(toggle);
    expect(props.onWebSearchChange).toHaveBeenLastCalledWith(false);
    props.view.rerender(<ChatWorkspace {...props} webSearchEnabled={false} />);
    await send("只用现有资料", false);
  });

  it("leaves waiting-task search inheritance to the server", async () => {
    const pending: ChatMessage = { ...assistantMessage("请确认"), payload: { agent: { provider: "test", platform: "local", rounds: 1, status: "waiting_user", events: [] } } };
    const source: ChatMessage = { ...message, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "technical", provider: "tavily" } } };
    const props = renderChat([source, pending]);
    expect(screen.queryByLabelText("搜索类别")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("继续", [], [], false));
  });

  it("does not add answer details or a model name from search metadata alone", () => {
    const answer: ChatMessage = { ...assistantMessage("测试回答"), payload: { agent: { provider: "test", platform: "local", rounds: 1, status: "done", events: [{ round: 1, tool_call_id: "search-1", tool_name: "search_public_web", status: "done", message: "检索完成", data: { search_metadata: { provider: "tavily", requested_topic: "auto", sent_topic: null, effective_topic: null, source_preference: "technical", warnings: [] } } }] } } };
    renderChat([message, answer]);
    expect(screen.queryByText(/服务实际类别/)).toBeNull();
    expect(screen.queryByRole("button", { name: "回答详情" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^回答模型：/)).not.toBeInTheDocument();
  });

  it("keeps the current model label while generating and provides a stop action", async () => {
    const props = renderChat([message], { chatBusy: true, currentModelName: "grok-4.7" });
    const model = screen.getByRole("button", { name: "切换模型，当前 grok-4.7" });
    expect(model).toHaveTextContent("grok-4.7");
    expect(model).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    await waitFor(() => expect(props.onStop).toHaveBeenCalledOnce());
  });

  it("shows a pending stop without allowing a second request", () => {
    renderChat([message], { chatBusy: true, taskCancelBusy: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在停止生成");
    expect(screen.getByRole("button", { name: "正在停止生成" })).toBeDisabled();
  });

  it("keeps a stopped process collapsed above the partial answer and allows reopening it", () => {
    const agent: AgentRunResult = { provider: "test", platform: "local", rounds: 1, status: "cancelled", events: [{ round: 1, tool_call_id: "search-1", tool_name: "search_library", status: "done", message: "已查阅项目资料" }] };
    const props = renderChat([message, { ...assistantMessage("已生成的部分内容"), payload: { agent } }]);
    const toggle = screen.getByRole("button", { name: "展开思考与执行过程" });
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    const answer = within(screen.getByRole("log")).getByText("已生成的部分内容");
    expect(toggle).toHaveTextContent("已停止");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(answer).toBeInTheDocument();
    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(props.view.container.querySelector(".chat-run-status")).not.toBeInTheDocument();
    expect(process.querySelector(".spinning")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看过程，打开研究详情" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(process).getByText("已查阅项目资料")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "来源详情" })).not.toBeInTheDocument();
  });

  it("uses the final result instead of treating a recovered tool failure as a failed answer", () => {
    const agent: AgentRunResult = { provider: "test", platform: "local", rounds: 2, status: "done", events: [{ round: 1, tool_call_id: "search-1", tool_name: "search_library", status: "failed", message: "该检索已改用其他策略" }] };
    renderChat([{ ...assistantMessage("已完成回答"), payload: { agent } }]);
    expect(screen.queryByText("生成失败")).not.toBeInTheDocument();
  });

  it("shows failed results even when the service did not emit tool events", () => {
    const agent: AgentRunResult = { provider: "test", platform: "local", rounds: 0, status: "failed", events: [], error: { code: "service_error", message: "服务不可用", retryable: true } };
    renderChat([{ ...assistantMessage("服务不可用"), payload: { agent } }]);
    expect(screen.getByText("生成失败")).toBeInTheDocument();
    expect(screen.getAllByText("服务不可用")).toHaveLength(1);
  });

  it("shows keyboard hints while editing without losing the draft when focus moves through the tools", () => {
    const props = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    const hint = props.view.container.querySelector(".composer-input-hint")!;
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveAccessibleDescription(/Enter 发送 · Shift \+ Enter 换行/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "保留正在编辑的内容" } });
    expect(hint).toHaveAttribute("aria-hidden", "false");
    const attachment = screen.getByRole("button", { name: "添加附件" });
    expect(within(screen.getByRole("group", { name: "输入选项" })).getByRole("button", { name: "添加附件" })).toBe(attachment);
    expect(attachment).toHaveTextContent("添加资料");
    fireEvent.blur(input, { relatedTarget: attachment });
    fireEvent.focus(attachment);
    expect(hint).toHaveAttribute("aria-hidden", "false");
    fireEvent.blur(attachment, { relatedTarget: document.body });
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveValue("保留正在编辑的内容");
  });

  it("keeps the character limit visible when a long draft is not focused", () => {
    const props = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "字".repeat(180_001) } });
    expect(screen.getByText("180,001 / 200,000 字")).toHaveAttribute("role", "status");
    expect(props.view.container.querySelector(".composer-input-hint")).toHaveAttribute("aria-hidden", "false");
    expect(input).toHaveAttribute("maxlength", "200000");
  });

  it("opens file selection from the compact attachment button", () => {
    const props = renderChat();
    const fileInput = props.view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(fileInput, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    expect(choose).toHaveBeenCalledOnce();
    props.view.rerender(<ChatWorkspace {...props} attachmentBusy />);
    expect(screen.getByRole("button", { name: "附件处理中" })).toBeDisabled();
  });

  it.each(["page", "dock"] as const)("keeps the model picker and send button but no kernel control in the %s composer", (density) => {
    const { view } = renderChat([message], { density, currentModelName: "grok-4.7" });
    const workspace = within(view.container);
    expect(workspace.getByRole("button", { name: "切换模型，当前 grok-4.7" })).toBeInTheDocument();
    expect(workspace.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(workspace.queryByRole("button", { name: /内核|DeepSeek Harness/ })).not.toBeInTheDocument();
  });

  it("keeps a greeting focused on messages and one model picker", () => {
    const greeting = { ...assistantMessage("你好，有什么可以帮你？"), payload: { model_selection: {
      profile_id: "grok", connection_id: "local", profile_revision: 1, connection_revision: 1, model_name: "grok-4.7"
    } } };
    const props = renderChat([message, greeting]);
    props.view.rerender(<ChatWorkspace {...props} currentModelName="grok-4.7" defaultModelName="grok-4.7" modelConfigured />);
    expect(screen.getByRole("button", { name: "切换模型，当前 grok-4.7" })).toBeInTheDocument();
    expect(screen.getByLabelText("回答模型：grok-4.7")).toHaveTextContent("grok-4.7");
    expect(screen.queryByText(/生成模型：/)).not.toBeInTheDocument();
    expect(screen.queryByText("模型详情")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答详情" })).not.toBeInTheDocument();
    for (const name of ["复制消息", "编辑消息", "复制回答", "重新生成回答"]) {
      expect(screen.getByRole("button", { name })).toHaveTextContent(/^$/);
    }
  });

  it("shows the historical answer model as plain text independently of the current model picker", () => {
    renderChat([{ ...assistantMessage("历史回答"), payload: { model_selection: {
      profile_id: "old", connection_id: "local", profile_revision: 2, connection_revision: 3, model_name: "历史模型"
    } } }], { currentModelName: "当前模型" });
    const label = screen.getByLabelText("回答模型：历史模型");
    expect(label).toHaveTextContent("历史模型");
    expect(label.closest("button")).toBeNull();
    expect(label.closest(".message-footer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "切换模型，当前 当前模型" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "回答详情" })).not.toBeInTheDocument();
  });

  it("does not repeat an error already present in the answer", () => {
    const errorMessage = "模型服务暂时不可用，请稍后重试。";
    renderChat([{ ...assistantMessage(errorMessage), payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "failed",
      events: [{ round: 1, tool_call_id: "provider-1", tool_name: "model_provider", status: "failed", message: errorMessage }],
      error: { code: "model_service_error", message: errorMessage, retryable: true }
    } } }]);
    expect(within(screen.getByRole("log")).getAllByText(errorMessage)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "思考与执行过程" })).not.toHaveTextContent("请先检查设置");
    expect(screen.getByRole("button", { name: "重试回答" })).toHaveTextContent(/^$/);
  });

  it("shows one failure prompt with settings, retry and the retained draft", () => {
    const draft: ChatRetryDraft = { content: "保留的问题", attachmentIds: [], visionAttachmentIds: [], webSearch: false, webSearchTopic: "auto", webSearchSourcePreference: "none", reason: "send_failed" };
    const props = renderChat([], { modelUnavailable: "服务暂时不可用", retryDraft: draft });
    const prompt = screen.getByRole("alert", { name: "模型服务不可用" });
    expect(props.view.container.querySelectorAll(".chat-retry-prompt")).toHaveLength(1);
    expect(screen.queryByText("上一条消息未发送成功")).not.toBeInTheDocument();
    fireEvent.click(within(prompt).getByRole("button", { name: "重试" }));
    expect(props.onRetry).toHaveBeenCalledWith(draft);
    fireEvent.click(within(prompt).getByRole("button", { name: "去设置模型" }));
    expect(props.onOpenModelSettings).toHaveBeenCalledOnce();
    fireEvent.click(within(prompt).getByText("查看保留的内容"));
    expect(within(prompt).getByText(draft.content)).toBeVisible();
  });

  it("shows the live activity and current task in one expanded message process", () => {
    const agent: AgentRunResult = { provider: "test", platform: "local", rounds: 1, status: "done", events: [{
      round: 1, tool_call_id: "search-1", tool_name: "search_library", status: "running", message: "正在查阅项目资料"
    }] };
    renderChat([message, { ...assistantMessage("", -1), payload: { agent } }], { chatBusy: true, latestAgent: agent });
    expect(screen.getAllByText("正在查阅项目资料")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("正在查阅项目资料");
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    expect(within(process).getByRole("button", { name: "收起思考与执行过程" })).toHaveAttribute("aria-expanded", "true");
    expect(process.closest(".message.assistant")).not.toBeNull();
    expect(process.closest(".chat-composer")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看过程，打开研究详情" })).not.toBeInTheDocument();
  });

  it("shows only the execution model in the answer footer without routing diagnostics", () => {
    renderChat([message, { ...assistantMessage("最终回答"), payload: { model_selection: {
      profile_id: "execute", connection_id: "c", profile_revision: 1, connection_revision: 2,
      model_name: "默认模型", policy_version: 3,
      stage_selections: {
      classify: { model_name: "识别模型", selection_reason: "stage_role", capability_status: "satisfied" },
      plan: { model_name: "规划模型", selection_reason: "default_profile" },
        execute: { model_name: "执行模型", selection_reason: "explicit_profile", capability_status: "unverified" }
      }
    } } }]);
    expect(screen.getByLabelText("回答模型：执行模型")).toHaveTextContent("执行模型");
    expect(screen.queryByLabelText("回答模型：默认模型")).not.toBeInTheDocument();
    expect(screen.queryByText(/路由版本/)).not.toBeInTheDocument();
    expect(screen.queryByText(/意图识别：|任务规划：|本轮未调用/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答详情" })).not.toBeInTheDocument();
  });

  it("uses the recorded fallback answer model instead of the primary model", () => {
    renderChat([{ ...assistantMessage("备用模型的回答"), payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "done", events: [],
      model_selection: {
        profile_id: "primary", connection_id: "c", profile_revision: 1, connection_revision: 1,
        model_name: "主模型", stage_selections: { execute: { model_name: "执行模型" } },
        fallback_used: true, answered_model_name: "备用模型"
      }
    } } }]);
    expect(screen.getByLabelText("回答模型：备用模型")).toHaveTextContent("备用模型");
    expect(screen.queryByText("主模型")).not.toBeInTheDocument();
    expect(screen.queryByText("执行模型")).not.toBeInTheDocument();
  });

  it("does not infer missing historical model records from the current picker", () => {
    renderChat([assistantMessage("未记录模型的旧回答")], { currentModelName: "当前模型" });
    expect(screen.queryByLabelText(/^回答模型：/)).not.toBeInTheDocument();
  });

  it("waits until generation finishes before showing the answer model", () => {
    renderChat([{ ...assistantMessage("生成中", -12), payload: { model_selection: {
      profile_id: "p", connection_id: "c", profile_revision: 1, connection_revision: 1, model_name: "执行模型"
    } } }], { chatBusy: true });
    expect(screen.queryByLabelText(/^回答模型：/)).not.toBeInTheDocument();
  });

  it("puts the model picker in the composer toolbar and reminds the user to configure a model", () => {
    const props = renderChat([message], { modelConfigured: false });
    fireEvent.click(screen.getByRole("button", { name: "未配置模型，去设置" }));
    expect(props.onOpenModelSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /切换模型/ })).not.toBeInTheDocument();
  });

  it("reports message copy success and clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "复制消息" })).toHaveAttribute("title", "已复制"));
    expect(screen.getByText("已复制")).toHaveClass("message-copy-feedback");
    expect(writeText).toHaveBeenCalledWith(message.content);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "复制消息" })).toHaveAttribute("title", "复制失败，请检查权限或手动选择复制"));
    expect(screen.getByText("复制失败，请检查权限或手动选择复制")).toBeVisible();
  });

  it("shows progress until the answer is actually copied", async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const answer = "第一行回答\n第二行回答";
    renderChat([message, assistantMessage(answer)]);
    const copy = screen.getByRole("button", { name: "复制回答" });
    fireEvent.click(copy);
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("正在复制")).toBeVisible();
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(answer);
    await act(async () => resolveCopy());
    expect(copy).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("已复制")).toBeVisible();
  });

  it("asks the user to retry instead of overlapping two message copies", async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderChat([message, assistantMessage("助手回答")]);
    const copyMessage = screen.getByRole("button", { name: "复制消息" });
    const copyAnswer = screen.getByRole("button", { name: "复制回答" });
    fireEvent.click(copyMessage);
    fireEvent.click(copyAnswer);
    expect(await screen.findByText("正在复制其他消息，请稍后重试")).toBeVisible();
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => resolveCopy());
    expect(copyMessage).toHaveAttribute("title", "已复制");

    writeText.mockResolvedValueOnce(undefined);
    await act(async () => { fireEvent.click(copyAnswer); });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("助手回答");
    expect(copyAnswer).toHaveAttribute("title", "已复制");
    expect(screen.getAllByText("已复制")).toHaveLength(2);
  });

  it("does not show an old copy result after the message changes", async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { view, ...props } = renderChat([message]);
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    expect(screen.getByText("正在复制")).toBeVisible();
    view.rerender(<ChatWorkspace {...props} messages={[{ ...message, content: "修改后的消息" }]} />);
    await act(async () => resolveCopy());
    expect(screen.queryByText("已复制")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制消息" })).toHaveAttribute("title", "复制消息");
  });

  it("explains editing impact and preserves a long replacement without sending on cancel", async () => {
    const props = renderChat([message, assistantMessage("原回答")]);
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    const editor = await screen.findByRole("textbox", { name: "编辑消息" });
    expect(editor).toHaveAttribute("maxlength", "200000");
    expect(screen.getByText("将替换本条消息及后续消息，并重新生成回复")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "长消息".repeat(500) } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑消息" })).not.toBeInTheDocument());
    expect(within(screen.getByRole("log")).getByText(message.content)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "编辑消息" }), { target: { value: "长消息".repeat(500) } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith(message.id, "长消息".repeat(500)));
  });

  it("describes regeneration scope and regenerates from the matching user message", async () => {
    const props = renderChat([message, assistantMessage("原回答")]);
    const regenerate = screen.getByRole("button", { name: "重新生成回答" });
    expect(regenerate).toHaveAccessibleDescription("重新生成将替换本轮及后续消息");
    expect(screen.getByText("重新生成将替换本轮及后续消息")).toHaveClass("sr-only");
    expect(regenerate).toHaveAttribute("title", "重新生成，将替换本轮及后续消息");
    fireEvent.click(regenerate);
    await waitFor(() => expect(props.onRegenerate).toHaveBeenCalledWith(message.id));
  });

  it("copies complete long code and expands its preview", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const code = Array.from({ length: 30 }, (_, i) => `print(${i})`).join("\n");
    renderChat([assistantMessage(["```python", code, "```"].join("\n"))]);
    expect(screen.getByText("python")).toBeInTheDocument();
    const expand = screen.getByRole("button", { name: /展开完整代码/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "收起代码" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${code}\n`));
    const copied = await screen.findByRole("button", { name: "已复制" });
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(copied);
    await waitFor(() => expect(screen.getByRole("button", { name: "复制失败，请重试" })).toBeInTheDocument());
  });

  it("restores each conversation's text draft and keeps new conversations empty", () => {
    const { view, ...props } = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "项目一的未发送草稿" } });
    view.rerender(<ChatWorkspace {...props} currentConversationId={2} />);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "项目二的未发送草稿" } });
    view.rerender(<ChatWorkspace {...props} currentConversationId={1} />);
    expect(input).toHaveValue("项目一的未发送草稿");
    view.rerender(<ChatWorkspace {...props} currentConversationId={2} />);
    expect(input).toHaveValue("项目二的未发送草稿");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("keeps a session draft across workspace unmounts without browser storage", () => {
    const { view, ...props } = renderChat();
    const drafts = new Map<number, string>();
    view.rerender(<ChatWorkspace {...props} composerDrafts={drafts} />);
    fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "离开工作区再回来" } });
    view.unmount();
    render(<ChatWorkspace {...props} composerDrafts={drafts} />);
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("离开工作区再回来");
  });

  it("grows and shrinks the editor, scrolls tall content, and preserves long code input", () => {
    renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    const text = "const value = 123;\n".repeat(100);
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 400 });
    fireEvent.change(input, { target: { value: text } });
    expect(input).toHaveValue(text);
    expect(input).toHaveAttribute("maxlength", "200000");
    expect(Number.parseFloat((input as HTMLTextAreaElement).style.height)).toBeLessThanOrEqual(240);
    expect(Number.parseFloat((input as HTMLTextAreaElement).style.height)).toBeGreaterThan(200);
    expect((input as HTMLTextAreaElement).style.overflowY).toBe("auto");
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 70 });
    fireEvent.change(input, { target: { value: "缩短的输入" } });
    expect(input).toHaveStyle({ height: "70px", overflowY: "hidden" });
    expect(screen.getByText("Enter 发送 · Shift + Enter 换行")).toBeInTheDocument();
  });

  it("waits for attachment processing and does not submit an IME confirmation or Shift+Enter", () => {
    const { view, ...props } = renderChat();
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "中文输入确认" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    view.rerender(<ChatWorkspace {...props} attachmentBusy />);
    expect(screen.getByRole("button", { name: /^发送$/ })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(props.onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("中文输入确认");
  });

  beforeEach(() => {
    mermaidMocks.initialize.mockClear();
    mermaidMocks.render.mockReset();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg data-rendered-mermaid="true" viewBox="0 0 100 60"></svg>'
    });
  });

  afterEach(cleanup);

  it("imports a matching home analysis draft once without sending it", async () => {
    const consumed = vi.fn();
    const draft = { id: "home-1", conversationId: 1, content: "请分析这条资讯，来源：https://example.com/news" };
    const p = renderChat([], { composerDraft: draft, onComposerDraftConsumed: consumed });
    const input = screen.getByRole("textbox", { name: "输入消息" });
    await waitFor(() => expect(input).toHaveValue(draft.content));
    expect(consumed).toHaveBeenCalledOnce();
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "我编辑后的问题" } });
    p.view.rerender(<ChatWorkspace {...p} composerDraft={draft} />);
    expect(input).toHaveValue("我编辑后的问题");
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("preserves existing text until the user chooses to import a draft", async () => {
    const p = renderChat([]);
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "未发送的原问题" } });
    const consumed = vi.fn();
    const draft = { id: "home-2", conversationId: 2, content: "资讯分析草稿" };
    p.view.rerender(<ChatWorkspace {...p} composerDraft={draft} onComposerDraftConsumed={consumed} />);
    expect(input).toHaveValue("未发送的原问题");
    expect(screen.queryByLabelText("资讯分析草稿")).not.toBeInTheDocument();
    p.view.rerender(<ChatWorkspace {...p} currentConversationId={2} />);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "未发送的原问题" } });
    p.view.rerender(<ChatWorkspace {...p} currentConversationId={2} composerDraft={draft} onComposerDraftConsumed={consumed} />);
    expect(input).toHaveValue("未发送的原问题");
    expect(consumed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "替换为资讯草稿" }));
    await waitFor(() => expect(input).toHaveValue("资讯分析草稿"));
    expect(consumed).toHaveBeenCalledOnce();
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("consumes library attachments once without clearing the composer or requeueing on conversation switches", async () => {
    const consumed = vi.fn();
    const p = renderChat([], {
      libraryAttachments: { conversationId: 1, attachments: [{ id: "library-7", kind: "document", original_filename: "资料.txt", parse_status: "parsed" }] },
      onLibraryAttachmentsConsumed: consumed,
    });
    expect(await screen.findByRole("button", { name: "移除 资料.txt" })).toBeInTheDocument();
    expect(consumed).toHaveBeenCalledOnce();
    p.view.rerender(<ChatWorkspace {...p} libraryAttachments={null} />);
    expect(screen.getByRole("button", { name: "移除 资料.txt" })).toBeInTheDocument();
    p.view.rerender(<ChatWorkspace {...p} libraryAttachments={null} currentConversationId={2} />);
    p.view.rerender(<ChatWorkspace {...p} libraryAttachments={null} currentConversationId={1} />);
    expect(screen.queryByRole("button", { name: "移除 资料.txt" })).not.toBeInTheDocument();
  });

  it("offers model settings when service is unavailable", () => {
    const props = renderChat([], { modelUnavailable: "模型连接失败" });
    expect(screen.getByRole("alert")).toHaveTextContent("模型连接失败");
    fireEvent.click(screen.getByRole("button", { name: "去设置模型" }));
    expect(props.onOpenModelSettings).toHaveBeenCalledOnce();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("announces the pre-send model check", () => {
    renderChat([], { modelChecking: true, chatBusy: true });
    expect(screen.getByText("正在检查模型服务…")).toBeInTheDocument();
  });

  it("keeps conversation actions without a second route heading", () => {
    renderChat();

    expect(screen.getByLabelText("对话操作栏")).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "对话操作" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重命名对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("准备中")).not.toBeInTheDocument();
    expect(screen.queryByText("团团 · 面试准备")).not.toBeInTheDocument();
  });

  it("continues an interrupted durable run through the retry callback", () => {
    const retryDraft: ChatRetryDraft = {
      content: "继续分析这份材料",
      attachmentIds: ["attachment-1"],
      visionAttachmentIds: [],
      webSearch: true,
      webSearchTopic: "general",
      webSearchSourcePreference: "technical",
      runId: "run-recover-1",
      reason: "interrupted"
    };
    const props = renderChat([message], { retryDraft });

    expect(screen.getByLabelText("任务恢复提示")).toHaveTextContent("可从最近检查点继续");
    fireEvent.click(screen.getByRole("button", { name: "继续执行" }));

    expect(props.onRetry).toHaveBeenCalledWith(retryDraft);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("keeps only new conversation and history in the conversation rail", () => {
    renderChat();

    const header = screen.getByLabelText("对话操作栏");
    const thread = document.querySelector(".chat-thread");
    expect(header.compareDocumentPosition(thread as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header).not.toHaveTextContent(conversation.title);
    expect(header.querySelector(".chat-session-title")).not.toBeInTheDocument();
    expect(header.querySelector(".chat-session-tools")).toBe(screen.getByRole("toolbar", { name: "对话操作" }));
    expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对话记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出对话" })).toBeInTheDocument();
    expect(within(header).getAllByRole("button")).toHaveLength(3);
    expect(within(header).queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    expect(header.querySelector(".chat-session-tools")).not.toHaveTextContent("新对话");
    expect(header.querySelector(".chat-session-tools")).not.toHaveTextContent("历史");
  });

  it("recedes an untitled session so the welcome owns the empty canvas", () => {
    render(
      <ChatWorkspace
        conversationTitle=""
        messages={[]}
        hiddenMessageCount={0}
        chatBusy={false}
        currentConversationId={null}
        conversations={[]}
        conversationBusy={false}
        waitingForUser={false}
        taskCancelBusy={false}
        retryDraft={null}
        chatEndRef={createRef<HTMLDivElement>()}
        chatInputRef={createRef<HTMLTextAreaElement>()}
        onLoadMore={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
        onRemoveConversation={vi.fn()}
        attachmentBusy={false}
        attachmentConfig={null}
        onUploadAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onAttachmentInvalid={vi.fn()}
        onSuggestedAction={vi.fn()}
        onCancelTask={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
      />
    );

    const header = screen.getByLabelText("对话操作栏");
    expect(header).not.toHaveTextContent("新对话");
    expect(screen.getByRole("toolbar", { name: "对话操作" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "今天，想完成什么？" })).toBeInTheDocument();
  });

  it("recedes a default-titled empty session so the opening line owns the canvas", () => {
    render(
      <ChatWorkspace
        conversationTitle="新对话"
        messages={[]}
        hiddenMessageCount={0}
        chatBusy={false}
        currentConversationId={1}
        conversations={[{ ...conversation, title: "新对话" }]}
        conversationBusy={false}
        waitingForUser={false}
        taskCancelBusy={false}
        retryDraft={null}
        chatEndRef={createRef<HTMLDivElement>()}
        chatInputRef={createRef<HTMLTextAreaElement>()}
        onLoadMore={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
        onRemoveConversation={vi.fn()}
        attachmentBusy={false}
        attachmentConfig={null}
        onUploadAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onAttachmentInvalid={vi.fn()}
        onSuggestedAction={vi.fn()}
        onCancelTask={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
      />
    );

    const header = screen.getByLabelText("对话操作栏");
    expect(header).not.toHaveTextContent("新对话");
    expect(screen.getByRole("heading", { level: 2, name: "今天，想完成什么？" })).toBeInTheDocument();
  });

  it("views and renames the current conversation from history", () => {
    const props = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    const history = screen.getByRole("complementary", { name: "对话记录" });
    expect(within(history).getByText(conversation.title).closest("button")).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(history).getByRole("button", { name: `${conversation.title} 的更多操作` }));
    fireEvent.click(within(history).getByRole("menuitem", { name: "重命名" }));

    expect(props.onRenameConversation).toHaveBeenCalledWith(conversation);
  });

  it("marks the history tool as open while the drawer is visible", () => {
    renderChat();

    const toggle = screen.getByRole("button", { name: "对话记录" });
    fireEvent.click(toggle);

    expect(toggle).toHaveClass("is-open");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "对话记录" })).toBeInTheDocument();
  });

  it("opens conversation history as a drawer instead of a persistent column", () => {
    renderChat();

    expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "对话记录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));

    expect(screen.getAllByRole("button", { name: "新建对话" })).toHaveLength(2);
    expect(screen.getByRole("complementary", { name: "对话记录" })).toBeInTheDocument();
  });

  it("creates a conversation from the session header", () => {
    const props = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));

    expect(props.onCreateConversation).toHaveBeenCalledOnce();
  });

  it("closes the conversation drawer with Escape", () => {
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    expect(screen.getByRole("complementary", { name: "对话记录" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("complementary", { name: "对话记录" })).not.toBeInTheDocument();
  });

  it("renders an opening line and composer without optional draft shortcuts", () => {
    renderChat([]);

    expect(screen.queryByText("准备与复盘")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "今天，想完成什么？" })).toBeInTheDocument();
    expect(screen.queryByText("没有固定题目。想出题去面试问答，想拆项目去项目解析。")).not.toBeInTheDocument();
    expect(screen.queryByText("面试问答")).not.toBeInTheDocument();
    expect(screen.queryByText("项目解析")).not.toBeInTheDocument();
    expect(screen.getByText("提问、查资料，或描述你想生成的图片。")).toBeInTheDocument();
    expect(screen.queryByLabelText("可选草稿")).not.toBeInTheDocument();
    const welcome = document.querySelector(".chat-welcome");
    const composer = document.querySelector(".chat-composer");
    expect(composer?.contains(welcome as Node)).toBe(true);
    expect(document.querySelector(".composer-drafts")).toBeNull();
    expect(screen.queryByRole("button", { name: "梳理已保存资料" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析一份材料" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查找公开信息" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "起草一份内容" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("输入消息")).toHaveAttribute("placeholder", "直接说说你的想法…");
  });

  it("keeps the opening hint visible and separates supporting tools from model and send actions", () => {
    const props = renderChat([]);
    const tools = screen.getByRole("group", { name: "输入选项" });
    expect(within(tools).getByRole("button", { name: "添加附件" })).toHaveTextContent("添加资料");
    expect(within(tools).getByRole("button", { name: "联网搜索" })).toHaveAttribute("aria-pressed", "false");
    expect(within(tools).queryByRole("button", { name: /切换模型/ })).not.toBeInTheDocument();
    const actions = props.view.container.querySelector(".composer-primary-actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: /切换模型/ })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "发送" })).toBeDisabled();
    expect(props.view.container.querySelector(".composer-input-hint")).toHaveAttribute("aria-hidden", "false");
  });

  it("hides starter prompts once the conversation has messages", () => {
    renderChat();

    expect(screen.queryByLabelText("可选草稿")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析一份材料" })).not.toBeInTheDocument();
  });

  it("keeps normal messages sendable when the search service is unavailable", async () => {
    const props = renderChat([]);
    props.view.rerender(<ChatWorkspace {...props} webSearchEnabled webSearchAvailable={false} />);
    expect(screen.getByRole("button", { name: "联网搜索" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "联网搜索" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "帮我润色这句话" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("帮我润色这句话", [], [], false));
  });

  it("keeps saved-material access out of the composer while retaining analysis context", () => {
    const onOpenLibrary = vi.fn();
    const onSend = vi.fn();
    render(
      <ChatWorkspace
        {...{
          conversationTitle: "新对话",
          messages: [],
          hiddenMessageCount: 0,
          chatBusy: false,
          currentConversationId: 1,
          conversations: [conversation],
          conversationBusy: false,
          waitingForUser: false,
          taskCancelBusy: false,
          retryDraft: null,
          chatEndRef: createRef<HTMLDivElement>(),
          chatInputRef: createRef<HTMLTextAreaElement>(),
          onLoadMore: vi.fn(),
          onSelectConversation: vi.fn(),
          onCreateConversation: vi.fn(),
          onRenameConversation: vi.fn(),
          onArchiveConversation: vi.fn(),
          onRemoveConversation: vi.fn(),
          attachmentBusy: false,
          attachmentConfig: null,
          onUploadAttachment: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onAttachmentInvalid: vi.fn(),
          onSuggestedAction: vi.fn(),
          onCancelTask: vi.fn(),
          onSend,
          onStop: vi.fn(),
          onEdit: vi.fn(),
          onRegenerate: vi.fn(),
          onOpenLibrary,
          sessionContext: { sourceLabel: "resume.pdf", analysisLabel: "示例公司 · 后端" }
        }}
      />
    );

    expect(screen.queryByRole("button", { name: "查看已保存资料" })).not.toBeInTheDocument();
    expect(screen.queryByText("已保存资料", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("示例公司 · 后端")).toBeInTheDocument();
    expect(screen.queryByText("分析")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析" })).not.toBeInTheDocument();
    expect(screen.queryByText("参考简历原文")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "梳理已保存资料" })).not.toBeInTheDocument();

    expect(onOpenLibrary).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText("输入消息")).toHaveValue("");
  });

  it("shows clarification choices in the composer and sends the selected option", async () => {
    const onSend = vi.fn();
    const onSuggestedAction = vi.fn();
    render(
      <ChatWorkspace
        {...{
          conversationTitle: conversation.title,
          messages: [message, {
            id: 12,
            role: "assistant",
            content: "你指的是哪家公司？",
            created_at: "2026-08-11T00:01:00Z",
            payload: {
              agent: {
                provider: "test",
                platform: "local",
                rounds: 1,
                status: "waiting_user",
                events: [{
                  round: 1,
                  tool_call_id: "ask-1",
                  tool_name: "ask_user",
                  status: "waiting_approval",
                  message: "你指的是哪家公司？",
                  data: {
                    clarification: {
                      question: "你指的是哪家公司？",
                      options: [
                        { id: "opt_1", label: "字节跳动", send: "按字节跳动继续" },
                        { id: "opt_2", label: "字节跳动教育", send: "按字节跳动教育继续" }
                      ],
                      allow_custom: true
                    }
                  }
                }]
              }
            }
          }],
          hiddenMessageCount: 0,
          chatBusy: false,
          currentConversationId: conversation.id,
          conversations: [conversation],
          conversationBusy: false,
          waitingForUser: true,
          latestAgent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "waiting_user",
            events: [{
              round: 1,
              tool_call_id: "ask-1",
              tool_name: "ask_user",
              status: "waiting_approval",
              message: "你指的是哪家公司？",
              data: {
                clarification: {
                  question: "你指的是哪家公司？",
                  options: [
                    { id: "opt_1", label: "字节跳动", send: "按字节跳动继续" },
                    { id: "opt_2", label: "字节跳动教育", send: "按字节跳动教育继续" }
                  ],
                  allow_custom: true
                }
              }
            }]
          },
          taskCancelBusy: false,
          retryDraft: null,
          chatEndRef: createRef<HTMLDivElement>(),
          chatInputRef: createRef<HTMLTextAreaElement>(),
          onLoadMore: vi.fn(),
          onSelectConversation: vi.fn(),
          onCreateConversation: vi.fn(),
          onRenameConversation: vi.fn(),
          onArchiveConversation: vi.fn(),
          onRemoveConversation: vi.fn(),
          attachmentBusy: false,
          attachmentConfig: null,
          onUploadAttachment: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onAttachmentInvalid: vi.fn(),
          onSuggestedAction,
          onCancelTask: vi.fn(),
          onSend,
          onStop: vi.fn(),
          onEdit: vi.fn(),
          onRegenerate: vi.fn()
        }}
      />
    );

    const clarifier = screen.getByLabelText("需要你确认后继续");
    expect(clarifier).toHaveTextContent("你指的是哪家公司？");
    expect(screen.getByLabelText("输入消息")).toHaveAttribute("placeholder", "回答上面的问题，或直接说下一件…");
    expect(clarifier).toHaveTextContent("答当前问题则继续");
    expect(screen.queryByRole("button", { name: /继续处理/ })).not.toBeInTheDocument();
    expect(screen.queryByText("已暂停，等待你的操作")).not.toBeInTheDocument();
    expect(document.querySelector(".message-run-result")).not.toBeInTheDocument();
    expect(screen.getByLabelText("输出结果")).toHaveTextContent("你指的是哪家公司？");

    fireEvent.click(screen.getByRole("button", { name: "字节跳动" }));
    expect(onSend).toHaveBeenCalledWith("按字节跳动继续", [], [], false);
    expect(onSuggestedAction).not.toHaveBeenCalled();
  });

  it("does not expose raw historical reasoning or offer an empty process panel", () => {
    renderChat([{
      id: 12,
      role: "assistant",
      content: "可以。下面从项目目标开始问。",
      created_at: "2026-08-11T00:01:00Z",
      payload: {
        agent: {
          provider: "test",
          platform: "local",
          rounds: 1,
          status: "done",
          events: [{
            round: 1,
            tool_call_id: "think-1",
            tool_name: "agent_thinking",
            status: "done",
            message: "先确认项目范围，再追问取舍。"
          }]
        }
      }
    }]);

    expect(screen.queryByRole("button", { name: "查看过程，打开研究详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "来源详情" })).not.toBeInTheDocument();
    expect(screen.queryByText("先确认项目范围，再追问取舍。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开思考与执行过程" })).not.toBeInTheDocument();
  });

  it("expands thinking with live tool work and hides the local route summary", () => {
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [
              {
                round: 0,
                tool_call_id: "think-1",
                tool_name: "agent_thinking",
                status: "done",
                message: "已识别为公司公开信息研究，需要先规划并限制可用工具"
              },
              {
                round: 0,
                tool_call_id: "plan-1",
                tool_name: "agent_planner",
                status: "done",
                message: "已规划 1 个步骤：核验腾讯科技公开信息",
                data: { plan: { steps: [{ title: "核验腾讯科技公开信息", tool_name: "search_public_web" }] } }
              },
              {
                round: 1,
                tool_call_id: "call-1",
                tool_name: "search_public_web",
                status: "running",
                message: "正在检索：腾讯科技",
                data: { arguments: { company_name: "腾讯科技" } }
              }
            ]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.getByRole("status")).toHaveTextContent("正在检索：腾讯科技");
    const toggle = screen.getByRole("button", { name: "收起思考与执行过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const body = screen.getByRole("region", { name: "思考与执行过程" });
    expect(body).not.toHaveTextContent("已识别为公司公开信息研究，需要先规划并限制可用工具");
    expect(body).toHaveTextContent("已规划 1 个步骤");
    expect(body).not.toHaveTextContent("已规划 1 个步骤：核验腾讯科技公开信息");
    fireEvent.click(screen.getByRole("button", { name: "展开已规划 1 个步骤的执行说明" }));
    expect(body).toHaveTextContent("核验腾讯科技公开信息");
    expect(body).toHaveTextContent("腾讯科技");
    expect(body.closest(".chat-composer")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "来源详情" })).not.toBeInTheDocument();
  });

  it("does not show the local route summary while waiting for the first real step", () => {
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 0,
            status: "done",
            events: [{
              round: 0,
              tool_call_id: "think-1",
              tool_name: "agent_thinking",
              status: "done",
              message: "已识别为公司公开信息研究，需要先规划并限制可用工具"
            }]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.getAllByText("正在等待模型响应").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "正在等待模型响应" })).not.toBeInTheDocument();
    expect(screen.queryByText(/已识别为/)).not.toBeInTheDocument();
    expect(document.querySelector(".thinking-process-scroll")).not.toBeInTheDocument();
  });

  it("shows completion repair as a friendly system activity", () => {
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [{
              round: 1,
              tool_call_id: "completion-validation-1",
              tool_name: "completion_validator",
              status: "running",
              message: "必要步骤尚未完成，正在继续执行",
              data: { missing_tools: ["search_public_web"] }
            }]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.getByRole("status")).toHaveTextContent("必要步骤尚未完成，正在继续执行");
    const toggle = screen.getByRole("button", { name: "收起思考与执行过程" });
    expect(toggle).not.toHaveTextContent("search_public_web");
    expect(screen.getByRole("region", { name: "思考与执行过程" }))
      .toHaveTextContent("必要步骤尚未完成，正在继续执行");
  });

  it("shows loop correction without exposing the tool fingerprint", () => {
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 2,
            status: "done",
            events: [{
              round: 2,
              tool_call_id: "research-repeat",
              tool_name: "agent_loop_guard",
              status: "running",
              message: "已跳过重复工具调用，正在推进下一步",
              data: { tool_name: "search_public_web", fingerprint: "opaque-secret" }
            }]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.getByRole("status")).toHaveTextContent("已跳过重复工具调用，正在推进下一步");
    const toggle = screen.getByRole("button", { name: "收起思考与执行过程" });
    expect(toggle).not.toHaveTextContent("opaque-secret");
    expect(screen.getByRole("region", { name: "思考与执行过程" }))
      .toHaveTextContent("已跳过重复工具调用，正在推进下一步");
  });

  it("appends fetched source hosts after a research tool finishes", () => {
    renderChat([{
      id: 12,
      role: "assistant",
      content: "腾讯是一家互联网公司。",
      created_at: "2026-08-11T00:01:00Z",
      payload: {
        agent: {
          provider: "test",
          platform: "local",
          rounds: 1,
          status: "done",
          events: [
            {
              round: 0,
              tool_call_id: "think-1",
              tool_name: "agent_thinking",
              status: "done",
              message: "已识别为公司公开信息研究，需要先规划并限制可用工具"
            },
            {
              round: 1,
              tool_call_id: "call-1",
              tool_name: "search_public_web",
              status: "done",
              message: "已找到并读取 2 条公开公司资料，可生成带来源的公司研究报告",
              data: {
                sources: [
                  { title: "天眼查", url: "https://www.tianyancha.com/company/1", domain: "www.tianyancha.com" },
                  { title: "官网", url: "https://www.tencent.com/", domain: "www.tencent.com", snippet: "腾讯官网摘要", content: "整页抓取内容与导航" }
                ]
              }
            }
          ]
        }
      }
    }]);

    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.queryByText(/已识别为/)).not.toBeInTheDocument();
    expect(screen.getByText("已找到并读取 2 条公开公司资料，可生成带来源的公司研究报告")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看全部 2 个来源" }));
    const sourcePanel = screen.getByRole("complementary", { name: "来源详情" });
    expect(sourcePanel).not.toHaveTextContent("已找到并读取 2 条公开公司资料，可生成带来源的公司研究报告");
    expect(screen.getByText("2 个来源")).toBeVisible();
    expect(within(sourcePanel).getByRole("link", { name: "天眼查" })).toHaveAttribute("href", "https://www.tianyancha.com/company/1");
    expect(within(sourcePanel).getByRole("link", { name: "官网" })).toHaveAttribute("href", "https://www.tencent.com/");
    expect(within(sourcePanel).queryByRole("article")).not.toBeInTheDocument();
    expect(sourcePanel).not.toHaveTextContent("腾讯官网摘要");
    expect(sourcePanel).not.toHaveTextContent("整页抓取内容与导航");
    expect(screen.queryByRole("link", { name: /打开原网页/ })).not.toBeInTheDocument();
  });

  it("shows a specific thinking placeholder while waiting for the first assistant token", async () => {
    const props = renderChat([message], { chatBusy: true });

    expect(screen.getAllByText("正在等待模型响应")).toHaveLength(1);
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    expect(process.closest(".chat-thread")).not.toBeNull();
    expect(process.closest(".chat-composer")).toBeNull();
    expect(props.view.container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(props.view.container.querySelector(".chat-composer .run-process")).not.toBeInTheDocument();
    expect(props.view.container.querySelector(".chat-run-status")).not.toBeInTheDocument();
    expect(screen.queryByText("等待模型响应…")).not.toBeInTheDocument();
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
    props.view.rerender(<ChatWorkspace {...props} messages={[message, assistantMessage("", -1)]} />);
    await waitFor(() => expect(screen.getAllByRole("region", { name: "思考与执行过程" })).toHaveLength(1));
    expect(props.view.container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(props.view.container.querySelector(".chat-composer .run-process")).not.toBeInTheDocument();
  });

  it("does not append a second placeholder after the terminal assistant arrives while busy clears", () => {
    const agent: AgentRunResult = {
      provider: "test", platform: "local", rounds: 1, status: "done", duration_ms: 3_000,
      events: [{ round: 1, tool_call_id: "thought-1", tool_name: "agent_thinking", status: "done", message: "已核对来源并整理结论。" }]
    };
    const props = renderChat([message, { ...assistantMessage("最终回答"), payload: { agent } }], { chatBusy: true });
    expect(screen.getAllByRole("region", { name: "思考与执行过程" })).toHaveLength(1);
    expect(props.view.container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("用时 3s");
    expect(screen.queryByText("等待模型响应…")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("最终回答")).toBeVisible();
    expect(props.view.container.querySelector(".run-process .spinning")).not.toBeInTheDocument();
  });

  it("shows the current executing task in the header and its record", () => {
    const thoughtBody = "先确认项目范围，再对照公司公开资料展开追问。";
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [
              {
                round: 1,
                tool_call_id: "think-1",
                tool_name: "agent_thinking",
                status: "done",
                message: thoughtBody
              },
              {
                round: 1,
                tool_call_id: "call-1",
                tool_name: "search_public_web",
                status: "running",
                message: "正在执行 search_public_web"
              }
            ],
            plan: {
              goal: "核验公司",
              route: "company_research",
              requires_confirmation: false,
              steps: [{
                id: "s1",
                title: "搜索公司资料",
                tool_name: "search_public_web",
                risk: "read_only",
                status: "running"
              }]
            }
          }
        }
      }
    ], { chatBusy: true });

    const toggle = screen.getByRole("button", { name: "收起思考与执行过程" });
    expect(screen.getAllByText(/正在进行：搜索公司资料/)).toHaveLength(2);
    expect(toggle).toHaveTextContent("搜索公司资料");
    expect(toggle).not.toHaveTextContent(thoughtBody);
    expect(screen.queryByText(thoughtBody)).not.toBeInTheDocument();
    expect(toggle.closest(".chat-composer")).toBeNull();
  });

  it("uses the latest tool event message in the live activity", () => {
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [{
              round: 1,
              tool_call_id: "call-2",
              tool_name: "search_library",
              status: "running",
              message: "正在从简历中定位项目证据"
            }]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.getAllByText("正在从简历中定位项目证据")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "收起思考与执行过程" })).toHaveTextContent("正在从简历中定位项目证据");
  });

  it("shows a thinking status without exposing raw reasoning or an empty source panel", () => {
    const thoughtBody = "我先读取简历，再对比岗位要求，然后整理成面试可讲的要点。";
    renderChat([
      message,
      {
        id: -1,
        role: "assistant",
        content: "",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [{
              round: 1,
              tool_call_id: "think-1",
              tool_name: "agent_thinking",
              status: "running",
              message: thoughtBody
            }]
          }
        }
      }
    ], { chatBusy: true });

    expect(screen.queryByRole("button", { name: "查看过程，打开研究详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    expect(screen.queryByText(thoughtBody)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在思考");
  });

  it("renders in-text source links as numbered citation previews", async () => {
    renderChat([
      message,
      {
        id: 12,
        role: "assistant",
        content: "腾讯科技成立于2000年，来源：[天眼查](https://www.tianyancha.com/company/150041670)。",
        created_at: "2026-08-11T00:01:00Z",
        payload: {
          agent: {
            provider: "test",
            platform: "local",
            rounds: 1,
            status: "done",
            events: [{
              round: 1,
              tool_call_id: "web-1",
              tool_name: "search_public_web",
              status: "done",
              message: "ok",
              data: {
                sources: [{
                  title: "腾讯科技（深圳）有限公司",
                  url: "https://www.tianyancha.com/company/150041670",
                  domain: "www.tianyancha.com"
                }]
              }
            }]
          }
        }
      }
    ]);

    const citation = screen.getByRole("link", { name: "来源 1：腾讯科技（深圳）有限公司" });
    expect(citation).toHaveClass("md-citation");
    expect(citation).toHaveAttribute("href", "https://www.tianyancha.com/company/150041670");
    expect(citation).toHaveAttribute("target", "_blank");
    expect(citation.querySelector(".md-citation-badge")).toHaveTextContent("1");
    expect(screen.queryByRole("link", { name: "天眼查" })).not.toBeInTheDocument();
    expect(citation).toHaveTextContent("腾讯科技（深圳）有限公司");
    expect(citation).toHaveTextContent("www.tianyancha.com");

    const viewport = screen.getByRole("log");
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
    viewport.scrollTop = 217;
    fireEvent.scroll(viewport);
    fireEvent.click(citation);
    expect(screen.getByRole("complementary", { name: "来源详情" })).toHaveTextContent("腾讯科技（深圳）有限公司");
    expect(within(screen.getByRole("complementary", { name: "来源详情" })).getByRole("link", { name: "腾讯科技（深圳）有限公司" })).toHaveAttribute("target", "_blank");
    viewport.scrollTop = 0;
    fireEvent.click(within(screen.getByRole("complementary", { name: "来源详情" })).getByRole("button", { name: "关闭来源详情" }));
    await waitFor(() => expect(citation).toHaveFocus());
    await waitFor(() => expect(viewport.scrollTop).toBe(217));
  });

  it("opens source evidence from a message and closes it without a header source toggle", async () => {
    renderChat([{
      id: 12,
      role: "assistant",
      content: "已完成联网核验。",
      created_at: "2026-08-11T00:01:00Z",
      payload: {
        agent: {
          provider: "test",
          platform: "local",
          rounds: 1,
          status: "done",
          events: [{
            round: 1,
            tool_call_id: "web-detail",
            tool_name: "search_public_web",
            status: "done",
            message: "ok",
            data: {
              sources: [{
                title: "Python 官方文档",
                url: "https://docs.python.org/3/library/asyncio.html",
                domain: "docs.python.org",
                snippet: "asyncio 用于编写并发代码。",
                published_at: "2026-08-01"
              }]
            }
          }]
        }
      }
    }]);

    expect(within(screen.getByLabelText("对话操作栏")).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    const sourceDetails = screen.getByRole("button", { name: "查看全部 1 个来源" });
    sourceDetails.focus();
    fireEvent.click(sourceDetails);
    const panel = screen.getByRole("complementary", { name: "来源详情" });
    expect(panel).not.toHaveTextContent("asyncio 用于编写并发代码");
    expect(within(panel).getByRole("link", { name: "Python 官方文档" })).toHaveAttribute("href", "https://docs.python.org/3/library/asyncio.html");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "来源详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "来源详情" })).not.toBeInTheDocument();
    await waitFor(() => expect(sourceDetails).toHaveFocus());
  });

  it("renders each Mermaid block in its own stable container", async () => {
    const first = "flowchart LR\n  A --> B";
    const second = "sequenceDiagram\n  Alice->>Bob: Hello";
    renderChat([assistantMessage(`${fencedMermaid(first)}\n\n${fencedMermaid(second)}`)]);

    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(2));

    const diagrams = screen.getAllByTestId("mermaid-diagram");
    const containers = screen.getAllByRole("img", { name: "Mermaid 图表" });
    expect(diagrams).toHaveLength(2);
    expect(containers[0].id).not.toBe(containers[1].id);
    expect(containers[0].querySelector("[data-rendered-mermaid]")).toBeInTheDocument();
    expect(containers[1].querySelector("[data-rendered-mermaid]")).toBeInTheDocument();
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      flowchart: { htmlLabels: false }
    }));
  });

  it("renders mermaid mindmaps as an interactive outline, not a static image", () => {
    const source = "mindmap\n  root((求职准备))\n    简历\n    面试";
    renderChat([assistantMessage(fencedMermaid(source))]);

    expect(screen.getByTestId("interactive-mindmap")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /求职准备/ })).toBeInTheDocument();
    expect(screen.getByText("点击节点展开或收起，拖动画布移动；可全屏查看或复位视图。")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Mermaid 图表" })).not.toBeInTheDocument();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("shows a copyable source fallback when a mindmap cannot be parsed", () => {
    const source = "mindmap\n  root((未闭合)";
    renderChat([assistantMessage(fencedMermaid(source))]);

    const fallback = screen.getByRole("alert");
    expect(fallback).toHaveTextContent("暂时无法显示这张思维导图");
    expect(fallback.querySelector("code.language-mermaid")?.textContent).toBe(source);
    expect(screen.getByRole("button", { name: "复制源码" })).toBeInTheDocument();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("shows a copyable source fallback when Mermaid rendering fails", async () => {
    const source = "flowchart LR\n  A -->";
    mermaidMocks.render.mockRejectedValueOnce(new Error("parse error"));
    renderChat([assistantMessage(fencedMermaid(source))]);

    const fallback = await screen.findByRole("alert");
    expect(fallback).toHaveTextContent("暂时无法显示这张图");
    expect(fallback.querySelector("code.language-mermaid")?.textContent).toBe(source);
    expect(screen.getByRole("button", { name: "复制源码" })).toBeInTheDocument();
  });

  it("keeps user copy and edit under the cue bubble", () => {
    renderChat();

    const bubble = document.querySelector(".message.user .message-dialog");
    const copy = screen.getByLabelText("复制消息");
    const edit = screen.getByLabelText("编辑消息");
    expect(bubble).toHaveTextContent("围绕一个项目追问我");
    expect(bubble?.contains(copy)).toBe(false);
    expect(copy.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves non-Mermaid code blocks unchanged", () => {
    renderChat([assistantMessage(["```typescript", "const answer = 42;", "```"].join("\n"))]);

    const code = document.querySelector("pre > code.language-typescript");
    expect(code).toHaveTextContent("const answer = 42;");
    expect(screen.queryByTestId("mermaid-diagram")).not.toBeInTheDocument();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("waits for streaming to finish before rendering Mermaid", () => {
    renderChat([
      message,
      assistantMessage(["```mermaid", "mindmap", "  root((准备中))"].join("\n"), -1)
    ], { chatBusy: true });

    expect(screen.getByText("思维导图生成中，完成后可展开查看…")).toBeInTheDocument();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

 it("keeps the popup welcome in the message area above the composer", () => {
   renderChat([], { density: "dock" });
   const welcome = screen.getByRole("heading", { name: "有什么可以帮你？" });
   expect(welcome.closest(".chat-thread")).not.toBeNull();
   expect(welcome.closest(".chat-composer")).toBeNull();
   expect(screen.getByRole("textbox", { name: "输入消息" })).toBeInTheDocument();
 });
