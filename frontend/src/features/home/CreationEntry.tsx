import { useRef, useState } from "react";
import { ArrowRight, Image, MessageCircle, Paperclip, Video } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentKind, MAX_CHAT_ATTACHMENTS } from "../chat/attachment-formats";
import "./CreationEntry.css";

export type CreationMode = "chat" | "images";
export type CreationDrafts = Record<CreationMode, string>;

const modes = [
  { id: "chat", label: "对话", icon: MessageCircle, placeholder: "例如：帮我把这周的工作整理成一份简报。" },
  { id: "images", label: "图片", icon: Image, placeholder: "例如：一张清晨海边的旅行海报，标题留白。" },
] as const;

export function CreationEntry({ mode, onMode, drafts, files, onFiles, onDraft, onOpen, onOpenVideo, ready, busy }: {
  mode: CreationMode;
  onMode: (mode: CreationMode) => void;
  drafts: CreationDrafts;
  files: File[];
  onFiles: (files: File[]) => void;
  onDraft: (mode: CreationMode, text: string) => void;
  onOpen: (mode: CreationMode, text: string) => void;
  onOpenVideo: () => void;
  ready: boolean;
  busy: boolean;
}) {
  const selected = mode === "chat" ? modes[0] : modes[1];
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileIssue, setFileIssue] = useState("");

  function addFiles(selectedFiles: File[]) {
    const supported = selectedFiles.filter(file => chatAttachmentKind(file.name));
    const room = Math.max(0, MAX_CHAT_ATTACHMENTS - files.length);
    setFileIssue([
      supported.length < selectedFiles.length ? "不支持的文件未添加。" : "",
      supported.length > room ? `最多添加 ${MAX_CHAT_ATTACHMENTS} 个文件，多出的未添加。` : "",
    ].filter(Boolean).join(" "));
    onFiles([...files, ...supported.slice(0, room)]);
  }
  return (
    <section className="creation-entry" aria-labelledby="creation-entry-title">
      <header>
        <h2 id="creation-entry-title">新建创作</h2>
        <p>先写下你的想法，进入工作区后再选择模型或提交。</p>
      </header>
      <div className="creation-entry-modes" role="group" aria-label="创作方式">
        {modes.map(({ id, label, icon: Icon }) => (
          <ActionButton key={id} size="sm" variant={mode === id ? "secondary" : "ghost"} aria-pressed={mode === id}
            icon={<Icon size={16} aria-hidden="true" />} onClick={() => onMode(id)}>{label}</ActionButton>
        ))}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onOpen(mode, drafts[mode]); }}>
        <label htmlFor="creation-entry-draft">{selected.label}草稿</label>
        <textarea id="creation-entry-draft" rows={3} maxLength={4000} value={drafts[mode]}
          placeholder={selected.placeholder} onChange={(event) => onDraft(mode, event.target.value)} />
        {mode === "chat" && <div className="creation-entry-files">
          <input ref={fileInput} type="file" hidden multiple accept={CHAT_ATTACHMENT_ACCEPT} aria-label="选择对话附件"
            onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          <ActionButton size="sm" disabled={!ready || busy} onClick={() => fileInput.current?.click()} icon={<Paperclip size={15} aria-hidden="true" />}>添加对话附件</ActionButton>
          <p>附件暂留在本页。进入对话后可选择上传，发送前可以移除。</p>
          {fileIssue && <p role="alert">{fileIssue}</p>}
          {files.length > 0 && <ul aria-label="对话草稿附件">{files.map((file, index) => <li key={index}>
            <span>{file.name}</span>
            <ActionButton size="sm" disabled={busy} onClick={() => { setFileIssue(""); onFiles(files.filter((_, itemIndex) => itemIndex !== index)); }} aria-label={`移除 ${file.name}`}>移除</ActionButton>
          </li>)}</ul>}
        </div>}
        {mode === "images" && files.length > 0 && <p role="status">图片创作不接收这些附件，已选文件保留在首页对话草稿中。</p>}
        <div className="creation-entry-footer">
          <p>打开工作区不会发送草稿或调用模型。</p>
          <ActionButton type="submit" variant="primary" disabled={!ready || busy}
            icon={<ArrowRight size={16} aria-hidden="true" />}>
            {busy ? "正在打开…" : `进入${selected.label}工作区`}
          </ActionButton>
        </div>
      </form>
      <div className="creation-entry-legacy">
        <ActionButton size="sm" variant="ghost" icon={<Video size={16} aria-hidden="true" />} onClick={onOpenVideo}>查看视频工作区</ActionButton>
      </div>
    </section>
  );
}
