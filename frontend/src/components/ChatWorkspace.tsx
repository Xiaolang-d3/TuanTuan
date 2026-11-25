import { useConversationScroll } from "../features/chat/useConversationScroll";
import { ComposerModelPicker } from "../features/chat/ComposerModelPicker";
import { SkillPicker } from "../features/extensions/SkillPicker";
import { PresentationChat } from "../features/extensions/PresentationChat";
import { DocumentReviewPanel } from "../features/chat/DocumentReviewPanel";
import { useExtensionPreview } from "../features/extensions/ExtensionPreviewContext";
import type { PresentationJob, QuickPresentationCapabilities } from "../features/extensions/presentation-service";
import { ApiError } from "../api/client";
import { AttachmentPreviewDialog, AttachmentPreviewContext } from "../features/chat/AttachmentPreviewDialog";
import { AssetOriginalContext, LatestGeneratedImageContext } from "../features/chat/GeneratedImage";
import { ResultDialog } from "../features/chat/ResultDialog";
import { ResultActionsContext, DocumentActionsContext } from "../features/chat/result-types";
import { AttachmentThumbnailContext } from "../features/chat/HistoryAttachment";
import { quoteForComposer } from "../features/chat/conversationActions";
import { textFromAppendMessage, WebSource, webSourcesFromAgent, ResearchPanelActionsContext, QuoteSelectionContext, DeleteTurnContext, EditMessageComposer, RunProcess, ComposerClarification, ChatContextChips, ResearchPanel, ChatTurn } from "../features/chat/MessagePresentation";

import type { AgentRunResult, ChatMessage, ChatAttachment, ChatClarificationOption, ChatClarification, ChatWorkspaceProps } from "../features/chat/types";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { useVoiceAnswer } from "../hooks/useVoiceAnswer";
import { VoiceDraftEditor } from "../features/chat/voiceDraft";
import type { VoiceTranscript } from "../features/chat/voiceInput";

import { ComposerResources } from "./ComposerResources";
import { ConversationHistoryPanel } from "./ConversationHistoryPanel";

import "./ChatWorkspace.css";
import "./ChatComposer.css";
import "./ChatModelSelection.css";

import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";

import { flushTapSync } from "@assistant-ui/tap";
import { useAui, useAuiState } from "@assistant-ui/store";

import { ArrowDown, ArrowUp, ArrowUpRight, CheckCircle2, Download, FileText, Globe, History, ImagePlus, LoaderCircle, Mic, Plug, Plus, RefreshCw, Square, TriangleAlert, X } from "lucide-react";

const MAX_ATTACHMENTS = 8;

function currentWebSearch(props: ChatWorkspaceProps): boolean {
  return props.webSearchAvailable !== false && props.webSearchEnabled === true;
}

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
  pendingAttachments: ChatAttachment[];
  previewUrls: Record<string, string>;
  localFiles: Record<string, File>;
  uploadingPreview: { filename: string; url: string } | null;
  onUpload: (file?: File) => Promise<void>;
  onRemovePendingAttachment: (attachmentId: string) => Promise<void>;
  onClearSubmittedAttachments: (conversationId: number, ids: string[]) => void;
};

