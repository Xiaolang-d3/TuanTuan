import { ArrowRight, Image, MessageCircle, Video } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import "./CreationEntry.css";

export type CreationMode = "chat" | "images";
export type CreationDrafts = Record<CreationMode, string>;

const modes = [
  { id: "chat", label: "对话", icon: MessageCircle, placeholder: "例如：帮我把这周的工作整理成一份简报。" },
  { id: "images", label: "图片", icon: Image, placeholder: "例如：一张清晨海边的旅行海报，标题留白。" },
] as const;

export function CreationEntry({ mode, onMode, drafts, onDraft, onOpen, onOpenVideo, ready, busy }: {
  mode: CreationMode;
  onMode: (mode: CreationMode) => void;
  drafts: CreationDrafts;
  onDraft: (mode: CreationMode, text: string) => void;
  onOpen: (mode: CreationMode, text: string) => void;
  onOpenVideo: () => void;
  ready: boolean;
  busy: boolean;
}) {
  const selected = mode === "chat" ? modes[0] : modes[1];
  return (
    <section className="creation-entry" aria-labelledby="creation-entry-title">
      <header>
        <h2 id="creation-entry-title">新建创作</h2>
        <p>先写下你的想法，进入工作区后再选择模型、添加附件或提交。</p>
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
