import { useEffect, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import type { createApiClient } from "../../api/client";
import type { ModelCatalog, ModelFallbackPolicy, ModelRetryPolicy } from "../../types";
import "./model-connections.css";

type Client = ReturnType<typeof createApiClient>;
type ListKey = "fallback_profile_ids" | "context_window_profile_ids" | "content_policy_profile_ids";

const LISTS: Array<{ key: ListKey; title: string; help: string; limit: number }> = [
  { key: "fallback_profile_ids", title: "备用模型", help: "主模型出错（超时、限流、服务异常等）时按顺序换用。", limit: 5 },
  { key: "context_window_profile_ids", title: "超长上下文时换用", help: "对话超出主模型上下文长度时，改用这些更长上下文的模型。", limit: 2 },
  { key: "content_policy_profile_ids", title: "内容被拒时换用", help: "主模型因内容安全策略拒绝回答时，改用这些模型。", limit: 2 }
];
const RETRIES: Array<{ key: keyof ModelRetryPolicy; label: string }> = [
  { key: "timeout", label: "超时重试" },
  { key: "rate_limit", label: "限流重试" },
  { key: "server_error", label: "服务错误重试" }
];

function clamp(value: string, low: number, high: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? low : Math.min(high, Math.max(low, parsed));
}

/** 备用模型、超长上下文/内容被拒时换用、重试与冷却 (LiteLLM Router). */
export function ModelFallbackSettings({ catalog, fetchJson, busy }: { catalog: ModelCatalog; fetchJson: Client; busy: boolean }) {
  const [saved, setSaved] = useState<ModelFallbackPolicy | null>(null);
  const [draft, setDraft] = useState<ModelFallbackPolicy | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);

  async function load(keepError = false) {
    const id = ++generation.current;
    try {
      const policy = await fetchJson<ModelFallbackPolicy>("/agent/model-fallbacks");
      if (generation.current !== id || !policy || !Array.isArray(policy.fallback_profile_ids)) return;
      setSaved(policy); setDraft(policy);
      if (!keepError) setError("");
    } catch (reason) {
      if (generation.current === id) setError(reason instanceof Error ? reason.message : "读取备用模型设置失败");
    }
  }
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [fetchJson]);

  if (!draft || !saved) return error ? <section className="settings-card model-settings-card model-connections-card model-fallback-card"><p className="model-capability-error" role="alert">{error}</p></section> : null;

  const profiles = catalog.profiles.filter(profile => profile.enabled
    && (!catalog.service_connection_id || profile.connection_id === catalog.service_connection_id)
    && catalog.connections.some(item => item.id === profile.connection_id && item.enabled));
  const retainedIds = new Set(LISTS.flatMap(list => draft[list.key]).filter(id => !profiles.some(profile => profile.id === id)));
  const connectionName = (connectionId: string) => { const item = catalog.connections.find(entry => entry.id === connectionId); return item?.name || item?.model_base_url || "默认服务"; };
  const dirty = JSON.stringify({ ...draft, revision: 0 }) !== JSON.stringify({ ...saved, revision: 0 });
  const native = draft.backend === "native";
  const disabled = busy || saving;

  function toggle(key: ListKey, profileId: string, limit: number) {
    setMessage("");
    setDraft(current => {
      if (!current) return current;
      const list = current[key];
      const next = list.includes(profileId) ? list.filter(item => item !== profileId) : list.length >= limit ? list : [...list, profileId];
      return { ...current, [key]: next };
    });
  }
  async function save() {
    if (!draft || disabled) return;
    setSaving(true); setMessage(""); setError("");
    const id = ++generation.current;
    try {
      const { backend: _backend, revision, ...values } = draft;
      const policy = await fetchJson<ModelFallbackPolicy>("/agent/model-fallbacks", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, expected_revision: revision })
      });
      if (generation.current !== id) return;
      setSaved(policy); setDraft(policy); setMessage("备用模型设置已保存，从下一次对话生效。");
    } catch (reason) {
      if (generation.current !== id) return;
      const conflict = typeof reason === "object" && reason !== null && "status" in reason && Number(reason.status) === 409;
      setError(conflict ? "备用模型设置已在其他页面更新，已读取最新版本，请检查后重新保存。" : reason instanceof Error ? reason.message : "保存备用模型设置失败");
      if (conflict) void load(true);
    } finally {
      setSaving(false);
    }
  }

  return <section className="settings-card model-settings-card model-connections-card model-fallback-card" aria-labelledby="model-fallback-title">
    <div className="model-connections-heading"><div><h3 id="model-fallback-title"><Shuffle size={15} aria-hidden="true" />备用模型</h3><p>主模型出错时按顺序换用，回答会标注实际使用的模型。</p></div>
      <label className="model-fallback-switch"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={event => { setMessage(""); setDraft({ ...draft, enabled: event.target.checked }); }} />启用备用模型</label></div>
    {native ? <p className="model-connections-hint">当前使用原生模型层（TUANTUAN_MODEL_BACKEND=native），备用模型设置会保存，但不会生效。</p> : null}
    {profiles.length < 2 ? <p className="model-connections-hint">至少需要两个可用模型才能设置备用模型，请先在上方添加模型。</p> : null}
    {retainedIds.size ? <p className="model-connections-hint">历史选择已保留，可移除后改选当前服务的模型；不会自动替换。</p> : null}
    {draft.enabled ? <>
      {LISTS.map(list => <fieldset key={list.key} className="model-fallback-list" disabled={disabled}>
        <legend>{list.title}<small>最多 {list.limit} 个 · {list.help}</small></legend>
        <div>{[...profiles, ...draft[list.key].filter(id => !profiles.some(profile => profile.id === id)).map(id => catalog.profiles.find(profile => profile.id === id) ?? { id, connection_id: "", model_name: `不存在的模型（${id}）` })].map(profile => {
          const position = draft[list.key].indexOf(profile.id);
          const retained = retainedIds.has(profile.id);
          return <label key={profile.id} className={position >= 0 ? "selected" : ""}>
            <input type="checkbox" checked={position >= 0} onChange={() => toggle(list.key, profile.id, list.limit)} aria-label={`${list.title}：${profile.model_name}（${connectionName(profile.connection_id)}）`} />
            {position >= 0 && list.key === "fallback_profile_ids" ? <b>{position + 1}</b> : null}
            <span>{profile.model_name}<small>{connectionName(profile.connection_id)}{retained ? " · 历史配置" : ""}{profile.id === catalog.default_profile_id ? " · 默认模型" : ""}</small></span>
          </label>;
        })}</div>
      </fieldset>)}
      <fieldset className="model-fallback-retry" disabled={disabled}>
        <legend>重试与冷却<small>同一模型先按错误类型重试；连续失败达到次数后暂停调用该模型一段时间。</small></legend>
        <div>
          {RETRIES.map(item => <label key={item.key}><span>{item.label}</span><input type="number" min={0} max={3} value={draft.retry_policy[item.key]} onChange={event => setDraft({ ...draft, retry_policy: { ...draft.retry_policy, [item.key]: clamp(event.target.value, 0, 3) } })} /></label>)}
          <label><span>允许失败次数</span><input type="number" min={1} max={20} value={draft.allowed_fails} onChange={event => setDraft({ ...draft, allowed_fails: clamp(event.target.value, 1, 20) })} /></label>
          <label><span>冷却时间（秒）</span><input type="number" min={0} max={3600} value={draft.cooldown_seconds} onChange={event => setDraft({ ...draft, cooldown_seconds: clamp(event.target.value, 0, 3600) })} /></label>
        </div>
      </fieldset>
    </> : <p className="model-connections-hint">启用后可选择备用模型，并设置重试与冷却。</p>}
    {error ? <p className="model-capability-error" role="alert">{error}</p> : null}
    {message ? <p className="model-connections-notice" role="status">{message}</p> : null}
    <div className="model-connection-actions">
      <button type="button" disabled={disabled || !dirty} onClick={() => { setDraft(saved); setMessage(""); }}>撤销修改</button>
      <button className="model-fallback-save" type="button" disabled={disabled || !dirty} onClick={() => void save()}>{saving ? "保存中…" : "保存备用模型"}</button>
    </div>
  </section>;
}
