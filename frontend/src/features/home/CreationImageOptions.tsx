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

export function CreationImageOptions({ fetchJson, enabled, visible, settings, onChange, onConfigure }: {
  fetchJson: FetchJson;
  enabled: boolean;
  visible: boolean;
  settings: ImageDraftSettings;
  onChange: (settings: ImageDraftSettings) => void;
  onConfigure: () => void;
}) {
  const [result, setResult] = useState<{ client: FetchJson; options?: StudioOptions }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchJson<StudioOptions>("/image-studio/options", { signal: controller.signal }).then(options => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, options });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ client: fetchJson });
    });
    return () => controller.abort();
  }, [enabled, fetchJson, retry]);

  if (!visible) return null;
  const current = result?.client === fetchJson ? result : undefined;
  const options = current?.options;
  if (!enabled || !current) return <span className="creation-option-status">{enabled ? "正在读取模型…" : "正在连接工作区…"}</span>;
  if (!options) return <button className="creation-option-button" type="button" onClick={() => {
    setResult(undefined);
    setRetry(value => value + 1);
  }}>重新读取图片模型</button>;
  if (!options.models.length) return <button className="creation-option-button" type="button" onClick={onConfigure} title="前往模型设置">
    选择模型 <ChevronDown size={14} aria-hidden="true" />
  </button>;

  const profile = settings.profileId ?? "";
  const model = options.models.find(candidate => candidate.id === (profile || options.default_profile_id));
  const sizes = model?.capabilities?.generate.sizes ?? model?.sizes ?? [];
  const size = settings.size && sizes.includes(settings.size) ? settings.size : undefined;
  const ratios = [...new Set(sizes.map(aspectRatio))];
  const resolutions = size ? sizes.filter(option => aspectRatio(option) === aspectRatio(size)) : [];

  return <div className="creation-image-options">
    <label>
      <select aria-label="选择模型" value={model?.id === profile ? profile : ""} onChange={event => onChange({
        profileId: event.target.value || null,
      })}>
        <option value="">默认模型</option>
        {options.models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>
    {sizes.length > 0 && <label>
      <select aria-label="比例" value={size ? aspectRatio(size) : ""} onChange={event => onChange({
        ...settings, size: sizes.find(option => aspectRatio(option) === event.target.value),
      })}>
        <option value="">比例</option>
        {ratios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>}
    {resolutions.length > 0 && size !== "auto" && <label>
      <select aria-label="分辨率" value={size} onChange={event => onChange({ ...settings, size: event.target.value })}>
        {resolutions.map(option => <option key={option} value={option}>{option.replace(/x/i, " × ")}</option>)}
      </select><ChevronDown size={14} aria-hidden="true" />
    </label>}
  </div>;
}
