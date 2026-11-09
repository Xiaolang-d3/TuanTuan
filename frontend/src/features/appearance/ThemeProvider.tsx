import { readStorageItem } from "../../storage";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import "./global-theme.css";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "tuantuan-theme";
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}
function readTheme(): ThemePreference {
  try { const saved = readStorageItem(THEME_STORAGE_KEY); return isThemePreference(saved) ? saved : "system"; }
  catch { return "system"; }
}
function systemIsDark() { return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; }
function persistTheme(value: ThemePreference) {
  try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* The current window still updates when storage is unavailable. */ }
}
const ThemeContext = createContext<{
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  migrateHomeTheme: (accountKey: string) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setValue] = useState<ThemePreference>(readTheme);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolved: ResolvedTheme = preference === "system" ? systemDark ? "dark" : "light" : preference;
  const setPreference = useCallback((value: ThemePreference) => { setValue(value); persistTheme(value); }, []);
  const migrateHomeTheme = useCallback((accountKey: string) => {
    try {
      if (isThemePreference(readStorageItem(THEME_STORAGE_KEY))) return;
      const legacy = readStorageItem(`tuantuan-home-theme:${accountKey}`);
      if (legacy === "light" || legacy === "dark") {
        setPreference(legacy);
        localStorage.removeItem(`tuantuan-home-theme:${accountKey}`);
      }
    } catch { /* Legacy preferences are optional. */ }
  }, [setPreference]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setValue(readTheme());
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  const value = useMemo(() => ({ preference, resolved, setPreference, migrateHomeTheme }), [preference, resolved, setPreference, migrateHomeTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return value;
}
