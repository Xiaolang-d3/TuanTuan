import { Moon, Sun } from "lucide-react";
import { useTheme } from "../features/appearance/ThemeProvider";

export function ThemeToggleButton({ className }: { className: string }) {
  const { resolved, setPreference } = useTheme();
  const nextTheme = resolved === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题";

  return (
    <button className={className} type="button" onClick={() => setPreference(nextTheme)} aria-label={label} title={label}>
      {nextTheme === "light" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}
