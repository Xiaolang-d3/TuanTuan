import { AssistantRuntimeProvider, ThreadPrimitive, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { CheckCircle2, Download, History, Plus, TriangleAlert, X } from "lucide-react";
import { useCallback, useState } from "react";
import { AttachmentPreviewContext, AttachmentPreviewDialog } from "../features/chat/AttachmentPreviewDialog";
import { DocumentReviewPanel } from "../features/chat/DocumentReviewPanel";
import { AssetOriginalContext, LatestGeneratedImageContext } from "../features/chat/GeneratedImage";
import { AttachmentThumbnailContext } from "../features/chat/HistoryAttachment";
import { DeleteTurnContext, QuoteSelectionContext, ResearchPanel, ResearchPanelActionsContext, textFromAppendMessage } from "../features/chat/MessagePresentation";
import { ResultDialog } from "../features/chat/ResultDialog";
import { DocumentActionsContext, ResultActionsContext } from "../features/chat/result-types";
import type { AgentRunResult, ChatClarification, ChatClarificationOption, ChatMessage, ChatWorkspaceProps } from "../features/chat/types";
import { PresentationChat } from "../features/extensions/PresentationChat";
import { ChatComposer } from "./chat-workspace/ChatComposer";
import { ChatComposerStatus } from "./chat-workspace/ChatComposerStatus";
import { ChatThread } from "./chat-workspace/ChatThread";
import { useComposerAttachments } from "./chat-workspace/useComposerAttachments";
import { useConversationAttachments } from "./chat-workspace/useConversationAttachments";
import { useConversationComposer } from "./chat-workspace/useConversationComposer";
import { useQuickPresentationComposer } from "./chat-workspace/useQuickPresentationComposer";
import { useWorkspacePanels } from "./chat-workspace/useWorkspacePanels";
import { ConversationHistoryPanel } from "./ConversationHistoryPanel";
import "./ChatWorkspace.css";
import "./ChatComposer.css";
import "./ChatModelSelection.css";

function asClarificationOption(value: unknown, index: number): ChatClarificationOption | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label) return null;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `opt_${index + 1}`;
  const send = typeof record.send === "string" && record.send.trim() ? record.send.trim() : label;
  return { id, label, send };
}

export function clarificationFromAgent(run?: AgentRunResult): ChatClarification | null {
  if (!run || run.status !== "waiting_user") return null;
  for (const event of [...run.events].reverse()) {
    const raw = event.data?.clarification;
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const options = Array.isArray(record.options)
      ? record.options.flatMap((item, index) => {
        const option = asClarificationOption(item, index);
        return option ? [option] : [];
      })
      : [];
    if (!question && !options.length) continue;
    return { question, options, allowCustom: record.allow_custom !== false };
  }
  return null;
}

type ChatWorkspaceContentProps = ChatWorkspaceProps & {
  attachments: Pick<ReturnType<typeof useConversationAttachments>,
    "pendingAttachments" | "previewUrls" | "localFiles" | "uploadingPreview"
    | "uploadAttachment" | "removePendingAttachment" | "clearSubmittedAttachments"
  >;
  webSearchActive: boolean;
};

