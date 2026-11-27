import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowUp, Bot, FileText, Mic, Plus, Square, Video } from "lucide-react";
import { useVoiceAnswer } from "../../hooks/useVoiceAnswer";
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentKind, MAX_CHAT_ATTACHMENTS } from "../chat/attachment-formats";
import { VoiceDraftEditor } from "../chat/voiceDraft";
import type { VoiceInputService } from "../chat/voiceInput";
import { CreationInspiration } from "./CreationInspiration";

export type CreationMode = "chat" | "images";
export type CreationDrafts = Record<CreationMode, string>;

export const MAX_CREATION_DRAFT_LENGTH = 4000;

const PLACEHOLDER = "说说你想做什么，或描述想要的画面…";

type CreationEntryProps = {
  draft: string;
  files: File[];
  onFiles: (files: File[]) => void;
  onDraft: (text: string) => void;
  onOpen: (text: string) => void;
  onOpenVideo: () => void;
  onOpenDocuments: () => void;
  onOpenSkills: () => void;
  voiceInput: VoiceInputService;
  ready: boolean;
  busy: boolean;
};

/**
 * 工作台唯一输入框：对话和生图共用，发送后进入对话，由团团判断是否生成图片。
 * @param props 草稿、附件、语音输入与发送回调。
 */
export function CreationEntry({
  draft, files, onFiles, onDraft, onOpen, onOpenVideo, onOpenDocuments, onOpenSkills, voiceInput, ready, busy,
}: CreationEntryProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [fileIssue, setFileIssue] = useState("");
  const voiceDraft = useRef(new VoiceDraftEditor());
  const voice = useVoiceAnswer(update => {
    const input = draftInput.current;
    if (!input) return;
    const change = voiceDraft.current.apply(input.value, update, {
      start: input.selectionStart,
      end: input.selectionEnd,
    }, MAX_CREATION_DRAFT_LENGTH);
    if (!change) return;
    flushSync(() => onDraft(change.text));
    input.setSelectionRange(change.selection.start, change.selection.end);
  }, voiceInput);
  const { cancelListening } = voice;
  useLayoutEffect(() => { cancelListening(); }, [ready, busy, voiceInput, cancelListening]);
  const finishingVoice = voice.status === "finishing";
  const action = busy ? "正在打开…" : "发送";
  const voiceLabel = voice.listening ? "停止语音输入" : "语音输入";
  const controlsDisabled = !ready || busy || finishingVoice;

  function toggleVoice() {
    if (voice.listening) {
      void voice.finishListening();
      return;
    }
    voiceDraft.current = new VoiceDraftEditor();
    void voice.startListening();
  }

  async function openWorkspace() {
    const input = draftInput.current;
    if (!input || controlsDisabled) return;
    if (voice.listening && !await voice.finishListening()) return;
    if (draftInput.current === input) onOpen(input.value);
  }

  function addFiles(selectedFiles: File[]) {
    const supported = selectedFiles.filter(file => chatAttachmentKind(file.name));
    const room = Math.max(0, MAX_CHAT_ATTACHMENTS - files.length);
    setFileIssue([
      supported.length < selectedFiles.length ? "不支持的文件未添加。" : "",
      supported.length > room ? `最多添加 ${MAX_CHAT_ATTACHMENTS} 个文件，多出的未添加。` : "",
    ].filter(Boolean).join(" "));
    const accepted = supported.slice(0, room);
    onFiles([...files, ...accepted]);
  }

  function useInspiration(prompt: string) {
    if (finishingVoice) return;
    if (draft.trim() && draft !== prompt && !window.confirm("用此灵感替换当前草稿？")) return;
    cancelListening();
    onDraft(prompt);
    draftInput.current?.focus();
  }

  return (
    <section className="creation-entry" aria-label="工作台">
      <header className="creation-hero">
        <h1>让想法成为现实</h1>
        <p>理解你的想法，帮你把事情做好。</p>
      </header>
      <form className="creation-entry-form" onSubmit={event => {
        event.preventDefault();
        void openWorkspace();
      }}>
        <input ref={fileInput} type="file" hidden multiple accept={CHAT_ATTACHMENT_ACCEPT} aria-label="选择对话附件"
          onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        <textarea ref={draftInput} aria-label="工作台草稿" rows={2} maxLength={MAX_CREATION_DRAFT_LENGTH} value={draft}
          placeholder={PLACEHOLDER} onChange={event => onDraft(event.target.value)} />
        {fileIssue && <p role="alert">{fileIssue}</p>}
        {files.length > 0 && <ul className="creation-entry-files" aria-label="对话草稿附件">
          {files.map((file, index) => <li key={index}>
            <span>{file.name}</span>
            <button type="button" disabled={busy} onClick={() => { setFileIssue(""); onFiles(files.filter((_, itemIndex) => itemIndex !== index)); }}
              aria-label={`移除 ${file.name}`}>移除</button>
          </li>)}
        </ul>}
        {voice.error && <p role="alert">{voice.error}</p>}
        {finishingVoice && <p role="status">正在完成转写…</p>}
        <div className="creation-entry-footer">
          <div className="creation-entry-tools">
            <button className="creation-file-button" type="button" disabled={controlsDisabled} onClick={() => fileInput.current?.click()}>
              <Plus size={16} aria-hidden="true" /> 添加资料
            </button>
          </div>
          <div className="creation-entry-actions">
            <button className="creation-voice-button" type="button" disabled={controlsDisabled}
              aria-pressed={voice.listening} aria-label={voiceLabel} title={voiceLabel} onClick={toggleVoice}>
              {voice.listening ? <Square size={15} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
            </button>
            <button className="creation-submit" type="submit" disabled={controlsDisabled} aria-label={action} title={action}>
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
      <div className="creation-entry-modes">
        <div className="creation-mode-shortcuts" role="group" aria-label="创作快捷入口">
          <button type="button" aria-label="查看视频工作区" onClick={onOpenVideo}><Video size={15} aria-hidden="true" />视频</button>
          <button type="button" onClick={() => { cancelListening(); onOpenDocuments(); }} disabled={!ready}><FileText size={15} aria-hidden="true" />文档</button>
          <button type="button" onClick={onOpenSkills}><Bot size={15} aria-hidden="true" />智能体</button>
        </div>
      </div>
      <CreationInspiration onChoose={useInspiration} />
    </section>
  );
}
