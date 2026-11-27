import { useAui, useAuiState } from "@assistant-ui/store";
import { flushTapSync } from "@assistant-ui/tap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { quoteForComposer } from "../../features/chat/conversationActions";
import type { ChatWorkspaceProps } from "../../features/chat/types";
import { VoiceDraftEditor } from "../../features/chat/voiceDraft";
import type { VoiceTranscript } from "../../features/chat/voiceInput";
import { useVoiceAnswer } from "../../hooks/useVoiceAnswer";

type ComposerOptions = Pick<ChatWorkspaceProps,
  "chatBusy" | "chatInputRef" | "composerDraft" | "composerDrafts" | "currentConversationId"
  | "density" | "messages" | "onComposerDraftConsumed" | "onPersistComposerDrafts" | "voiceInput"
>;

/** 在会话间恢复和保存输入，协调草稿导入、引用插入及语音输入。 */
export function useConversationComposer(props: ComposerOptions) {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const [composerFocused, setComposerFocused] = useState(false);
  const showComposerHint = (!props.chatBusy && (composerFocused || (props.messages.length === 0 && props.density !== "dock"))) || composerText.length >= 180_000;
  const localDrafts = useRef(new Map<number, string>());
  const drafts = props.composerDrafts ?? localDrafts.current;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const auiRef = useRef(aui);
  auiRef.current = aui;

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
    // 仅更新图标，避免随音频采样重渲染对话。
    voiceIconRef.current?.style.setProperty("--voice-level", String(level));
  }, []);
  const voice = useVoiceAnswer(appendVoiceTranscript, props.voiceInput, updateVoiceLevel);
  const stopVoiceRef = useRef(voice.cancelListening);
  stopVoiceRef.current = voice.cancelListening;
  useLayoutEffect(() => { stopVoiceRef.current(); }, [props.chatBusy, props.currentConversationId, props.voiceInput]);

  function toggleVoice() {
    if (voice.listening) voice.stopListening();
    else {
      voiceDraftRef.current = new VoiceDraftEditor();
      void voice.startListening();
    }
  }

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
    // 仅在切换对话时载入草稿，避免 setText 引起的 aui 变化覆盖刚插入的引用。
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
  const incomingDraft = props.composerDraft?.conversationId === props.currentConversationId
    ? props.composerDraft
    : null;

  function importIncomingDraft() {
    if (!incomingDraft || props.chatBusy) return;
    const draft = incomingDraft.content;
    aui.composer().setText(draft);
    window.requestAnimationFrame(() => {
      const input = props.chatInputRef.current;
      input?.focus();
      const cursor = draft.length;
      input?.setSelectionRange(cursor, cursor);
    });
    appliedDraftId.current = incomingDraft.id;
    props.onComposerDraftConsumed?.();
  }

  useEffect(() => {
    if (!incomingDraft || props.chatBusy || appliedDraftId.current === incomingDraft.id) return;
    // 已有文字保留可编辑，覆盖需用户主动选择。
    if (aui.composer().getState().text.trim()) return;
    aui.composer().setText(incomingDraft.content);
    appliedDraftId.current = incomingDraft.id;
    props.onComposerDraftConsumed?.();
    window.requestAnimationFrame(() => props.chatInputRef.current?.focus());
  }, [aui, incomingDraft, props.chatBusy, props.chatInputRef, props.onComposerDraftConsumed]);

  useEffect(() => {
    if (props.messages.length > 0 || props.chatBusy || !props.currentConversationId) return;
    const timer = window.setTimeout(() => props.chatInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.chatBusy, props.chatInputRef, props.currentConversationId, props.messages.length]);

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

  function getText() {
    return auiRef.current.composer().getState().text;
  }

  function setText(text: string) {
    auiRef.current.composer().setText(text);
  }

  function clearDraft(conversationId: number) {
    setText("");
    draftsRef.current.delete(conversationId);
    props.onPersistComposerDrafts?.();
  }

  return {
    composerText, showComposerHint, setComposerFocused,
    voiceListening: voice.listening, voiceError: voice.error, voiceIconRef, toggleVoice,
    hasIncomingDraft: !!incomingDraft && appliedDraftId.current !== incomingDraft.id,
    importIncomingDraft, applyQuote, getText, setText, clearDraft,
  };
}
