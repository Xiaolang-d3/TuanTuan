import { useState } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Popover, PopoverContent } from "../../components/ui/Popover";
import { useExtensionPreview } from "./ExtensionPreviewContext";
import "./extensions.css";

export function SkillPicker({ selectedSkillId, onSelectSkill }: { selectedSkillId?: string | null; onSelectSkill?: (id: string | null) => void }) {
  const preview = useExtensionPreview();
  const [open, setOpen] = useState(false);
  const selected = preview.items.find((item) => item.id === selectedSkillId);
  const skills = preview.isPreview ? [] : preview.items.filter((item) => item.kind === "skill" && item.enabled && item.user_invocable !== false);

  return <div className="extension-skill-picker">
    <Popover.Root open={open} onOpenChange={(next) => {
      if (next) void preview.refresh().catch(() => undefined);
      setOpen(next);
    }}>
      <Popover.Trigger className="composer-tool" aria-label="技能" title={selected ? `当前技能：${selected.name}` : "选择技能"}><BookOpen size={17} /><span>{selected?.name || "技能"}</span></Popover.Trigger>
      <PopoverContent className="extension-skill-popover" aria-label="可用技能" side="top" sideOffset={14}>
        {preview.loading ? <p role="status" className="extension-skill-state">正在读取技能…</p> : null}
        {preview.error ? <p className="extension-error" role="alert">{preview.error}</p> : null}
        <ul className="extension-skill-list" aria-label="可选技能">
          {skills.map((item) => <li key={item.id}><Popover.Close className="extension-skill-option" title={item.description} aria-pressed={selectedSkillId === item.id} onClick={() => onSelectSkill?.(selectedSkillId === item.id ? null : item.id)}>
            <span className="extension-skill-option-icon" aria-hidden="true"><BookOpen size={16} /></span><span className="extension-skill-option-name">{item.name}</span>
          </Popover.Close></li>)}
        </ul>
        {!preview.isPreview && !skills.length && !preview.loading && !preview.error ? <p className="extension-skill-empty">暂无启用的技能</p> : null}
        <a className="extension-skill-manage" href="#/settings/extensions" onClick={() => setOpen(false)}>管理技能<ArrowUpRight size={14} aria-hidden="true" /></a>
      </PopoverContent>
    </Popover.Root>
  </div>;
}
