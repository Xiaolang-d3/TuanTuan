import { useEffect, useRef, useState } from "react";
import type { ModelProfile } from "../../types";

type Update = { parameters: Record<string, unknown>; context_limit: number | null };
type Draft = Partial<Record<"temperature" | "maxTokens" | "context", string>>;
export function UnifiedModelParameters({ profile, busy, readOnly = false, onSave, onDirtyChange, onSavingChange }: {
  profile: ModelProfile; busy: boolean; readOnly?: boolean; onSave: (body: Update) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const baseline = { temperature: String(profile.parameters?.temperature ?? ""), maxTokens: String(profile.parameters?.max_output_tokens ?? ""), context: String(profile.context_limit ?? "") };
  const values = { ...baseline, ...draft };
  const { temperature, maxTokens, context } = values;
  const dirty = Object.keys(draft).some(key => draft[key as keyof Draft] !== baseline[key as keyof Draft]);
  const locked = busy || saving || readOnly || !profile.enabled;
  useEffect(() => { setDraft({}); setEditing(false); setError(""); }, [profile.id]);
  useEffect(() => {
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== baseline[key as keyof Draft])));
  }, [baseline.temperature, baseline.maxTokens, baseline.context]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);
  function reset() { setDraft({}); setError(""); }
  function change(key: keyof Draft, value: string) {
    setDraft(current => { const next = { ...current }; if (value === baseline[key]) delete next[key]; else next[key] = value; return next; });
    setError("");
  }
  async function save() {
    if (locked || pendingSave.current) return;
    const parameters = { ...profile.parameters };
    if (temperature !== "" && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)) { setError("温度需要在 0 到 2 之间。"); return; }
    if ([maxTokens, context].some(value => value !== "" && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0))) { setError("输出上限与上下文限制需要填写正整数，或留空使用自动值。"); return; }
    delete parameters.temperature; delete parameters.max_output_tokens;
    if (temperature !== "") parameters.temperature = Number(temperature);
    if (maxTokens !== "") parameters.max_output_tokens = Number(maxTokens);
    pendingSave.current = true; setSaving(true); setError("");
    try { if (await onSave({ parameters, context_limit: context === "" ? null : Number(context) })) { setDraft({}); setEditing(false); } else setError("未确认保存，修改已保留，请核对配置后重试。"); }
    catch { setError("保存失败，修改已保留，请重试。"); }
    finally { pendingSave.current = false; setSaving(false); }
  }
  return <details className="unified-capability-details"><summary>请求参数（可选）</summary>
    <p className="unified-directory-note">通常保持自动即可。服务与模型可能限制参数范围；留空使用服务默认值。修改后需点击“保存请求参数”。</p>
    {editing ? <form className="unified-request-parameters" aria-label="请求参数" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="unified-connection-fields"><label>温度<input aria-label="温度" inputMode="decimal" value={temperature} placeholder="自动" disabled={locked} onChange={event => change("temperature", event.target.value)} /></label><label>最大输出 token<input aria-label="最大输出 token" inputMode="numeric" value={maxTokens} placeholder="自动" disabled={locked} onChange={event => change("maxTokens", event.target.value)} /></label><label>上下文限制<input aria-label="上下文限制" inputMode="numeric" value={context} placeholder="自动" disabled={locked} onChange={event => change("context", event.target.value)} /></label></div>
      <p className="unified-directory-note">上下文限制包含输入和输出；手动限制时请同时设置输出上限。</p>
      <div className="unified-actions"><button type="submit" disabled={locked}>{saving ? "保存中…" : "保存请求参数"}</button><button type="button" disabled={busy || saving} onClick={() => { reset(); setEditing(false); }}>取消参数修改</button></div>
    </form> : <><p className="unified-directory-note">温度：{baseline.temperature || "自动"} · 最大输出：{baseline.maxTokens || "自动"} · 上下文：{baseline.context || "自动"}</p><button type="button" disabled={locked} onClick={() => { reset(); setEditing(true); }}>编辑请求参数</button></>}
    {error ? <p role="alert" className="unified-alert">{error}</p> : null}
  </details>;
}
