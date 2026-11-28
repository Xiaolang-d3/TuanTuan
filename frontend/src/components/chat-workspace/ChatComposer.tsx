import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, FileText, Globe, ImagePlus, LoaderCircle, Mic, Plug, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { CHAT_ATTACHMENT_ACCEPT, DOCUMENT_ATTACHMENT_ACCEPT, chatAttachmentKind } from "../../features/chat/attachment-formats";
import { ComposerModelPicker } from "../../features/chat/ComposerModelPicker";
import { ChatContextChips } from "../../features/chat/MessagePresentation";
import type { ChatAttachment, ChatWorkspaceProps } from "../../features/chat/types";
import { SkillPicker } from "../../features/extensions/SkillPicker";
import { ComposerResources } from "../ComposerResources";
import { ActionButton } from "../ui/ActionButton";
import { CreationPromptLayout } from "../CreationPromptLayout";
import type { useComposerAttachments } from "./useComposerAttachments";
import type { useConversationComposer } from "./useConversationComposer";
import type { useQuickPresentationComposer } from "./useQuickPresentationComposer";

type ChatComposerProps = Pick<ChatWorkspaceProps,
  "additionalServiceModels" | "attachmentBusy" | "chatBusy" | "chatInputRef" | "currentConversationId"
  | "currentModelName" | "defaultModelName" | "density" | "modelConfigured" | "modelProfiles" | "modelProfileUnavailable"
  | "modelSelectionBusy" | "modelSettings" | "modelUnavailable" | "onComposerDraftConsumed" | "onDiscoverServiceModels"
  | "onDraftFilesChange" | "onModelProfileChange" | "onOpenLibrary" | "onOpenModelSettings" | "onSelectSkill"
  | "onServiceModelChange" | "onWebSearchChange" | "selectedModelProfileId" | "selectedSkillId" | "serviceModels"
  | "sessionContext" | "taskCancelBusy" | "webSearchAvailable" | "creationComposer"
> & {
  composer: Pick<ReturnType<typeof useConversationComposer>,
    "composerText" | "showComposerHint" | "setComposerFocused" | "voiceListening" | "voiceError"
    | "voiceIconRef" | "toggleVoice" | "hasIncomingDraft" | "importIncomingDraft"
  >;
  attachmentInput: ReturnType<typeof useComposerAttachments>;
  quickPresentation: Pick<ReturnType<typeof useQuickPresentationComposer>,
    "presentationService" | "quickMode" | "quickStatus" | "quickBusy" | "quickDisabled" | "quickError"
    | "pptProblem" | "submitQuickPpt" | "retryQuickCheck"
  >;
  pendingAttachments: ChatAttachment[];
  previewUrls: Record<string, string>;
  uploadingPreview: { filename: string; url: string } | null;
  onPreviewAttachment: (attachment: ChatAttachment) => void;
  onRemovePendingAttachment: (attachmentId: string) => Promise<void>;
  hasConversationContent: boolean;
  hasClarification: boolean;
  webSearchActive: boolean;
  modelFeedback: ReactNode;
  notices: ReactNode;
  attachmentPreview: ReactNode;
};

