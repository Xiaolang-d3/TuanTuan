import { Check, LoaderCircle } from "lucide-react";
import type { AvatarPreset } from "./avatar-presets";
import "./preset-avatar-picker.css";

export type PresetAvatarPickerProps = {
  presets: readonly AvatarPreset[];
  activeId: string | null;
  busyId: string | null;
  disabled: boolean;
  onSelect: (preset: AvatarPreset) => void;
};

/**
 * 奶龙预设头像选择器。纯展示 + 回调，上传/错误处理留在页面里，
 * 因此这里只关心「当前选中哪一张」「哪一张正在处理」「是否整体禁用」。
 */
export function PresetAvatarPicker({ presets, activeId, busyId, disabled, onSelect }: PresetAvatarPickerProps) {
  const locked = disabled || busyId !== null;

  return (
    <div className="avatar-preset-grid" role="group" aria-label="奶龙头像">
      {presets.map((preset) => {
        const active = activeId === preset.id;
        const busy = busyId === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            className={`avatar-preset${active ? " is-active" : ""}${busy ? " is-busy" : ""}`}
            aria-label={`使用${preset.label}`}
            aria-pressed={active}
            aria-busy={busy || undefined}
            title={preset.label}
            disabled={locked}
            onClick={() => onSelect(preset)}
          >
            <img src={preset.src} alt="" draggable={false} loading="lazy" width={64} height={64} />
            {busy ? (
              <span className="avatar-preset-loader">
                <LoaderCircle className="spinning" size={20} aria-hidden="true" />
              </span>
            ) : null}
            {active && !busy ? (
              <span className="avatar-preset-check" aria-hidden="true">
                <Check size={14} strokeWidth={3} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