function ChatWorkspaceContent({ attachments, webSearchActive, ...props }: ChatWorkspaceContentProps) {
  const { pendingAttachments, previewUrls, localFiles, uploadingPreview } = attachments;
  const conversationId = props.currentConversationId;
  const [presentationContent, setPresentationContent] = useState<{ conversationId: number; hasContent: boolean } | null>(null);
  const [reviewContent, setReviewContent] = useState<{ conversationId: number | null; hasContent: boolean } | null>(null);
  const handleReviewContentChange = useCallback((hasContent: boolean) => {
    setReviewContent(previous => previous?.conversationId === conversationId && previous.hasContent === hasContent ? previous : { conversationId, hasContent });
  }, [conversationId]);
  const handlePresentationContentChange = useCallback((conversationId: number, hasContent: boolean) => {
    setPresentationContent(previous => previous?.conversationId === conversationId && previous.hasContent === hasContent ? previous : { conversationId, hasContent });
  }, []);
  const hasConversationContent = props.messages.length > 0 || (presentationContent?.conversationId === conversationId && presentationContent.hasContent) || (reviewContent?.conversationId === conversationId && reviewContent.hasContent);
  const composer = useConversationComposer(props);
  const quickPresentation = useQuickPresentationComposer({ ...props, pendingAttachments, onClearSubmittedAttachments: attachments.clearSubmittedAttachments }, composer);
  const { presentationService, pptSelected, quickMode, quickBusy, modelScope, submittedJob, reuseQuickPpt } = quickPresentation;
  const attachmentInput = useComposerAttachments({ ...props, pendingAttachments, onUpload: attachments.uploadAttachment }, quickMode, quickBusy);
  const {
    expandedPreview, setExpandedPreview, gallery, resultSelection, setResultSelection,
    conversationListOpen, setConversationListOpen, researchPanelOpen, activeResearch,
    scrolling, openResearchDetails, closeResearchDetails,
  } = useWorkspacePanels({ ...props, pendingAttachments });
  const projectContext = props.conversations.find(conversation => conversation.id === conversationId)?.project_context;
  const clarification = clarificationFromAgent(props.latestAgent);
  const modelFeedback = props.modelSelectionFeedback ? (
    <div className={`composer-model-feedback ${props.modelSelectionFeedback.kind}`} role={props.modelSelectionFeedback.kind === "error" ? "alert" : "status"}>
      {props.modelSelectionFeedback.kind === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
      <span>{props.modelSelectionFeedback.text}</span>
      <button type="button" aria-label="关闭模型切换提示" onClick={props.onDismissModelSelectionFeedback}><X size={14} /></button>
    </div>
  ) : null;

  return (
    <section className={`chat-workspace ${props.density === "dock" ? "is-dock" : "is-page"} ${props.focused ? "is-focused" : ""} ${hasConversationContent ? "has-history" : "is-empty"} ${props.chatBusy ? "is-running" : ""} ${researchPanelOpen ? "has-research-panel" : ""}`}>
      <ResearchPanelActionsContext.Provider value={{ openDetails: openResearchDetails }}>
      <QuoteSelectionContext.Provider value={composer.applyQuote}>
      <DeleteTurnContext.Provider value={props.onDeleteTurn ?? null}>
      <AttachmentPreviewContext.Provider value={setExpandedPreview}>
      <LatestGeneratedImageContext.Provider value={props.messages.flatMap(message => message.payload?.agent?.assets ?? []).at(-1)?.id}>
      <AssetOriginalContext.Provider value={props.onLoadAttachment}>
      <AttachmentThumbnailContext.Provider value={props.onLoadAttachmentThumbnail}>
      <ResultActionsContext.Provider value={props.onLoadResults ? (messageId, selector, saving) => setResultSelection({ messageId, selector, saving }) : null}>
      <DocumentActionsContext.Provider value={props.onEditDocument ?? (props.documentService && conversationId && props.onLoadResults ? messageId => setResultSelection({ messageId, selector: "answer", editing: true }) : null)}>
      <ThreadPrimitive.Root className="chat-main">
        <header className="chat-session-header" aria-label="对话操作栏">
          {projectContext && <details key={conversationId} className="chat-project-scope">
            <summary><span title={projectContext.name}>项目：{projectContext.name}</span><span className="chat-project-count">{projectContext.sources.length} 项资料</span></summary>
            <div className="chat-project-sources">
              <strong>本对话的项目资料范围</strong>
              <p>项目：{projectContext.name}</p>
              {projectContext.sources.length ? <ul>{projectContext.sources.map(source => <li key={source.id}>{source.title}</li>)}</ul> : <p>未选择项目资料</p>}
            </div>
          </details>}
          <div className="chat-session-tools" role="toolbar" aria-label="对话操作">
            <button
              className="chat-session-tool"
              type="button"
              onClick={props.onCreateConversation}
              disabled={props.conversationBusy}
              aria-label="新建对话"
              title="新建对话"
            >
              <Plus size={16} /><span>新建</span>
            </button>
            <button
              className={`chat-session-tool chat-history-toggle${conversationListOpen ? " is-open" : ""}`}
              type="button"
              onClick={() => setConversationListOpen((open) => !open)}
              aria-label="对话记录"
              aria-expanded={conversationListOpen}
              aria-controls="conversation-history-drawer"
              title="对话记录"
            >
              <History size={16} /><span>记录</span>
            </button>
            <button
              className="chat-session-tool"
              type="button"
              onClick={props.onExportConversation}
              disabled={!props.onExportConversation || (!props.messages.some((message) => message.id > 0) && props.hiddenMessageCount === 0)}
              aria-label="导出对话"
              title="导出对话"
            >
              <Download size={16} /><span>导出</span>
            </button>
          </div>
          {props.workspaceActions}
        </header>
        <ChatThread
          messages={props.messages}
          chatBusy={props.chatBusy}
          taskCancelBusy={props.taskCancelBusy}
          density={props.density}
          hiddenMessageCount={props.hiddenMessageCount}
          onLoadMore={props.onLoadMore}
          chatEndRef={props.chatEndRef}
          scrolling={scrolling}
          modelFeedback={hasConversationContent ? modelFeedback : null}
        >
          {presentationService && conversationId ? <PresentationChat service={presentationService} conversationId={conversationId} request={pptSelected && !quickMode ? 1 : 0} hideStoredForm={quickMode} modelScope={modelScope} disabled={Boolean(props.modelSelectionBusy)} submittedJob={submittedJob} onReuseQuick={reuseQuickPpt} onContentChange={handlePresentationContentChange} onOpenModelSettings={() => props.onOpenModelSettings?.()} /> : null}
          {props.documentReviewService && conversationId ? <DocumentReviewPanel service={props.documentReviewService} conversationId={conversationId} attachments={[...props.messages.flatMap(message => message.payload?.attachments ?? []), ...pendingAttachments]} onContentChange={handleReviewContentChange} /> : null}
        </ChatThread>
        <ChatComposer
          {...props}
          composer={composer}
          attachmentInput={attachmentInput}
          quickPresentation={quickPresentation}
          pendingAttachments={pendingAttachments}
          previewUrls={previewUrls}
          uploadingPreview={uploadingPreview}
          onPreviewAttachment={setExpandedPreview}
          onRemovePendingAttachment={attachments.removePendingAttachment}
          hasConversationContent={hasConversationContent}
          hasClarification={Boolean(clarification)}
          webSearchActive={webSearchActive}
          modelFeedback={hasConversationContent ? null : modelFeedback}
          notices={<ChatComposerStatus {...props} clarification={clarification} webSearchActive={webSearchActive} />}
          attachmentPreview={expandedPreview ? (
            <AttachmentPreviewDialog attachment={expandedPreview} localFile={localFiles[expandedPreview.id]} loadOriginal={props.onLoadAttachment} onEditGeneratedImage={props.onEditGeneratedImage} gallery={gallery} onNavigate={setExpandedPreview} onClose={() => setExpandedPreview(null)} />
          ) : null}
        />
      </ThreadPrimitive.Root>
      <ResearchPanel
        open={researchPanelOpen}
        agent={activeResearch.agent}
        sources={activeResearch.sources}
        selectedSource={activeResearch.selectedSource}
        streaming={props.chatBusy && activeResearch.agent === props.latestAgent}
        onClose={() => closeResearchDetails()}
      />
      {resultSelection ? <ResultDialog key={resultSelection.messageId} {...resultSelection} conversationId={conversationId ?? undefined} services={props} onClose={() => setResultSelection(null)} /> : null}
      </DocumentActionsContext.Provider>
      </ResultActionsContext.Provider>
      </AttachmentThumbnailContext.Provider>
      </AssetOriginalContext.Provider>
      </LatestGeneratedImageContext.Provider>
      </AttachmentPreviewContext.Provider>
      </DeleteTurnContext.Provider>
      </QuoteSelectionContext.Provider>
      </ResearchPanelActionsContext.Provider>
      <ConversationHistoryPanel
        conversations={props.conversations}
        currentConversationId={conversationId}
        busy={props.conversationBusy}
        open={conversationListOpen}
        onClose={() => setConversationListOpen(false)}
        onSelect={props.onSelectConversation}
        onCreate={props.onCreateConversation}
        onRename={props.onRenameConversation}
        onArchive={props.onArchiveConversation}
        onRemove={props.onRemoveConversation}
        onSearch={props.onSearchConversations}
        pinnedIds={props.pinnedConversationIds}
        onTogglePin={props.onTogglePinConversation}
        folders={props.conversationFolders}
        folderAssignments={props.conversationFolderAssignments}
        onCreateFolder={props.onCreateConversationFolder}
        onRenameFolder={props.onRenameConversationFolder}
        onRemoveFolder={props.onRemoveConversationFolder}
        onAssignFolder={props.onAssignConversationFolder}
      />
      {conversationListOpen ? <button className="conversation-history-backdrop" type="button" tabIndex={-1} aria-label="关闭对话记录" onClick={() => setConversationListOpen(false)} /> : null}
      {researchPanelOpen ? <button className="research-panel-backdrop" type="button" aria-label="关闭来源详情" onClick={() => closeResearchDetails()} /> : null}
    </section>
  );
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const attachments = useConversationAttachments(props);
  const webSearchActive = props.webSearchAvailable !== false && props.webSearchEnabled === true;
  const convertMessage = useCallback((message: ChatMessage): ThreadMessageLike => ({
    id: String(message.id),
    role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: new Date(message.created_at),
    metadata: { custom: { source: message } }
  }), []);

  const runtime = useExternalStoreRuntime({
    messages: props.messages,
    convertMessage,
    isRunning: props.chatBusy,
    isDisabled: !props.currentConversationId,
    onNew: async (message) => {
      if (props.draftFiles?.length) return;
      const content = textFromAppendMessage(message);
      if (content) {
        const sent = await props.onSend(
          content,
          attachments.pendingAttachments.map((attachment) => attachment.id),
          attachments.visionAttachmentIds,
          webSearchActive,
        );
        if (sent === false) return;
        // 失败的发送由 retryDraft 保存正文和附件，避免重试成功后还留一份待发附件。
        attachments.clearSentAttachments();
      }
    },
    onEdit: async (message) => {
      const content = textFromAppendMessage(message);
      const sourceId = Number(message.sourceId);
      if (content && Number.isSafeInteger(sourceId)) await props.onEdit(sourceId, content);
    },
    onReload: async (parentId) => {
      const userMessageId = Number(parentId);
      if (Number.isSafeInteger(userMessageId)) await props.onRegenerate(userMessageId);
    },
    onCancel: props.onStop
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWorkspaceContent {...props} attachments={attachments} webSearchActive={webSearchActive} />
    </AssistantRuntimeProvider>
  );
}
