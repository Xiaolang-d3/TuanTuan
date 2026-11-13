import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { useExtensionPreview } from "./ExtensionPreviewContext";
import "./extensions.css";

export function SkillPicker({ selectedSkillId, onSelectSkill }: { selectedSkillId?: string | null; onSelectSkill?: (id: string | null) => void }) {
  const preview = useExtensionPreview();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = preview.items.find((item) => item.id === selectedSkillId);
  const skills = preview.isPreview ? [] : preview.items.filter((item) => item.kind === "skill" && item.enabled && item.user_invocable !== false);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false); }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function selectSkill(id: string | null) {
    onSelectSkill?.(id);
    setOpen(false);
    trigger.current?.focus();
  }

  return <div className="extension-skill-picker" ref={root} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" className="composer-tool" aria-label="技能" aria-expanded={open} title={selected ? `当前技能：${selected.name}` : "选择技能"} onClick={() => { if (!open) void preview.refresh().catch(() => undefined); setOpen(!open); }}><BookOpen size={17} /><span>{selected?.name || "技能"}</span></button>
    {open ? <div className="extension-skill-popover" role="region" aria-label="可用技能">
      {preview.loading ? <p role="status" className="extension-skill-state">正在读取技能…</p> : null}
      {preview.error ? <p className="extension-error" role="alert">{preview.error}</p> : null}
      <ul className="extension-skill-list" aria-label="可选技能">
        {skills.map((item) => <li key={item.id}><button className="extension-skill-option" type="button" title={item.description} aria-pressed={selectedSkillId === item.id} onClick={() => selectSkill(selectedSkillId === item.id ? null : item.id)}>
          <span className="extension-skill-option-icon" aria-hidden="true"><BookOpen size={16} /></span><span className="extension-skill-option-name">{item.name}</span>
        </button></li>)}
      </ul>
      {!preview.isPreview && !skills.length && !preview.loading && !preview.error ? <p className="extension-skill-empty">暂无启用的技能</p> : null}
      <a className="extension-skill-manage" href="#/settings/extensions" onClick={() => setOpen(false)}>管理技能<ArrowUpRight size={14} aria-hidden="true" /></a>
    </div> : null}
  </div>;
}
