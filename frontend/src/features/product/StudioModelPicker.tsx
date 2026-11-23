import { useEffect, useState } from "react";
import type { ImageStudioApi, StudioPreview, StudioPreviewRequest } from "./imageStudioApi";
import { failureMessage } from "./useImageWorkspace";

const reasons: Record<string, string> = {
  profile_missing: "模型已删除",
  profile_disabled: "模型已停用",
  service_disabled: "服务已停用",
  credential_missing: "缺少 API 密钥",
  credential_unavailable: "凭证不可用",
  operation_unsupported: "模型不支持此操作",
  capability_unconfirmed: "模型能力待确认",
};

export function useStudioModelPreview(api: ImageStudioApi, enabled: boolean, { operation, profile_id, asset_id }: StudioPreviewRequest) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ api: ImageStudioApi; scope: string; data?: StudioPreview; error?: string } | null>(null);
  const [notice, setNotice] = useState("");
  const scope = JSON.stringify([operation, profile_id, asset_id, revision]);
  const current = enabled && result?.api === api && result.scope === scope ? result : null;

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    const request = { operation, ...(profile_id !== undefined && { profile_id }), ...(asset_id !== undefined && { asset_id }) };
    api.preview(request, controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ api, scope, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ api, scope, error: failureMessage(error) });
    });
    return () => controller.abort();
  }, [api, enabled, scope, operation, profile_id, asset_id]);

  return {
    data: current?.data, error: current?.error, loading: enabled && !current, notice,
    refresh: (message = "") => { setNotice(message); setRevision(value => value + 1); },
  };
}

export function StudioModelPicker({ label, profileId, onChange, preview, busy }: {
  label: string;
  profileId: string | null | undefined;
  onChange: (id: string | null) => void;
  preview: ReturnType<typeof useStudioModelPreview>;
  busy: boolean;
}) {
  const { data, error, loading, notice, refresh } = preview;
  const selection = data?.selection;
  const [lastCandidates, setLastCandidates] = useState<StudioPreview["candidates"]>([]);
  useEffect(() => { if (data) setLastCandidates(data.candidates); }, [data]);
  const candidates = data?.candidates ?? lastCandidates;
  return <div className="studio-model-picker">
    <label>模型 <select aria-label={label} value={profileId ?? (profileId === null ? "" : "unselected")}
      disabled={busy} onChange={event => onChange(event.target.value || null)}>
      {profileId === undefined && <option value="unselected" disabled>请选择模型</option>}
      <option value="">自动选择</option>
      {profileId && !candidates.some(candidate => candidate.profile_id === profileId) &&
        <option value={profileId} disabled>已选模型（待确认）</option>}
      {candidates.map(candidate => <option key={candidate.profile_id} value={candidate.profile_id} disabled={!candidate.eligible}>
        {candidate.model_name} · {candidate.service_name}{!candidate.eligible && `（${reasons[candidate.reason_code ?? ""] ?? "不可用"}）`}
      </option>)}
    </select></label>
    {loading && <span role="status" className="studio-muted">正在确认模型服务…</span>}
    {!loading && selection && <div role="status" className="studio-muted">
      <span>本次使用：{selection.model_name} · {selection.service_name}</span>
      {selection.reason && <small> · {selection.reason}</small>}
    </div>}
    {!loading && (error || (data && (!data.eligible || !data.comparison_key || !selection))) &&
      <span role="alert" className="studio-error">{error || reasons[data?.reason ?? ""] || data?.reason || "没有可用的模型服务"} <button type="button" disabled={busy} onClick={() => refresh()}>重新确认模型</button></span>}
    {notice && <span role="alert" className="studio-error">{notice}</span>}
  </div>;
}
