import { useEffect, useRef, useState } from "react";
import type { ModelProfile } from "../../types";

const fields = [{ key: "chat", label: "对话输出" }, { key: "image_generation", label: "图片生成" }, { key: "video_generation", label: "视频生成" }] as const;
type Status = "supported" | "unsupported" | "unknown";
export function ModelOutputSettings({ profile, busy, readOnly = false, onSave, onDirtyChange, onSavingChange }: {
  profile: ModelProfile; busy: boolean; readOnly?: boolean; onSave: (capabilities: Record<string, Status>) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void;
}) {
  const [draft, setDraft] = useState<Record<string, Status> | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const baseline = Object.fromEntries(fields.map(field => [field.key, (profile.capabilities?.[field.key] as Status) || "unknown"]));
  const dirty = !!draft && Object.keys(draft).some(key => draft[key] !== baseline[key]);
  const locked = busy || saving || readOnly || !profile.enabled;
  useEffect(() => { setDraft(null); setMessage(""); setError(""); }, [profile.id]);
  useEffect(() => {
    setDraft(current => current && Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== baseline[key])));
  }, [baseline.chat, baseline.image_generation, baseline.video_generation]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);
  async function save() {
    if (!draft || locked || pendingSave.current) return;
    pendingSave.current = true; setSaving(true); setError(""); setMessage("");
    try {
      if (await onSave({ ...baseline, ...draft })) { setDraft(null); setMessage("模型输出能力已保存。"); }
      else setError("未确认保存，能力修改已保留，请重试。");
    } catch { setError("保存失败，能力修改已保留，请重试。"); }
    finally { pendingSave.current = false; setSaving(false); }
  }
  return <section className="model-output-settings" aria-label="模型输出能力">
    <div className="model-connections-heading"><div><h4>模型输出能力</h4><p>自动识别仅供参考。图片输入与图片生成是不同能力；修改后需保存。</p></div>{!draft ? <button type="button" disabled={locked} onClick={() => { setMessage(""); setError(""); setDraft({}); }}>编辑能力</button> : null}</div>
    {draft ? <><div className="model-output-fields">{fields.map(field => <label key={field.key}>{field.label}<select aria-label={`${profile.model_name} ${field.label}`} disabled={locked} value={draft[field.key] ?? baseline[field.key]} onChange={event => {
      const value = event.target.value as Status;
      setDraft(current => { const next = { ...current }; if (value === baseline[field.key]) delete next[field.key]; else next[field.key] = value; return next; }); setError("");
    }}><option value="unknown">自动识别</option><option value="supported">支持</option><option value="unsupported">不支持</option></select></label>)}</div><div className="model-connection-actions"><button type="button" disabled={locked} onClick={() => void save()}>{saving ? "保存中…" : "保存模型能力"}</button><button type="button" disabled={busy || saving} onClick={() => { setDraft(null); setError(""); }}>取消</button></div></> : <p>{profile.output_types?.map(type => ({ chat: "对话", image: "图片生成", video: "视频生成" })[type]).join("、") || "待确认"} · {profile.output_types_source === "configured" ? "已配置" : "自动识别"}</p>}
    <p>声明能力不会接入新的生成接口。视频生成暂未接入，图片生成需匹配已支持的接口。</p>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
