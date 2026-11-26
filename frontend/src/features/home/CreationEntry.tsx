import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useRef, useState } from "react";
import { ArrowUp, Bot, FileText, Image, MessageCircle, Plus, Video } from "lucide-react";
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentKind, MAX_CHAT_ATTACHMENTS } from "../chat/attachment-formats";
import type { ImageDraftSettings } from "../product/ImageWorkspacePage";
import { CreationImageOptions } from "./CreationImageOptions";
import { CreationInspiration } from "./CreationInspiration";
import type { FetchJson } from "./types";

export type CreationMode = "chat" | "images";
export type CreationDrafts = Record<CreationMode, string>;

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
  ready: boolean;
  busy: boolean;
};

export function CreationEntry({
  mode, onMode, drafts, files, onFiles, onDraft, onOpen, onOpenVideo, onOpenDocuments,
  onOpenSkills, onOpenImageSettings, imageSettings, onImageSettings, fetchJson, ready, busy,
}: CreationEntryProps) {
  const selected = mode === "chat" ? modes[0] : modes[1];
  const fileInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [fileIssue, setFileIssue] = useState("");
  const action = busy ? "正在打开…" : `进入${selected.label}工作区`;

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
    const current = drafts.images;
    if (current.trim() && current !== prompt && !window.confirm("用此灵感替换当前图片草稿？")) return;
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
        if (ready && !busy) onOpen(mode, drafts[mode], mode === "images" ? imageSettings : undefined);
      }}>
        <input ref={fileInput} type="file" hidden multiple accept={CHAT_ATTACHMENT_ACCEPT} aria-label="选择对话附件"
          onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        <textarea ref={draftInput} aria-label={`${selected.label}草稿`} rows={2} maxLength={4000} value={drafts[mode]}
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
        <div className="creation-entry-footer">
          <div className="creation-entry-tools">
            <button className="creation-file-button" type="button" disabled={!ready || busy} onClick={() => fileInput.current?.click()}
              title="在对话中使用资料">
              <Plus size={16} aria-hidden="true" /> 添加资料
            </button>
            <CreationImageOptions fetchJson={fetchJson} enabled={ready && mode === "images"} visible={mode === "images"}
              settings={imageSettings} onChange={onImageSettings} onConfigure={onOpenImageSettings} />
          </div>
          <button className="creation-submit" type="submit" disabled={!ready || busy} aria-label={action} title={action}>
            <ArrowUp size={17} aria-hidden="true" />
          </button>
        </div>
      </form>
      <div className="creation-entry-modes">
        <ToggleGroup<CreationMode> className="creation-mode-toggle-group" aria-label="创作方式" value={[mode]}
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
          <button type="button" onClick={onOpenDocuments} disabled={!ready}><FileText size={15} aria-hidden="true" />文档</button>
          <button type="button" onClick={onOpenSkills}><Bot size={15} aria-hidden="true" />智能体</button>
        </div>
      </div>
      <CreationInspiration onChoose={useInspiration} />
    </section>
  );
}
