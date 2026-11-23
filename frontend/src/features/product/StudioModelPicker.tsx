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
  onChange: (id: string) => void;
  preview: ReturnType<typeof useStudioModelPreview>;
  busy: boolean;
}) {
  const { data, error, loading, notice, refresh } = preview;
  const [lastData, setLastData] = useState<StudioPreview>();
  useEffect(() => { if (data) setLastData(data); }, [data]);
  const displayData = data ?? (loading ? lastData : undefined);
  const selectedId = profileId === null ? displayData?.selection?.profile_id : profileId;
  const models = new Map<string, StudioPreview["candidates"][number]>();
  for (const candidate of displayData?.candidates ?? []) {
    if (!candidate.eligible) continue;
    // Keep the resolved default or explicitly selected profile when services share a model name.
    if (!models.has(candidate.model_name) || candidate.profile_id === selectedId) {
      models.set(candidate.model_name, candidate);
    }
  }
  const options = [...models.values()];
  const hasSelection = options.some(model => model.profile_id === selectedId);
  const unavailableModel = profileId && displayData?.candidates.find(candidate => candidate.profile_id === profileId);
  const placeholder = profileId
    ? `${unavailableModel ? unavailableModel.model_name : "已选模型"}（${loading ? "待确认" : "不可用"}）`
    : options.length ? "请选择模型" : loading ? "正在读取模型…" : "没有可用的模型";
  return <div className="studio-model-picker">
    <label>模型 <select aria-label={label} aria-busy={loading} value={hasSelection ? selectedId : ""}
      disabled={busy || !options.length} onChange={event => onChange(event.target.value)}>
      {!hasSelection && <option value="" disabled>{placeholder}</option>}
      {options.map(model => <option key={model.profile_id} value={model.profile_id}>{model.model_name}</option>)}
    </select></label>
    {!loading && (error || (data && (!data.eligible || !data.comparison_key || !data.selection))) &&
      <span role="alert" className="studio-error">{error || reasons[data?.reason ?? ""] || data?.reason || "没有可用的模型服务"} <button type="button" disabled={busy} onClick={() => refresh()}>重新确认模型</button></span>}
    {notice && <span role="alert" className="studio-error">{notice}</span>}
  </div>;
}