function ChatWorkspaceContent(props: ChatWorkspaceContentProps) {
  const { presentationService } = useExtensionPreview();
  const [presentationContent, setPresentationContent] = useState<{ conversationId: number; hasContent: boolean } | null>(null);
  const [reviewContent, setReviewContent] = useState<{ conversationId: number | null; hasContent: boolean } | null>(null);
  const handleReviewContentChange = useCallback((hasContent: boolean) => {
    setReviewContent(previous => previous?.conversationId === props.currentConversationId && previous.hasContent === hasContent ? previous : { conversationId: props.currentConversationId, hasContent });
  }, [props.currentConversationId]);
  const handlePresentationContentChange = useCallback((conversationId: number, hasContent: boolean) => {
    setPresentationContent(previous => previous?.conversationId === conversationId && previous.hasContent === hasContent ? previous : { conversationId, hasContent });
  }, []);
  const hasConversationContent = props.messages.length > 0 || (presentationContent?.conversationId === props.currentConversationId && presentationContent?.hasContent) || (reviewContent?.conversationId === props.currentConversationId && reviewContent?.hasContent);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const conversationId = props.currentConversationId;
  const pptSelected = props.selectedSkillId === "ppt-master";
  const modelScope = `${props.selectedModelProfileId ?? "default"}:${props.modelSettings?.profile.revision ?? 0}`;
  const [quickCheck, setQuickCheck] = useState<{ conversationId: number; modelScope: string; status: QuickPresentationCapabilities }>();
  const [quickCheckAttempt, setQuickCheckAttempt] = useState(0);
  const [quickPending, setQuickPending] = useState<Set<number>>(() => new Set());
  const [quickError, setQuickError] = useState<{ conversationId: number; message: string }>();
  const [submittedJob, setSubmittedJob] = useState<PresentationJob>();
  const quickKeys = useRef(new Map<number, { fingerprint: string; key: string }>());
  const quickSubmitting = useRef(new Set<number>());
  const currentQuickScope = useRef({ conversationId, presentationService });
  currentQuickScope.current = { conversationId, presentationService };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const quickStatus = quickCheck?.conversationId === conversationId && quickCheck.modelScope === modelScope ? quickCheck.status : undefined;
  const quickMode = pptSelected && quickStatus?.composer !== false;
  const quickBusy = conversationId !== null && quickPending.has(conversationId);
  const validPptAttachments = props.pendingAttachments.every(item => item.kind === "document" && /\.(docx|pdf|txt|md)$/i.test(item.original_filename));
  const pptProblem = !validPptAttachments ? "请移除图片或不支持的附件。PPT 可使用 Word、文字版 PDF、TXT 或 Markdown。"
    : [...composerText.trim()].length > 16_000 ? "主题或粘贴内容最多 16,000 字，请精简后发送。" : "";
  const quickDisabled = !quickStatus?.available || quickBusy || Boolean(pptProblem) || props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable || (!composerText.trim() && !props.pendingAttachments.length);
  useEffect(() => {
    if (!pptSelected || !conversationId || !presentationService) return;
    const controller = new AbortController();
    setQuickCheck(undefined);
    void presentationService.quickCapabilities(conversationId, controller.signal).then(status => {
      if (!controller.signal.aborted) setQuickCheck({ conversationId, modelScope, status });
    }).catch(error => {
      if (controller.signal.aborted) return;
      const missingRoute = error instanceof ApiError && error.status === 404 && error.message === "Not Found";
      const status = { composer: !missingRoute, available: false, code: missingRoute ? "legacy" : "check_failed", reason: missingRoute ? "" : "暂时无法检查 PPT 制作服务，请重新检查。" };
      setQuickCheck({ conversationId, modelScope, status });
    });
    return () => controller.abort();
  }, [conversationId, modelScope, pptSelected, presentationService, quickCheckAttempt]);
  const [composerFocused, setComposerFocused] = useState(false);
  const sendTitle = props.attachmentBusy ? "资料处理完成后即可发送"
    : props.modelSelectionBusy ? "模型选择保存后即可发送"
    : props.modelProfileUnavailable ? "当前模型已停用，请切换模型"
    : quickMode ? (quickBusy ? "正在提交 PPT" : pptProblem || quickStatus?.reason || "生成 PPT")
    : composerText.trim() ? "发送消息" : "找不到发送的内容";
  const showComposerHint = (!props.chatBusy && (composerFocused || (props.messages.length === 0 && props.density !== "dock"))) || composerText.length >= 180_000;
  const localDrafts = useRef(new Map<number, string>());
  const drafts = props.composerDrafts ?? localDrafts.current;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const auiRef = useRef(aui);
  auiRef.current = aui;
  async function submitQuickPpt() {
    if (!conversationId || !presentationService || quickDisabled || quickSubmitting.current.has(conversationId)) return;
    const draft = auiRef.current.composer().getState().text;
    const topic = draft.trim();
    const ids = props.pendingAttachments.map(item => item.id);
    const fingerprint = JSON.stringify([topic, ids]);
    const previous = quickKeys.current.get(conversationId);
    const key = previous?.fingerprint === fingerprint ? previous.key : crypto.randomUUID();
    quickKeys.current.set(conversationId, { fingerprint, key });
    quickSubmitting.current.add(conversationId);
    setQuickPending(new Set(quickSubmitting.current));
    setQuickError(undefined);
    const isCurrent = () => mounted.current && currentQuickScope.current.presentationService === presentationService && currentQuickScope.current.conversationId === conversationId;
    try {
      const job = await presentationService.createQuick(topic, ids, conversationId, key);
      quickKeys.current.delete(conversationId);
      if (!isCurrent()) return;
      setSubmittedJob(job);
      if (auiRef.current.composer().getState().text === draft) {
        auiRef.current.composer().setText("");
        draftsRef.current.delete(conversationId);
        props.onPersistComposerDrafts?.();
      }
      props.onClearSubmittedAttachments(conversationId, ids);
    } catch (error) {
      if (isCurrent()) setQuickError({ conversationId, message: error instanceof Error ? error.message : "暂时无法提交 PPT，请重试。" });
    } finally {
      quickSubmitting.current.delete(conversationId);
      if (mounted.current) setQuickPending(new Set(quickSubmitting.current));
    }
  }
  function reuseQuickPpt(job: PresentationJob) {
    props.onSelectSkill?.("ppt-master");
    const current = auiRef.current.composer().getState().text;
    const topic = job.topic ?? "";
    if (!current.trim()) auiRef.current.composer().setText(topic);
    props.chatInputRef.current?.focus();
  }
  const voiceDraftRef = useRef(new VoiceDraftEditor());
  useLayoutEffect(() => { voiceDraftRef.current.observe(composerText); }, [composerText]);
  const appendVoiceTranscript = useCallback((update: VoiceTranscript) => {
    const current = auiRef.current.composer().getState().text;
    const input = props.chatInputRef.current;
    const selection = { start: input?.selectionStart ?? current.length, end: input?.selectionEnd ?? current.length };
    const change = voiceDraftRef.current.apply(current, update, selection);
    if (!change) return;
    flushTapSync(() => { auiRef.current.composer().setText(change.text); });
    input?.setSelectionRange(change.selection.start, change.selection.end);
    const id = props.currentConversationId;
    if (id) draftsRef.current.set(id, change.text);
    props.onPersistComposerDrafts?.();
  }, [props.currentConversationId, props.onPersistComposerDrafts, props.chatInputRef]);
  const voiceIconRef = useRef<HTMLSpanElement>(null);
  const updateVoiceLevel = useCallback((level: number) => {
    // Update only the icon, without re-rendering the conversation at audio rate.
    voiceIconRef.current?.style.setProperty("--voice-level", String(level));
  }, []);
  const voice = useVoiceAnswer(appendVoiceTranscript, props.voiceInput, updateVoiceLevel);
  const stopVoiceRef = useRef(voice.cancelListening);
  stopVoiceRef.current = voice.cancelListening;
  useLayoutEffect(() => { stopVoiceRef.current(); }, [props.chatBusy, props.currentConversationId, props.voiceInput]);
  const persistDraftsRef = useRef(props.onPersistComposerDrafts);
  persistDraftsRef.current = props.onPersistComposerDrafts;
  const loadedDraftConversation = useRef<number | null | undefined>(undefined);
  useEffect(() => () => {
    const id = loadedDraftConversation.current;
    if (!id) return;
    const text = auiRef.current.composer().getState().text;
    if (text) draftsRef.current.set(id, text);
    else draftsRef.current.delete(id);
    persistDraftsRef.current?.();
  }, []);
  useLayoutEffect(() => {
    const id = props.currentConversationId;
    if (loadedDraftConversation.current === id) return;
    const previous = loadedDraftConversation.current;
    if (previous) {
      const previousText = auiRef.current.composer().getState().text;
      if (previousText) draftsRef.current.set(previous, previousText);
      else draftsRef.current.delete(previous);
      persistDraftsRef.current?.();
    }
    loadedDraftConversation.current = id;
    // Only switching conversations reloads a draft. setText changes the `aui`
    // object, and reloading on that change would erase a just-inserted quote.
    flushTapSync(() => {
      auiRef.current.composer().setText(id ? draftsRef.current.get(id) ?? "" : "");
    });
  }, [props.currentConversationId]);

  useEffect(() => {
    const flush = () => {
      const id = props.currentConversationId;
      if (id) {
        const text = aui.composer().getState().text;
        if (text) drafts.set(id, text);
        else drafts.delete(id);
      }
      props.onPersistComposerDrafts?.();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [aui, drafts, props.currentConversationId, props.onPersistComposerDrafts]);

  useLayoutEffect(() => {
    const input = props.chatInputRef.current;
    if (!input) return;
    const resize = () => {
      const style = window.getComputedStyle(input);
      const min = Number.parseFloat(style.minHeight) || 40;
      const max = Number.parseFloat(style.maxHeight) || Math.min(240, window.innerHeight * .3);
      input.style.height = "0px";
      const height = Math.max(min, input.scrollHeight);
      input.style.height = `${Math.min(max, height)}px`;
      input.style.overflowY = height > max ? "auto" : "hidden";
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer.observe(input);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [composerText, props.chatInputRef]);
  const appliedDraftId = useRef<string | null>(null);
  const clarification = clarificationFromAgent(props.latestAgent);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [expandedPreview, setExpandedPreview] = useState<ChatAttachment | null>(null);
  const [resultSelection, setResultSelection] = useState<{ messageId: number; selector?: string; saving?: boolean; editing?: boolean } | null>(null);
  const generatedGallery = expandedPreview?.origin === "generated" ? props.messages.find(message => message.payload?.agent?.assets?.some(asset => asset.id === expandedPreview.id))?.payload?.agent?.assets ?? [] : null;
  const gallery = expandedPreview?.kind === "image" ? (generatedGallery ?? props.messages.find(message => message.payload?.attachments?.some(attachment => attachment.id === expandedPreview.id))?.payload?.attachments ?? props.pendingAttachments).filter(item => item.kind === "image") : [];
  const [conversationListOpen, setConversationListOpen] = useState(false);
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const scrolling = useConversationScroll(props.currentConversationId, props.messages, researchPanelOpen);
  const researchReturn = useRef<{ top: number; element: HTMLElement | null } | null>(null);
  const [researchSelection, setResearchSelection] = useState<{
    agent?: AgentRunResult;
    sources: WebSource[];
    selectedSource: number;
  } | null>(null);
  const latestAssistant = [...props.messages].reverse().find((message) => message.role === "assistant");
  const defaultResearchAgent = props.latestAgent ?? latestAssistant?.payload?.agent;
  const defaultResearchSources = webSourcesFromAgent(defaultResearchAgent);
  const activeResearch = researchSelection ?? {
    agent: defaultResearchAgent,
    sources: defaultResearchSources,
    selectedSource: 0
  };

  function openResearchDetails(agent = defaultResearchAgent, sources = defaultResearchSources, selectedSource = 0) {
    if (!researchPanelOpen) researchReturn.current = {
      top: scrolling.viewportRef.current?.scrollTop ?? 0,
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    setConversationListOpen(false);
    setResearchSelection({ agent, sources, selectedSource });
    setResearchPanelOpen(true);
  }

  function closeResearchDetails(restoreFocus = true) {
    setResearchPanelOpen(false);
    const saved = researchReturn.current;
    window.requestAnimationFrame(() => {
      if (researchReturn.current !== saved) return;
      if (saved) scrolling.restorePosition(saved.top);
      if (restoreFocus) (saved?.element?.isConnected ? saved.element : props.chatInputRef.current)?.focus({ preventScroll: true });
    });
  }

  function fillComposer(draft: string) {
    aui.composer().setText(draft);
    window.requestAnimationFrame(() => {
      const input = props.chatInputRef.current;
      input?.focus();
      const cursor = draft.length;
      input?.setSelectionRange(cursor, cursor);
    });
  }

  const incomingDraft = props.composerDraft?.conversationId === props.currentConversationId
    ? props.composerDraft
    : null;

  function importIncomingDraft() {
    if (!incomingDraft || props.chatBusy) return;
    fillComposer(incomingDraft.content);
    appliedDraftId.current = incomingDraft.id;
    props.onComposerDraftConsumed?.();
  }

  useEffect(() => {
    if (!incomingDraft || props.chatBusy || appliedDraftId.current === incomingDraft.id) return;
    // Existing composer text remains editable; importing over it is an explicit action.
    if (aui.composer().getState().text.trim()) return;
    aui.composer().setText(incomingDraft.content);
    appliedDraftId.current = incomingDraft.id;
    props.onComposerDraftConsumed?.();
    window.requestAnimationFrame(() => props.chatInputRef.current?.focus());
  }, [aui, incomingDraft, props.chatBusy, props.chatInputRef, props.onComposerDraftConsumed]);

  useEffect(() => {
    setExpandedPreview(null);
    setResultSelection(null);
    setConversationListOpen(false);
    setResearchPanelOpen(false);
    setResearchSelection(null);
    researchReturn.current = null;
  }, [props.currentConversationId]);

  const openedHistoryRequest = useRef(0);
  useEffect(() => {
    const request = props.historyOpenRequest ?? 0;
    if (!props.focused) {
      openedHistoryRequest.current = request;
      setConversationListOpen(false);
      return;
    }
    if (!request || request === openedHistoryRequest.current) return;
    openedHistoryRequest.current = request;
    setResearchPanelOpen(false);
    setConversationListOpen(true);
  }, [props.focused, props.historyOpenRequest]);

  useEffect(() => {
    if (props.messages.length > 0 || props.chatBusy || !props.currentConversationId) return;
    const timer = window.setTimeout(() => props.chatInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.chatBusy, props.chatInputRef, props.currentConversationId, props.messages.length]);

  useEffect(() => {
    if (!conversationListOpen && !researchPanelOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (conversationListOpen) setConversationListOpen(false);
      if (researchPanelOpen) closeResearchDetails();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversationListOpen, researchPanelOpen]);

  function applyQuote(selected: string) {
    const next = quoteForComposer(selected, aui.composer().getState().text);
    flushTapSync(() => {
      aui.composer().setText(next);
    });
    const id = props.currentConversationId;
    if (id) {
      if (next) drafts.set(id, next);
      else drafts.delete(id);
    }
    props.onPersistComposerDrafts?.();
    window.requestAnimationFrame(() => props.chatInputRef.current?.focus());
  }

  async function acceptAttachment(file: File): Promise<"added" | "invalid" | "failed"> {
    const filename = file.name.toLowerCase();
    if (quickMode && !/\.(pdf|docx|txt|md)$/.test(filename)) {
      props.onAttachmentInvalid("PPT 制作支持 Word（DOCX）、文字版 PDF、TXT 或 Markdown。");
      return "invalid";
    }
    const supported = file.type.startsWith("image/") || /\.(png|jpe?g|webp|pdf|docx|txt|md)$/.test(filename);
    if (!supported) {
      props.onAttachmentInvalid("仅支持图片（PNG、JPG、WEBP）或文档（PDF、DOCX、TXT、MD）。");
      return "invalid";
    }
    try {
      await props.onUpload(file);
      return "added";
    } catch {
      return "failed";
    }
  }

  async function selectAttachments(files: File[]) {
    if (!files.length || props.attachmentBusy) return;
    const room = MAX_ATTACHMENTS - props.pendingAttachments.length;
    if (room <= 0) {
      props.onAttachmentInvalid("一次最多附加 8 个文件。");
      return;
    }
    const batch = files.slice(0, room);
    if (files.length > room) props.onAttachmentInvalid("一次最多附加 8 个文件，多出的没有添加。");
    for (const file of batch) {
      if (await acceptAttachment(file) === "failed") break;
    }
  }

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    void selectAttachments(Array.from(event.target.files ?? []));
    event.currentTarget.value = "";
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!props.attachmentBusy) setIsDraggingAttachment(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingAttachment(false);
    void selectAttachments(Array.from(event.dataTransfer.files ?? []));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    if (!clipboardFiles.length || props.attachmentBusy) return;
    const supported = clipboardFiles.flatMap((clipboardFile, index) => {
      const filename = clipboardFile.name.toLowerCase();
      const accepted = clipboardFile.type.startsWith("image/") || /\.(png|jpe?g|webp|pdf|docx|txt|md)$/.test(filename);
      if (!accepted) return [];
      if (clipboardFile.name) return [clipboardFile];
      const extension = clipboardFile.type.split("/")[1] || "png";
      const suffix = clipboardFiles.length > 1 ? `-${index + 1}` : "";
      return [new File([clipboardFile], `粘贴的图片${suffix}.${extension}`, { type: clipboardFile.type })];
    });
    if (!supported.length) return;
    event.preventDefault();
    void selectAttachments(supported);
  }

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
      <QuoteSelectionContext.Provider value={applyQuote}>
      <DeleteTurnContext.Provider value={props.onDeleteTurn ?? null}>
      <AttachmentPreviewContext.Provider value={setExpandedPreview}>
      <LatestGeneratedImageContext.Provider value={props.messages.flatMap(message => message.payload?.agent?.assets ?? []).at(-1)?.id}>
      <AssetOriginalContext.Provider value={props.onLoadAttachment}>
      <AttachmentThumbnailContext.Provider value={props.onLoadAttachmentThumbnail}>
      <ResultActionsContext.Provider value={props.onLoadResults ? (messageId, selector, saving) => setResultSelection({ messageId, selector, saving }) : null}>
      <DocumentActionsContext.Provider value={props.onEditDocument ?? (props.documentService && props.currentConversationId && props.onLoadResults ? messageId => setResultSelection({ messageId, selector: "answer", editing: true }) : null)}>
      <ThreadPrimitive.Root className="chat-main">
        <header className="chat-session-header" aria-label="对话操作栏">
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
        </header>
        <div className="chat-thread-surface">
        <ThreadPrimitive.Viewport ref={scrolling.viewportRef} onScroll={scrolling.onScroll} autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} scrollToBottomOnRunStart={false} className="chat-thread" role="log" aria-live="polite" aria-relevant="additions">
          <div ref={scrolling.contentRef} className="chat-thread-content">
          {props.messages.length === 0 && props.density === "dock" ? (
            <div className="chat-welcome"><span className="assistant-welcome-mark" aria-hidden="true">✦</span><h2>有什么可以帮你？</h2><p>提问、整理资料，或一起完成一段创作。</p></div>
          ) : null}
          {props.hiddenMessageCount > 0 ? (
            <button className="load-history-button" onClick={props.onLoadMore}>
              查看更早消息 · 还有 {props.hiddenMessageCount} 条
            </button>
          ) : null}

          {props.messages.length === 0 ? null : (
            <ThreadPrimitive.Messages>
              {({ message }) => message.composer.isEditing
                ? <EditMessageComposer />
                : <ChatTurn state={message} chatBusy={props.chatBusy} stopping={props.taskCancelBusy} />}
            </ThreadPrimitive.Messages>
          )}

          {props.chatBusy && (!props.messages.length || props.messages.at(-1)?.role === "user")
            && !props.messages.some((message) => message.role === "assistant" && message.id < 0) ? (
            <div className="message assistant"><div className="message-content"><RunProcess streaming stopping={props.taskCancelBusy} /></div></div>
          ) : null}

          {presentationService && conversationId ? <PresentationChat service={presentationService} conversationId={conversationId} request={pptSelected && !quickMode ? 1 : 0} hideStoredForm={quickMode} modelScope={modelScope} disabled={Boolean(props.modelSelectionBusy)} submittedJob={submittedJob} onReuseQuick={reuseQuickPpt} onContentChange={handlePresentationContentChange} onOpenModelSettings={() => props.onOpenModelSettings?.()} /> : null}
            {props.documentReviewService && props.currentConversationId ? <DocumentReviewPanel service={props.documentReviewService} conversationId={props.currentConversationId} attachments={[...props.messages.flatMap(message => message.payload?.attachments ?? []), ...props.pendingAttachments]} onContentChange={handleReviewContentChange} /> : null}
          <div ref={props.chatEndRef} />
          </div>
        </ThreadPrimitive.Viewport>
        </div>
        {scrolling.away || (hasConversationContent && modelFeedback) ? (
          <div className="chat-thread-overlay">
            {hasConversationContent ? modelFeedback : null}
            {scrolling.away ? (
              <button
                type="button"
                className="chat-jump-latest"
                data-unread={scrolling.unread || undefined}
                aria-label={scrolling.unread ? "有新内容 · 回到最新" : "回到最新"}
                onClick={scrolling.jumpToLatest}
              >
                <span className="chat-jump-latest-label">{scrolling.unread ? "有新内容 · 回到最新" : "回到最新"}</span>
                <ArrowDown size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="chat-composer">
          {!hasConversationContent && props.density !== "dock" ? (
            <div className="chat-welcome">
              <h2>今天，想完成什么？</h2>
              <p>提问、查资料，或描述你想生成的图片。</p>
            </div>
          ) : null}
          {!hasConversationContent ? modelFeedback : null}
          {clarification && !props.chatBusy ? (
            <ComposerClarification
              clarification={clarification}
              busy={props.taskCancelBusy}
              onChoose={(text) => { void props.onSend(text, [], [], currentWebSearch(props)); }}
              onCancel={props.onCancelTask}
            />
          ) : props.waitingForUser ? (
            <section className="task-prompt attention" aria-label="当前任务提醒">
              <span className="task-prompt-icon"><TriangleAlert size={16} /></span>
              <div className="task-prompt-copy">
                <span>需要你完成一步</span>
                <strong>当前任务正在等待你的确认</strong>
                <small>{props.latestAgent?.error?.message ?? "完成提示步骤后，Agent 会继续处理。"}</small>
              </div>
              <div className="task-prompt-actions">
                <button className="task-action-button" onClick={props.onSuggestedAction}>
                  继续处理<ArrowUpRight size={14} />
                </button>
                <button className="task-cancel-button" onClick={props.onCancelTask} disabled={props.taskCancelBusy}>
                  {props.taskCancelBusy ? "结束中…" : "结束任务"}
                </button>
              </div>
            </section>
          ) : null}

          {props.replacementUndo?.conversationId === props.currentConversationId && !props.chatBusy ? (
            <section className="chat-retry-prompt chat-replacement-undo" role="status" aria-label="撤销替换">
              <RefreshCw size={14} aria-hidden="true" />
              <span>已替换本轮及后续消息。生成的图片无法恢复。</span>
              <button type="button" onClick={() => void props.onUndoReplacement?.()}>撤销</button>
            </section>
          ) : null}
          {props.modelChecking ? <div className="chat-retry-prompt" role="status">正在检查模型服务…</div> : null}
          {props.modelUnavailable || props.sendError || (props.retryDraft && !props.chatBusy) ? (
            <section
              className="chat-retry-prompt"
              role={props.modelUnavailable || props.sendError ? "alert" : undefined}
              aria-label={props.modelUnavailable ? "模型服务不可用" : props.retryDraft?.reason === "interrupted" ? "任务恢复提示" : "消息发送失败"}
            >
              <TriangleAlert size={14} />
              <span>{props.modelUnavailable || props.sendError
                ? `${props.modelUnavailable || props.sendError}${props.retryDraft ? " 输入内容已保留。" : ""}`
                : props.retryDraft?.reason === "interrupted" ? "上次任务意外中断，可从最近检查点继续" : "上一条消息未发送成功"}</span>
              {props.modelUnavailable ? <button type="button" onClick={props.onOpenModelSettings}>去设置模型</button> : null}
              {props.retryDraft && !props.chatBusy ? <button type="button" onClick={() => {
                const draft = props.retryDraft;
                if (!draft) return;
                if (props.onRetry) {
                  void props.onRetry(draft);
                  return;
                }
                const searchEnabled = currentWebSearch(props);
                void props.onSend(draft.content, draft.attachmentIds, draft.visionAttachmentIds, searchEnabled,
                  searchEnabled ? draft.webSearchTopic : undefined, searchEnabled ? draft.webSearchSourcePreference : undefined);
              }}><RefreshCw size={12} />{props.retryDraft.reason === "interrupted" ? "继续执行" : "重试"}</button> : null}
              {props.retryDraft ? <details><summary>查看保留的内容</summary><p style={{ whiteSpace: "pre-wrap" }}>{props.retryDraft.content}</p></details> : null}
            </section>
          ) : null}

          {incomingDraft && appliedDraftId.current !== incomingDraft.id ? (
            <section className="chat-retry-prompt" aria-label="资讯分析草稿">
              <FileText size={14} />
              <span>资讯分析草稿已准备，当前输入已保留。</span>
              <button type="button" disabled={props.chatBusy} onClick={importIncomingDraft}>替换为资讯草稿</button>
              <button type="button" onClick={props.onComposerDraftConsumed}>保留当前输入</button>
            </section>
          ) : null}

          <div
            className={`composer-dropzone ${isDraggingAttachment ? "is-dragging" : ""}`}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDraggingAttachment(false); }}
            onDrop={handleDrop}
          >
            <input
              ref={attachmentInputRef}
              className="composer-file-input"
              type="file"
              multiple
              accept={quickMode ? ".pdf,.docx,.txt,.md,application/pdf" : ".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,application/pdf"}
              onChange={handleAttachmentChange}
            />
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
                        onClick={() => setExpandedPreview(attachment)}
                        aria-label={`查看 ${attachment.original_filename}`}
                      ><img className="composer-attachment-preview" src={props.previewUrls[attachment.id]} alt={`${attachment.original_filename} 预览`} /></button>
                      : <button type="button" className="composer-file-preview-button" onClick={() => setExpandedPreview(attachment)} aria-label={`预览 ${attachment.original_filename}`} title={`预览 ${attachment.original_filename}`}>
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
              {quickStatus && !quickStatus.available ? <button type="button" onClick={quickStatus.code === "model_unavailable" ? props.onOpenModelSettings : () => setQuickCheckAttempt(value => value + 1)}>{quickStatus.code === "model_unavailable" ? "模型设置" : "重新检查"}</button> : null}
              {pptProblem || quickError?.conversationId === conversationId ? <p role="alert">{pptProblem || quickError?.message}</p> : null}
            </div> : null}
            <ComposerPrimitive.Root
              className="composer-input composer-input--enhanced"
              onFocusCapture={() => setComposerFocused(true)}
              onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setComposerFocused(false); }}
              onSubmit={(event) => {
                if (quickMode) { event.preventDefault(); if (!props.chatBusy) void submitQuickPpt(); }
                else if (props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable) event.preventDefault();
              }}
            >
              <ComposerPrimitive.Input
                ref={props.chatInputRef}
                rows={1}
                maxLength={200_000}
                aria-label="输入消息"
                aria-describedby="composer-input-hint"
                placeholder={quickMode ? "例如：智能体架构设计讲解" : clarification ? "回答上面的问题，或直接说下一件…" : "直接说说你的想法…"}
                submitMode="enter"
                unstable_insertNewlineOnTouchEnter
                onPaste={handleComposerPaste}
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
                  <button className={`composer-tool composer-voice-tool${voice.listening ? " is-recording" : ""}`} type="button" aria-pressed={voice.listening} aria-label={voice.listening ? "停止语音输入" : "语音输入"} aria-description={voice.error || undefined} disabled={props.chatBusy} onClick={() => { if (voice.listening) voice.stopListening(); else { voiceDraftRef.current = new VoiceDraftEditor(); void voice.startListening(); } }}>
                    <span className="composer-voice-icon" ref={voiceIconRef} aria-hidden="true">
                      <Mic size={16} />
                      {voice.listening ? <svg className="composer-voice-wave" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
                        <line x1="10.5" x2="10.5" y1="6" y2="10" />
                        <line x1="12" x2="12" y1="4.5" y2="11.5" />
                        <line x1="13.5" x2="13.5" y1="5.5" y2="10.5" />
                      </svg> : null}
                    </span>
                    <span className="composer-tool-label">语音</span>
                  </button>
                  {!quickMode && props.onWebSearchChange ? <button
                    className={`composer-tool composer-web-search-tool${currentWebSearch(props) ? " active" : ""}`}
                    type="button"
                    aria-label="联网搜索"
                    aria-pressed={currentWebSearch(props)}
                    disabled={!props.currentConversationId || props.webSearchAvailable === false}
                    title={props.webSearchAvailable === false ? "联网搜索服务未启用" : "允许当前对话接下来的回复按需联网搜索"}
                    onClick={() => props.onWebSearchChange?.(!currentWebSearch(props))}
                  >
                    <Globe size={16} aria-hidden="true" />
                    <span className="composer-tool-label">联网搜索</span>
                  </button> : null}
                  <ChatContextChips context={props.sessionContext} />
                </div>
                <div className="composer-primary-actions">
                  <ComposerModelPicker
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
                    canSelect={!props.chatBusy && Boolean(props.currentConversationId)}
                    onChange={(profileId) => props.onModelProfileChange?.(profileId)}
                    onOpenSettings={props.onOpenModelSettings}
                  />
                  {props.chatBusy ? (
                    <ComposerPrimitive.Cancel className="send-button stop-button" disabled={props.taskCancelBusy} aria-label={props.taskCancelBusy ? "正在停止生成" : "停止生成"} title={props.taskCancelBusy ? "正在停止生成" : "停止生成"}>
                      <Square size={12} fill="currentColor" aria-hidden="true" /><span>停止</span>
                    </ComposerPrimitive.Cancel>
                  ) : (
                    <span className="composer-send-tooltip" title={sendTitle}>
                      {quickMode ? <button type="submit" className="send-button" aria-label="生成 PPT" disabled={quickDisabled} title={sendTitle}>
                        {quickBusy ? <LoaderCircle className="spinning" size={18} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}<span>发送</span>
                      </button> : <ComposerPrimitive.Send className="send-button" aria-label="发送" disabled={props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable} title={sendTitle}>
                        <ArrowUp size={18} aria-hidden="true" /><span>发送</span>
                      </ComposerPrimitive.Send>}
                    </span>
                  )}
                </div>
              </div>
            </ComposerPrimitive.Root>
            <span id="composer-input-hint" className="sr-only"><span className="composer-keyboard-hint">Enter 发送 · Shift + Enter 换行</span><span className="composer-touch-hint">回车换行，点击发送按钮发送</span></span>
            <div className="composer-footer">
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
          {expandedPreview ? (
            <AttachmentPreviewDialog attachment={expandedPreview} localFile={props.localFiles[expandedPreview.id]} loadOriginal={props.onLoadAttachment} onEditGeneratedImage={props.onEditGeneratedImage} gallery={gallery} onNavigate={setExpandedPreview} onClose={() => setExpandedPreview(null)} />
          ) : null}
        </div>
      </ThreadPrimitive.Root>
      <ResearchPanel
        open={researchPanelOpen}
        agent={activeResearch.agent}
        sources={activeResearch.sources}
        selectedSource={activeResearch.selectedSource}
        streaming={props.chatBusy && activeResearch.agent === props.latestAgent}
        onClose={() => closeResearchDetails()}
      />
      {resultSelection ? <ResultDialog key={resultSelection.messageId} {...resultSelection} conversationId={props.currentConversationId ?? undefined} services={props} onClose={() => setResultSelection(null)} /> : null}
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
        currentConversationId={props.currentConversationId}
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
      {conversationListOpen ? <button className="conversation-history-backdrop" type="button" aria-label="关闭对话记录" onClick={() => setConversationListOpen(false)} /> : null}
      {researchPanelOpen ? <button className="research-panel-backdrop" type="button" aria-label="关闭来源详情" onClick={() => closeResearchDetails()} /> : null}
    </section>
  );
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [uploadingPreview, setUploadingPreview] = useState<{ filename: string; url: string } | null>(null);
  const previewUrlsRef = useRef<Record<string, string>>({});
  const [localFiles, setLocalFiles] = useState<Record<string, File>>({});
  const currentConversationRef = useRef(props.currentConversationId);
  currentConversationRef.current = props.currentConversationId;
  const [visionAttachmentIds, setVisionAttachmentIds] = useState<string[]>([]);

  const clearSubmittedAttachments = useCallback((conversationId: number, ids: string[]) => {
    if (currentConversationRef.current !== conversationId) return;
    const submitted = new Set(ids);
    for (const id of ids) {
      const url = previewUrlsRef.current[id];
      if (url) URL.revokeObjectURL(url);
      delete previewUrlsRef.current[id];
    }
    setPreviewUrls({ ...previewUrlsRef.current });
    setPendingAttachments(current => current.filter(item => !submitted.has(item.id)));
    setLocalFiles(current => Object.fromEntries(Object.entries(current).filter(([id]) => !submitted.has(id))));
    setVisionAttachmentIds(current => current.filter(id => !submitted.has(id)));
  }, []);

  useEffect(() => {
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = {};
    setPendingAttachments([]);
    setPreviewUrls({});
    setLocalFiles({});
    setUploadingPreview(null);
    setVisionAttachmentIds([]);
  }, [props.currentConversationId]);

  useEffect(() => {
    const imported = props.libraryAttachments;
    if (!imported || imported.conversationId !== props.currentConversationId) return;
    setPendingAttachments(current => [...current, ...imported.attachments.filter(item => !current.some(existing => existing.id === item.id))]);
    props.onLibraryAttachmentsConsumed?.();
  }, [props.currentConversationId, props.libraryAttachments, props.onLibraryAttachmentsConsumed]);

  useEffect(() => () => {
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const uploadAttachment = useCallback(async (file?: File) => {
    if (!file) return;
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    if (previewUrl) setUploadingPreview({ filename: file.name || "粘贴的图片", url: previewUrl });
    try {
      const attachment = await props.onUploadAttachment(file);
      if (currentConversationRef.current !== props.currentConversationId) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        return;
      }
      if (previewUrl) {
        previewUrlsRef.current[attachment.id] = previewUrl;
        setPreviewUrls({ ...previewUrlsRef.current });
      }
      setPendingAttachments((current) => [...current, attachment]);
      setLocalFiles(current => ({ ...current, [attachment.id]: file }));
      if (attachment.kind === "image") {
        setVisionAttachmentIds((current) => [...current, attachment.id]);
      }
      setUploadingPreview(null);
    } catch (error) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setUploadingPreview(null);
      throw error;
    }
  }, [props]);

  const removePendingAttachment = useCallback(async (attachmentId: string) => {
    await props.onRemoveAttachment(attachmentId);
    const previewUrl = previewUrlsRef.current[attachmentId];
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      delete previewUrlsRef.current[attachmentId];
      setPreviewUrls({ ...previewUrlsRef.current });
    }
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setLocalFiles(current => { const next = { ...current }; delete next[attachmentId]; return next; });
    setVisionAttachmentIds((current) => current.filter((id) => id !== attachmentId));
  }, [props]);

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
      const content = textFromAppendMessage(message);
      if (content) {
        const sent = await props.onSend(
          content,
          pendingAttachments.map((attachment) => attachment.id),
          visionAttachmentIds,
          currentWebSearch(props),
        );
        if (sent === false) return;
        // Failed sends keep content and attachment IDs in retryDraft; do not
        // leave a second copy queued in the composer after a successful retry.
        setPendingAttachments([]);
        setLocalFiles({});
        Object.values(previewUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
        previewUrlsRef.current = {};
        setPreviewUrls({});
        setVisionAttachmentIds([]);
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
      <ChatWorkspaceContent
        {...props}
        pendingAttachments={pendingAttachments}
        previewUrls={previewUrls}
        localFiles={localFiles}
        uploadingPreview={uploadingPreview}
        onUpload={uploadAttachment}
        onRemovePendingAttachment={removePendingAttachment}
        onClearSubmittedAttachments={clearSubmittedAttachments}
      />
    </AssistantRuntimeProvider>
  );
}
