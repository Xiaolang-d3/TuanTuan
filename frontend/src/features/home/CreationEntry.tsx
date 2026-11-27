import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowUp, Bot, FileText, Image, MessageCircle, Mic, Plus, Square, Video } from "lucide-react";
import { useVoiceAnswer } from "../../hooks/useVoiceAnswer";
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentKind, MAX_CHAT_ATTACHMENTS } from "../chat/attachment-formats";
import { VoiceDraftEditor } from "../chat/voiceDraft";
import type { VoiceInputService } from "../chat/voiceInput";
import type { ImageDraftSettings } from "../product/ImageWorkspacePage";
import { CreationImageOptions, useCreationImageOptions } from "./CreationImageOptions";
import { CreationInspiration } from "./CreationInspiration";
import type { FetchJson } from "./types";

export type CreationMode = "chat" | "images";
export type CreationDrafts = Record<CreationMode, string>;

export const MAX_CREATION_DRAFT_LENGTH = 4000;

const modes = [
  { id: "chat", label: "对话", icon: MessageCircle, placeholder: "说说你想做什么…" },
  { id: "images", label: "图片", icon: Image, placeholder: "描述你想创作的画面…" },
] as const;

type CreationEntryProps = {
  mode: CreationMode;
  onMode: (mode: CreationMode) => void;
  drafts: CreationDrafts;
  files: File[];
  onFiles: (files: File[]) => void;
  onDraft: (mode: CreationMode, text: string) => void;
  onOpen: (mode: CreationMode, text: string, settings?: ImageDraftSettings) => void;
  onOpenVideo: () => void;
  onOpenDocuments: () => void;
  onOpenSkills: () => void;
  onOpenImageSettings: () => void;
  imageSettings: ImageDraftSettings;
  onImageSettings: (settings: ImageDraftSettings) => void;
  fetchJson: FetchJson;
  voiceInput: VoiceInputService;
  ready: boolean;
  busy: boolean;
};

export function CreationEntry({
  mode, onMode, drafts, files, onFiles, onDraft, onOpen, onOpenVideo, onOpenDocuments,
  onOpenSkills, onOpenImageSettings, imageSettings, onImageSettings, fetchJson, voiceInput, ready, busy,
}: CreationEntryProps) {
  const selected = mode === "chat" ? modes[0] : modes[1];
  const fileInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [fileIssue, setFileIssue] = useState("");
  const imageMode = mode === "images";
  const imageOptions = useCreationImageOptions(fetchJson, ready && imageMode, imageSettings);
  const invalidImageSettings = imageMode && imageOptions.needsConfirmation;
  const voiceDraft = useRef(new VoiceDraftEditor());
  const voice = useVoiceAnswer(update => {
    const input = draftInput.current;
    if (!input) return;
    const change = voiceDraft.current.apply(input.value, update, {
      start: input.selectionStart,
      end: input.selectionEnd,
    }, MAX_CREATION_DRAFT_LENGTH);
    if (!change) return;
    flushSync(() => onDraft(mode, change.text));
    input.setSelectionRange(change.selection.start, change.selection.end);
  }, voiceInput);
  const { cancelListening } = voice;
  useLayoutEffect(() => { cancelListening(); }, [mode, ready, busy, voiceInput, cancelListening]);
  const finishingVoice = voice.status === "finishing";
  const action = busy ? "正在打开…" : `进入${selected.label}工作区`;
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
    if (!input || controlsDisabled || invalidImageSettings) return;
    if (voice.listening && !await voice.finishListening()) return;
    if (draftInput.current === input) onOpen(mode, input.value, imageMode ? imageSettings : undefined);
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
    if (mode === "images" && accepted.length) onMode("chat");
  }

  function useInspiration(prompt: string) {
    if (finishingVoice) return;
    const current = drafts.images;
    if (current.trim() && current !== prompt && !window.confirm("用此灵感替换当前图片草稿？")) return;
    cancelListening();
    onDraft("images", prompt);
    onMode("images");
    draftInput.current?.focus();
  }

  return (
    <section className="creation-entry" aria-label="新建创作">
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
        <textarea ref={draftInput} aria-label={`${selected.label}草稿`} rows={2} maxLength={MAX_CREATION_DRAFT_LENGTH} value={drafts[mode]}
          placeholder={selected.placeholder} onChange={event => onDraft(mode, event.target.value)} />
        {fileIssue && <p role="alert">{fileIssue}</p>}
        {mode === "chat" && files.length > 0 && <ul className="creation-entry-files" aria-label="对话草稿附件">
          {files.map((file, index) => <li key={index}>
            <span>{file.name}</span>
            <button type="button" disabled={busy} onClick={() => { setFileIssue(""); onFiles(files.filter((_, itemIndex) => itemIndex !== index)); }}
              aria-label={`移除 ${file.name}`}>移除</button>
          </li>)}
        </ul>}
        {mode === "images" && files.length > 0 && <p role="status">已选文件保留在对话草稿中。</p>}
        {voice.error && <p role="alert">{voice.error}</p>}
        {finishingVoice && <p role="status">正在完成转写…</p>}
        {invalidImageSettings && <p role="alert" id="creation-image-settings-warning">
          {imageOptions.missingModel ? "原选图片模型已不可用，请重新选择。" : imageOptions.missingSize ? "原选画幅已不可用，请重新选择。" :
            "请确认原选模型和画幅后继续。"}
        </p>}
        <div className="creation-entry-footer">
          <div className="creation-entry-tools">
            <button className="creation-file-button" type="button" disabled={controlsDisabled} onClick={() => fileInput.current?.click()}
              title={imageMode ? "选中文件后将切换到对话，图片草稿会保留" : undefined}>
              <Plus size={16} aria-hidden="true" /> {imageMode ? "添加到对话" : "添加资料"}
            </button>
            {imageMode && <CreationImageOptions state={imageOptions} settings={imageSettings}
              onChange={onImageSettings} onConfigure={onOpenImageSettings} disabled={finishingVoice} />}
          </div>
          <div className="creation-entry-actions">
            <button className="creation-voice-button" type="button" disabled={controlsDisabled}
              aria-pressed={voice.listening} aria-label={voiceLabel} title={voiceLabel} onClick={toggleVoice}>
              {voice.listening ? <Square size={15} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
            </button>
            <button className="creation-submit" type="submit" disabled={controlsDisabled || invalidImageSettings}
              aria-describedby={invalidImageSettings ? "creation-image-settings-warning" : undefined} aria-label={action} title={action}>
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
      <div className="creation-entry-modes">
        <ToggleGroup<CreationMode> className="creation-mode-toggle-group" aria-label="创作方式" value={[mode]} disabled={finishingVoice}
          onValueChange={([nextMode], details) => {
            if (nextMode) onMode(nextMode);
            else details.cancel();
          }}>
          {modes.map(({ id, label, icon: Icon }) => (
            <Toggle key={id} value={id}><Icon size={15} aria-hidden="true" />{label}</Toggle>
          ))}
        </ToggleGroup>
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