/** 渲染输入框、附件、输入选项和发送操作。 */
export function ChatComposer(props: ChatComposerProps) {
  const { composer, attachmentInput, quickPresentation, currentConversationId: conversationId, webSearchActive } = props;
  const { composerText, showComposerHint, setComposerFocused, voiceListening, voiceError, voiceIconRef, toggleVoice } = composer;
  const { attachmentInputRef, isDraggingAttachment, draftFiles, hasDraftFiles, uploadDraftFile } = attachmentInput;
  const { presentationService, quickMode, quickStatus, quickBusy, quickDisabled, quickError, pptProblem, submitQuickPpt, retryQuickCheck } = quickPresentation;
  const creationMode = props.creationComposer && !quickMode;
  const sendTitle = hasDraftFiles ? "请先上传或移除草稿附件"
    : props.attachmentBusy ? "资料处理完成后即可发送"
    : props.modelSelectionBusy ? "模型选择保存后即可发送"
    : props.modelProfileUnavailable ? "当前模型已停用，请切换模型"
    : quickMode ? (quickBusy ? "正在提交 PPT" : pptProblem || quickStatus?.reason || "生成 PPT")
    : composerText.trim() ? "发送消息" : "找不到发送的内容";

  const modelPicker = <ComposerModelPicker
    configured={props.modelConfigured !== false}
    modelSettings={props.modelSettings}
    currentModelName={props.currentModelName}
    defaultModelName={props.defaultModelName}
    profiles={props.modelProfiles ?? []}
    serviceModels={props.serviceModels}
    additionalServiceModels={props.additionalServiceModels}
    onDiscover={props.onDiscoverServiceModels}
    onServiceChange={props.onServiceModelChange}
    selectedProfileId={props.selectedModelProfileId ?? null}
    profileDisabled={Boolean(props.modelProfileUnavailable)}
    serviceUnavailable={Boolean(props.modelUnavailable)}
    busy={Boolean(props.modelSelectionBusy)}
    canSelect={!props.chatBusy && Boolean(conversationId)}
    onChange={(profileId) => props.onModelProfileChange?.(profileId)}
    onOpenSettings={props.onOpenModelSettings}
  />;

  return (
    <div className="chat-composer">
      {!props.hasConversationContent && props.density !== "dock" ? (
        <div className="chat-welcome">
          <h2>今天，想完成什么？</h2>
          <p>提问、查资料，或描述你想生成的图片。</p>
        </div>
      ) : null}
      {props.modelFeedback}
      {props.notices}
      {composer.hasIncomingDraft ? (
        <section className="chat-retry-prompt" aria-label="资讯分析草稿">
          <FileText size={14} />
          <span>资讯分析草稿已准备，当前输入已保留。</span>
          <button type="button" disabled={props.chatBusy} onClick={composer.importIncomingDraft}>替换为资讯草稿</button>
          <button type="button" onClick={props.onComposerDraftConsumed}>保留当前输入</button>
        </section>
      ) : null}

      <div
        className={`composer-dropzone ${isDraggingAttachment ? "is-dragging" : ""}`}
        onDragEnter={attachmentInput.handleDragOver}
        onDragOver={attachmentInput.handleDragOver}
        onDragLeave={attachmentInput.handleDragLeave}
        onDrop={attachmentInput.handleDrop}
      >
        <input
          ref={attachmentInputRef}
          className="composer-file-input"
          type="file"
          multiple
          accept={quickMode ? DOCUMENT_ATTACHMENT_ACCEPT : CHAT_ATTACHMENT_ACCEPT}
          onChange={attachmentInput.handleAttachmentChange}
        />
        {hasDraftFiles && conversationId !== null && <div className="composer-attachments" aria-label="尚未上传的草稿附件">
          {draftFiles.map((file, index) => <article key={index} className="composer-file-attachment composer-draft-file">
            <span className="composer-draft-file-name">{file.name}</span>
            {quickMode && chatAttachmentKind(file.name) !== "document" ? <small>PPT 不支持此附件</small>
              : <ActionButton size="sm" disabled={Boolean(props.attachmentBusy || props.chatBusy || quickBusy)} onClick={() => void uploadDraftFile(index)} aria-label={`上传 ${file.name}`}>上传附件</ActionButton>}
            <ActionButton size="sm" disabled={Boolean(props.attachmentBusy || quickBusy)} onClick={() => props.onDraftFilesChange?.(conversationId, draftFiles.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除草稿附件 ${file.name}`}>移除</ActionButton>
          </article>)}
          <p className="composer-draft-file-hint">请先上传或移除草稿附件，再发送消息。</p>
        </div>}
        {props.uploadingPreview ? (
          <div className="composer-attachments" aria-label="正在处理的附件">
            <article className="composer-image-attachment uploading">
              <img className="composer-attachment-preview" src={props.uploadingPreview.url} alt={`${props.uploadingPreview.filename} 预览`} />
            </article>
          </div>
        ) : null}
        {props.pendingAttachments.length ? (
          <div className="composer-attachments" aria-label="待发送附件">
            {props.pendingAttachments.map((attachment) => (
              <article key={attachment.id} className={attachment.kind === "image" ? "composer-image-attachment" : "composer-file-attachment"}>
                {attachment.kind === "image" && props.previewUrls[attachment.id]
                  ? <button
                    type="button"
                    className="composer-attachment-preview-button"
                    onClick={() => props.onPreviewAttachment(attachment)}
                    aria-label={`查看 ${attachment.original_filename}`}
                  ><img className="composer-attachment-preview" src={props.previewUrls[attachment.id]} alt={`${attachment.original_filename} 预览`} /></button>
                  : <button type="button" className="composer-file-preview-button" onClick={() => props.onPreviewAttachment(attachment)} aria-label={`预览 ${attachment.original_filename}`} title={`预览 ${attachment.original_filename}`}>
                    <span className="composer-attachment-icon">{attachment.kind === "document" ? <FileText size={15} /> : <ImagePlus size={15} />}</span>
                    <span><strong>{attachment.original_filename}</strong><small>点击预览 · 随本轮发送</small></span>
                  </button>}
                <button className="composer-attachment-remove" type="button" disabled={quickBusy} onClick={() => void props.onRemovePendingAttachment(attachment.id)} aria-label={`移除 ${attachment.original_filename}`}>
                  <X size={14} />
                </button>
              </article>
            ))}
          </div>
        ) : null}
        {quickMode ? <div className="composer-ppt-status">
          <strong>制作 PPT</strong>
          <span role="status">{!presentationService ? "PPT 制作服务未连接。" : !quickStatus ? "正在检查制作条件…" : quickStatus.available ? "输入主题、粘贴内容，或只上传资料。发送后自动制作，无需确认。" : quickStatus.reason}</span>
          {quickStatus && !quickStatus.available ? <button type="button" onClick={quickStatus.code === "model_unavailable" ? props.onOpenModelSettings : retryQuickCheck}>{quickStatus.code === "model_unavailable" ? "模型设置" : "重新检查"}</button> : null}
          {pptProblem || quickError?.conversationId === conversationId ? <p role="alert">{pptProblem || quickError?.message}</p> : null}
        </div> : null}
        <ComposerPrimitive.Root
          className={creationMode ? "creation-entry-form creation-prompt-surface" : "composer-input composer-input--enhanced"}
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setComposerFocused(false); }}
          onSubmit={(event) => {
            if (quickMode) { event.preventDefault(); if (!props.chatBusy) void submitQuickPpt(); }
            else if (hasDraftFiles || props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable) event.preventDefault();
          }}
        >
          {creationMode ? <CreationPromptLayout
            modelPicker={modelPicker}
            input={<ComposerPrimitive.Input ref={props.chatInputRef} rows={2} maxLength={200_000}
              aria-label="输入消息" aria-describedby="composer-input-hint"
              placeholder={props.hasClarification ? "回答上面的问题，或直接说下一件…" : "说说你想做什么，或描述想要的画面…"}
              submitMode="enter" unstable_insertNewlineOnTouchEnter onPaste={attachmentInput.handleComposerPaste} />}
            tools={<>
              <ComposerResources key={conversationId} creation busy={props.attachmentBusy} documentsOnly={false}
                onUpload={() => attachmentInputRef.current?.click()} onOpenLibrary={props.onOpenLibrary} />
              {props.onWebSearchChange && <button className="creation-web-search-button" type="button"
                aria-label="联网搜索" aria-pressed={webSearchActive}
                disabled={!conversationId || props.webSearchAvailable === false}
                title={props.webSearchAvailable === false ? "联网搜索服务未启用" : "允许当前对话接下来的回复按需联网搜索"}
                onClick={() => props.onWebSearchChange?.(!webSearchActive)}>
                <Globe size={16} aria-hidden="true" /><span>联网搜索</span>
              </button>}
            </>}
            actions={<>
              <button className="creation-voice-button" type="button" disabled={props.chatBusy}
                aria-pressed={voiceListening} aria-label={voiceListening ? "停止语音输入" : "语音输入"}
                aria-description={voiceError || undefined} onClick={toggleVoice}>
                <span className="composer-voice-icon" ref={voiceIconRef} aria-hidden="true"><Mic size={17} /></span>
              </button>
              {props.chatBusy ? <ComposerPrimitive.Cancel className="creation-submit" disabled={props.taskCancelBusy}
                aria-label={props.taskCancelBusy ? "正在停止生成" : "停止生成"} title="停止生成">
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </ComposerPrimitive.Cancel> : <ComposerPrimitive.Send className="creation-submit" aria-label="发送"
                disabled={hasDraftFiles || props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable} title={sendTitle}>
                <ArrowUp size={17} aria-hidden="true" />
              </ComposerPrimitive.Send>}
            </>}
          /> : <><ComposerPrimitive.Input
            ref={props.chatInputRef}
            rows={1}
            maxLength={200_000}
            aria-label="输入消息"
            aria-describedby="composer-input-hint"
            placeholder={quickMode ? "例如：智能体架构设计讲解" : props.hasClarification ? "回答上面的问题，或直接说下一件…" : "直接说说你的想法…"}
            submitMode="enter"
            unstable_insertNewlineOnTouchEnter
            onPaste={attachmentInput.handleComposerPaste}
          />
          <div className="composer-bottom-row">
            <div className="composer-shortcuts" role="group" aria-label="输入选项">
              <ComposerResources
                key={conversationId}
                busy={props.attachmentBusy}
                documentsOnly={quickMode}
                onUpload={() => attachmentInputRef.current?.click()}
                onOpenLibrary={props.onOpenLibrary}
              />
              <button className={`composer-tool composer-voice-tool${voiceListening ? " is-recording" : ""}`} type="button" aria-pressed={voiceListening} aria-label={voiceListening ? "停止语音输入" : "语音输入"} aria-description={voiceError || undefined} disabled={props.chatBusy} onClick={toggleVoice}>
                <span className="composer-voice-icon" ref={voiceIconRef} aria-hidden="true">
                  <Mic size={16} />
                  {voiceListening ? <svg className="composer-voice-wave" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
                    <line x1="10.5" x2="10.5" y1="6" y2="10" />
                    <line x1="12" x2="12" y1="4.5" y2="11.5" />
                    <line x1="13.5" x2="13.5" y1="5.5" y2="10.5" />
                  </svg> : null}
                </span>
                <span className="composer-tool-label">语音</span>
              </button>
              {!quickMode && props.onWebSearchChange ? <button
                className={`composer-tool composer-web-search-tool${webSearchActive ? " active" : ""}`}
                type="button"
                aria-label="联网搜索"
                aria-pressed={webSearchActive}
                disabled={!conversationId || props.webSearchAvailable === false}
                title={props.webSearchAvailable === false ? "联网搜索服务未启用" : "允许当前对话接下来的回复按需联网搜索"}
                onClick={() => props.onWebSearchChange?.(!webSearchActive)}
              >
                <Globe size={16} aria-hidden="true" />
                <span className="composer-tool-label">联网搜索</span>
              </button> : null}
              <ChatContextChips context={props.sessionContext} />
            </div>
            <div className="composer-primary-actions">
              {modelPicker}
              {props.chatBusy ? (
                <ComposerPrimitive.Cancel className="send-button stop-button" disabled={props.taskCancelBusy} aria-label={props.taskCancelBusy ? "正在停止生成" : "停止生成"} title={props.taskCancelBusy ? "正在停止生成" : "停止生成"}>
                  <Square size={12} fill="currentColor" aria-hidden="true" /><span>停止</span>
                </ComposerPrimitive.Cancel>
              ) : (
                <span className="composer-send-tooltip" title={sendTitle}>
                  {quickMode ? <button type="submit" className="send-button" aria-label="生成 PPT" disabled={quickDisabled} title={sendTitle}>
                    {quickBusy ? <LoaderCircle className="spinning" size={18} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}<span>发送</span>
                  </button> : <ComposerPrimitive.Send className="send-button" aria-label="发送" disabled={hasDraftFiles || props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable} title={sendTitle}>
                    <ArrowUp size={18} aria-hidden="true" /><span>发送</span>
                  </ComposerPrimitive.Send>}
                </span>
              )}
            </div>
          </div>
          </>}
        </ComposerPrimitive.Root>
        <span id="composer-input-hint" className="sr-only"><span className="composer-keyboard-hint">Enter 发送 · Shift + Enter 换行</span><span className="composer-touch-hint">回车换行，点击发送按钮发送</span></span>
        <div className={`composer-footer${creationMode ? " creation-chat-footer" : ""}`}>
          <div className="composer-tools-bar" role="group" aria-label="技能与外部工具">
            <SkillPicker selectedSkillId={props.selectedSkillId} onSelectSkill={props.onSelectSkill} />
            <a className="composer-tool composer-connections-tool" href="#/settings/extensions" title="管理插件与 MCP 外部连接">
              <Plug size={16} aria-hidden="true" /><span>外部连接</span>
            </a>
          </div>
          <div className={`composer-input-hint${showComposerHint ? " is-active" : ""}`} aria-hidden={!showComposerHint}>
            <span className="composer-keyboard-hint" aria-hidden="true"><kbd>Enter</kbd><span>发送</span><span className="composer-hint-divider">·</span><kbd>Shift</kbd><span>+</span><kbd>Enter</kbd><span>换行</span></span>
            <span className="composer-touch-hint" aria-hidden="true">回车换行 · 点击 <ArrowUp size={12} /> 发送</span>
            {composerText.length >= 180_000 && <span className="composer-character-count" role="status">{composerText.length.toLocaleString()} / 200,000 字</span>}
          </div>
        </div>
        {isDraggingAttachment ? <div className="composer-drop-hint" aria-live="polite">松开即可添加图片或文档</div> : null}
      </div>
      {props.attachmentPreview}
    </div>
  );
}
