import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { StudioOptions } from "../product/imageStudioApi";
import type { ImageDraftSettings } from "../product/ImageWorkspacePage";
import type { FetchJson } from "./types";

function aspectRatio(size: string) {
  if (size === "auto") return "自动";
  const match = /^(\d+)[x×](\d+)$/i.exec(size);
  if (!match) return size;
  const width = Number(match[1]);
  const height = Number(match[2]);
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  return a ? `${width / a}:${height / a}` : size;
}

export function useCreationImageOptions(fetchJson: FetchJson, enabled: boolean, settings: ImageDraftSettings) {
  const [result, setResult] = useState<{ client: FetchJson; options?: StudioOptions }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) { setResult(undefined); return; }
    const controller = new AbortController();
    fetchJson<StudioOptions>("/image-studio/options", { signal: controller.signal }).then(options => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, options });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ client: fetchJson });
    });
    return () => controller.abort();
  }, [enabled, fetchJson, retry]);

  const current = result?.client === fetchJson ? result : undefined;
  const options = current?.options;
  const profile = settings.profileId ?? "";
  const model = options?.models.find(candidate => candidate.id === (profile || options.default_profile_id));
  const sizes = model?.capabilities?.generate.sizes ?? model?.sizes ?? [];
  const missingModel = Boolean(options && profile && !model);
  const missingSize = Boolean(options && settings.size && !sizes.includes(settings.size));
  return {
    enabled, loading: !enabled || !current, options, profile, sizes, missingModel, missingSize,
    needsConfirmation: missingModel || missingSize || Boolean(!options && (profile || settings.size)),
    retry: () => { setResult(undefined); setRetry(value => value + 1); },
  };
}

export function CreationImageOptions({ state, settings, onChange, onConfigure, disabled }: {
  state: ReturnType<typeof useCreationImageOptions>;
  settings: ImageDraftSettings;
  onChange: (settings: ImageDraftSettings) => void;
  onConfigure: () => void;
  disabled: boolean;
}) {
  const { enabled, loading, options, profile, sizes, missingModel, missingSize } = state;
  const clearSelection = state.needsConfirmation && <button className="creation-option-button" type="button"
    disabled={disabled} onClick={() => onChange({ profileId: null, size: null })}>清除原选择</button>;
  if (loading) return <span className="creation-option-status">{enabled ? "正在读取模型…" : "正在连接工作区…"}</span>;
  if (!options) return <>
    <button className="creation-option-button" type="button" disabled={disabled} onClick={state.retry}>重新读取图片模型</button>
    {clearSelection}
  </>;
  if (!options.models.length) return <>
    <button className="creation-option-button" type="button" disabled={disabled} onClick={onConfigure} title="前往模型设置">
      选择模型 <ChevronDown size={14} aria-hidden="true" />
    </button>
    {clearSelection}
  </>;

  const size = settings.size && sizes.includes(settings.size) ? settings.size : undefined;
  const ratios = [...new Set(sizes.map(aspectRatio))];
  const resolutions = size ? sizes.filter(option => aspectRatio(option) === aspectRatio(size)) : [];

  return <div className="creation-image-options">
    <label>
      <select aria-label="选择模型" value={profile} disabled={disabled} onChange={event => onChange({
        profileId: event.target.value || null,
      })}>
        {missingModel && <option value={profile} disabled>原选模型已不可用</option>}
        <option value="">默认模型</option>
        {options.models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>
    {sizes.length > 0 && <label>
      <select aria-label="比例" value={missingSize ? settings.size ?? "" : size ? aspectRatio(size) : ""} disabled={disabled} onChange={event => onChange({
        ...settings, size: sizes.find(option => aspectRatio(option) === event.target.value) ?? null,
      })}>
        {missingSize && <option value={settings.size ?? undefined} disabled>原选画幅已不可用</option>}
        <option value="">比例</option>
        {ratios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>}
    {resolutions.length > 0 && size !== "auto" && <label>
      <select aria-label="分辨率" value={size} disabled={disabled} onChange={event => onChange({ ...settings, size: event.target.value })}>
        {resolutions.map(option => <option key={option} value={option}>{option.replace(/x/i, " × ")}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>}
    {!missingModel && missingSize && sizes.length === 0 && clearSelection}
  </div>;
}
