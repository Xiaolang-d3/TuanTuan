import { useState } from "react";
import type { ModelProfile } from "../../types";

type Update = { parameters: Record<string, unknown>; context_limit: number | null };
export function UnifiedModelParameters({ profile, busy, onSave }: { profile: ModelProfile; busy: boolean; onSave: (body: Update) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [temperature, setTemperature] = useState(String(profile.parameters?.temperature ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(profile.parameters?.max_output_tokens ?? ""));
  const [context, setContext] = useState(String(profile.context_limit ?? ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function reset() { setTemperature(String(profile.parameters?.temperature ?? "")); setMaxTokens(String(profile.parameters?.max_output_tokens ?? "")); setContext(String(profile.context_limit ?? "")); setError(""); }
  async function save() {
    if (saving || busy) return;
    const parameters = { ...profile.parameters };
    if (temperature !== "" && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)) { setError("温度需要在 0 到 2 之间。"); return; }
    if ([maxTokens, context].some(value => value !== "" && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0))) { setError("输出上限与上下文限制需要填写正整数，或留空使用自动值。"); return; }
    delete parameters.temperature; delete parameters.max_output_tokens;
    if (temperature !== "") parameters.temperature = Number(temperature);
    if (maxTokens !== "") parameters.max_output_tokens = Number(maxTokens);
    setSaving(true); setError("");
    try { if (await onSave({ parameters, context_limit: context === "" ? null : Number(context) })) setEditing(false); else setError("未确认保存，请核对配置后重试。"); }
    catch { setError("保存失败，请重试。"); }
    finally { setSaving(false); }
  }
  return <details className="unified-capability-details"><summary>请求参数（可选）</summary>
    <p className="unified-directory-note">通常保持自动即可。服务与模型可能限制参数范围；留空使用服务默认值。</p>
    {editing ? <form className="unified-request-parameters" aria-label="请求参数" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="unified-connection-fields"><label>温度<input aria-label="温度" inputMode="decimal" value={temperature} placeholder="自动" disabled={busy || saving} onChange={event => setTemperature(event.target.value)} /></label><label>最大输出 token<input aria-label="最大输出 token" inputMode="numeric" value={maxTokens} placeholder="自动" disabled={busy || saving} onChange={event => setMaxTokens(event.target.value)} /></label><label>上下文限制<input aria-label="上下文限制" inputMode="numeric" value={context} placeholder="自动" disabled={busy || saving} onChange={event => setContext(event.target.value)} /></label></div>
      <p className="unified-directory-note">上下文限制包含输入和输出；手动限制时请同时设置输出上限。</p>
      <div className="unified-actions"><button type="submit" disabled={busy || saving}>保存请求参数</button><button type="button" disabled={busy || saving} onClick={() => { reset(); setEditing(false); }}>取消参数修改</button></div>
    </form> : <><p className="unified-directory-note">温度：{profile.parameters?.temperature == null ? "自动" : String(profile.parameters.temperature)} · 最大输出：{profile.parameters?.max_output_tokens == null ? "自动" : String(profile.parameters.max_output_tokens)} · 上下文：{profile.context_limit ?? "自动"}</p><button type="button" disabled={busy} onClick={() => { reset(); setEditing(true); }}>编辑请求参数</button></>}
    {error ? <p role="alert" className="unified-alert">{error}</p> : null}
  </details>;
}
