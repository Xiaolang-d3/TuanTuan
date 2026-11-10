import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { createApiClient } from "../../api/client";
import type { ProfileCapabilityName, ProfileCapabilityReport } from "../../types";
import { CAPABILITY_SOURCE_LABELS, PROFILE_CAPABILITY_ORDER, formatContextTokens, formatUsd } from "./modelCapabilities";

type Client = ReturnType<typeof createApiClient>;
type Override = "" | "supported" | "unsupported";

const STATUS_LABELS = { supported: "支持", unsupported: "不支持", unknown: "未知" } as const;

/** Capability tags (视觉/推理/工具/结构化输出/PDF/缓存 + 上下文) with source and manual overrides. */
export function ModelProfileCapabilities({ profileId, modelName, fetchJson, disabled, onReport, onSavingChange }: {
  profileId: string; modelName: string; fetchJson: Client; disabled: boolean;
  onReport?: (report: ProfileCapabilityReport | null) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [report, setReport] = useState<ProfileCapabilityReport | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const path = `/agent/model-profiles/${encodeURIComponent(profileId)}/capabilities`;

  function accept(next: ProfileCapabilityReport | undefined, id: number) {
    if (generation.current !== id) return;
    const value = next && next.capabilities ? next : null;
    setReport(value);
    onReport?.(value);
    setError(value?.probe_error ?? "");
  }
  async function run(task: () => Promise<ProfileCapabilityReport | undefined>, failure: string, mutation = false) {
    const id = ++generation.current;
    if (mutation) onSavingChange?.(true);
    setWorking(true);
    try { accept(await task(), id); }
    catch (reason) { if (generation.current === id) setError(reason instanceof Error ? reason.message : failure); }
    finally { if (generation.current === id) { setWorking(false); if (mutation) onSavingChange?.(false); } }
  }
  useEffect(() => {
    void run(() => fetchJson<ProfileCapabilityReport>(path), "读取模型能力失败");
    return () => { generation.current += 1; };
  }, [path, fetchJson]);

  function override(capability: ProfileCapabilityName, value: Override) {
    void run(() => fetchJson<ProfileCapabilityReport>(path, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { [capability]: value || null } })
    }), "保存能力设置失败", true);
  }
  function probe() {
    void run(() => fetchJson<ProfileCapabilityReport>(`${path}/probe`, { method: "POST" }), "图片输入检测失败", true);
  }

  return <div className="model-profile-capabilities" aria-label={`${modelName} 能力`}>
    {report ? <>
      <ul className="model-capability-tags">
        {PROFILE_CAPABILITY_ORDER.map(name => {
          const item = report.capabilities[name];
          return <li key={name} className={`model-capability-tag ${item.status}`} title={`${item.label}：${STATUS_LABELS[item.status]} · ${item.detail}`}>
            <span>{item.label}</span><em>{item.status === "unknown" ? "未知" : `${STATUS_LABELS[item.status]} · ${CAPABILITY_SOURCE_LABELS[item.source]}`}</em>
          </li>;
        })}
        <li className="model-capability-tag context" title={`来源：${report.context_window.source === "user" ? "手动" : report.context_window.source === "litellm" ? "LiteLLM" : "未知"}`}>
          <span>上下文</span><em>{formatContextTokens(report.context_window.tokens)}</em>
        </li>
        {report.max_output_tokens.tokens ? <li className="model-capability-tag context"><span>最大输出</span><em>{formatContextTokens(report.max_output_tokens.tokens)}</em></li> : null}
      </ul>
      <details className="model-capability-overrides">
        <summary>手动设置能力</summary>
        <p>手动设置优先于实测和 LiteLLM 数据；选择“自动”恢复自动判断。{report.pricing.input_per_million_usd != null ? ` LiteLLM 参考价：输入 ${formatUsd(report.pricing.input_per_million_usd)} / 输出 ${formatUsd(report.pricing.output_per_million_usd)}（每百万 token）。` : ""}</p>
        <div>
          {PROFILE_CAPABILITY_ORDER.map(name => {
            const item = report.capabilities[name];
            return <label key={name}><span>{item.label}</span>
              <select aria-label={`${modelName} ${item.label} 能力`} value={item.overridden ? item.status : ""} disabled={disabled || working} onChange={event => override(name, event.target.value as Override)}>
                <option value="">自动</option><option value="supported">支持</option><option value="unsupported">不支持</option>
              </select>
            </label>;
          })}
        </div>
        <button type="button" disabled={disabled || working} onClick={probe}><RefreshCw size={12} className={working ? "spinning" : ""} />实测视觉</button>
      </details>
    </> : working ? <p role="status">正在读取模型能力…</p> : null}
    {error ? <p className="model-capability-error" role="alert">{error}</p> : null}
  </div>;
}
