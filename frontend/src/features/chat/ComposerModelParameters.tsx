import { useEffect, useRef, useState } from "react";
import type { createApiClient } from "../../api/client";
import type { ModelProfile, ProfileCapabilityReport, ReasoningEffort } from "../../types";
import "./model-parameters.css";

export type ModelParameterUpdate = {
  reasoning_effort: ReasoningEffort | null;
};

export type ComposerModelSettings = {
  profile: ModelProfile;
  protocol?: string;
  fetchJson: ReturnType<typeof createApiClient>;
  onSave: (profileId: string, revision: number, update: ModelParameterUpdate) => Promise<boolean>;
  error?: string;
  capabilityReport?: ProfileCapabilityReport | null;
};

export function ComposerModelParameters({ settings, disabled, readOnly = false, onDirtyChange, onSavingChange }: {
  settings: ComposerModelSettings; disabled: boolean; readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void;
}) {
  const { profile, fetchJson } = settings;
  const [effort, setEffort] = useState<ReasoningEffort | "">(profile.reasoning_effort ?? "");
  const [loadedReport, setReport] = useState<ProfileCapabilityReport | null>(null);
  const report = settings.capabilityReport ?? loadedReport;
  const [capabilityError, setCapabilityError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmedEffort, setConfirmedEffort] = useState<ReasoningEffort | "">(profile.reasoning_effort ?? "");
  const pendingSave = useRef(false);
  const previousProfile = useRef({ id: profile.id, effort: profile.reasoning_effort ?? "" });
  const dirty = effort !== confirmedEffort;

  useEffect(() => {
    const next = profile.reasoning_effort ?? "";
    if (previousProfile.current.id !== profile.id) {
      setEffort(next); setConfirmedEffort(next); setError(""); setSaved(false);
    } else if (previousProfile.current.effort !== next) {
      // Refresh clean fields, but keep an unsaved/failed choice available for retry.
      setEffort(current => current === confirmedEffort ? next : current);
      setConfirmedEffort(next); setSaved(false);
    }
    previousProfile.current = { id: profile.id, effort: next };
  }, [profile.id, profile.reasoning_effort, confirmedEffort]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController();
    setReport(null);
    setCapabilityError(false);
    void fetchJson<ProfileCapabilityReport>(`/agent/model-profiles/${encodeURIComponent(profile.id)}/capabilities`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setReport(value?.capabilities ? value : null); })
      .catch(() => { if (!controller.signal.aborted) setCapabilityError(true); });
    return () => controller.abort();
  }, [profile.id, fetchJson, readOnly]);

  const protocol = report?.protocol || settings.protocol;
  const imageOnly = protocol === "images" || /^gpt-image-/i.test(profile.model_name);
  const unsupported = report?.capabilities.reasoning.status === "unsupported";
  const locked = disabled || saving || readOnly || !profile.enabled || imageOnly;

  async function save(next: ReasoningEffort | "") {
    if (locked || pendingSave.current || next === confirmedEffort || (unsupported && next !== "")) return;
    pendingSave.current = true;
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      if (await settings.onSave(profile.id, profile.revision, { reasoning_effort: next || null })) {
        setConfirmedEffort(next);
        setSaved(true);
      }
      else setError("未能保存，请检查提示后重试。");
    } catch { setError("保存失败，请稍后重试。"); }
    finally { pendingSave.current = false; setSaving(false); }
  }

  return <form className="model-parameters" aria-label={`${profile.model_name} 思考设置`} onSubmit={event => { event.preventDefault(); event.stopPropagation(); }}>
    <fieldset disabled={locked}>
      <label><span>思考程度</span><select aria-label="思考程度" title={capabilityError ? "暂时无法确认该模型是否支持调整思考程度" : "思考越深入，通常耗时越长；自动由模型决定"} value={effort} onChange={event => { const next = event.target.value as ReasoningEffort | ""; setEffort(next); setError(""); setSaved(false); void save(next); }}>
        <option value="">自动</option>
        <option value="low" disabled={unsupported}>轻度</option><option value="medium" disabled={unsupported}>标准</option><option value="high" disabled={unsupported}>深度</option>
      </select></label>
    </fieldset>
    <div className="model-parameters-meta"><span>{imageOnly ? "图片模型不支持此设置" : unsupported ? "此模型仅支持自动" : "自动保存 · 此模型全部对话 · 下次回复生效"}</span><span role="status">{saving ? "保存中…" : saved && !dirty ? "已保存" : ""}</span></div>
    {error || settings.error ? <p role="alert">{settings.error || error}{error && dirty ? <button type="button" disabled={locked} onClick={() => void save(effort)}>重试</button> : null}</p> : null}
  </form>;
}
