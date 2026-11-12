import { Moon, Palette, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../features/appearance/ThemeProvider";

const THEME_ORDER: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "blue", label: "主题色蓝", Icon: Palette }
];
const NEXT_THEME: Record<ThemePreference, ThemePreference> = { light: "dark", dark: "blue", blue: "light" };

export function ThemeToggleButton({ className }: { className: string }) {
  const { preference, setPreference } = useTheme();
  const current = THEME_ORDER.find(({ value }) => value === preference) ?? THEME_ORDER[0];
  const next = THEME_ORDER.find(({ value }) => value === NEXT_THEME[preference]) ?? THEME_ORDER[1];
  const label = `当前${current.label}，点击切换到${next.label}`;
  const Icon = current.Icon;

  return (
    <button className={className} type="button" onClick={() => setPreference(next.value)} aria-label={label} title={label}>
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}
