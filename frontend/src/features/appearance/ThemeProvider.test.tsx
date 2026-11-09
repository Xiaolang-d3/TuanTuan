import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider, THEME_STORAGE_KEY, useTheme } from "./ThemeProvider";
import { AppearanceSettingsPage } from "../settings/AppearanceSettingsPage";

let dark = false;
let mediaChange: (() => void) | null;
beforeEach(() => {
  localStorage.clear();
  dark = false;
  mediaChange = null;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ get matches() { return dark; }, addEventListener: (_event: string, callback: () => void) => { mediaChange = callback; }, removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme; document.documentElement.style.colorScheme = ""; });
function Migration({ account }: { account: string }) {
  const { migrateHomeTheme } = useTheme();
  return <button onClick={() => migrateHomeTheme(account)}>迁移</button>;
}
function Page() { return <ThemeProvider><AppearanceSettingsPage /></ThemeProvider>; }
it("applies and persists the same document theme across page remounts", () => {
  const view = render(<Page />);
  fireEvent.click(screen.getByRole("radio", { name: /深色/ }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  view.unmount();
  render(<Page />);
  expect(screen.getByRole("radio", { name: /深色/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /浅色/ }));
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
});
it("follows system changes only while system mode is selected", () => {
  render(<Page />);
  expect(screen.getByRole("radio", { name: /跟随系统/ })).toBeChecked();
  act(() => { dark = true; mediaChange?.(); });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  fireEvent.click(screen.getByRole("radio", { name: /浅色/ }));
  act(() => { dark = false; mediaChange?.(); dark = true; mediaChange?.(); });
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
});
it("syncs another tab's preference and safely falls back for invalid values", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "unknown");
  render(<Page />);
  expect(screen.getByRole("radio", { name: /跟随系统/ })).toBeChecked();
  act(() => { localStorage.setItem(THEME_STORAGE_KEY, "dark"); window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY })); });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); });
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
});
it("migrates the current account's home preference once without overriding a global choice", () => {
  localStorage.setItem("tuantuan-home-theme:account-a", "dark");
  localStorage.setItem("tuantuan-home-theme:account-b", "light");
  const view = render(<ThemeProvider><Migration account="account-a" /><AppearanceSettingsPage /></ThemeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "迁移" }));
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(localStorage.getItem("tuantuan-home-theme:account-a")).toBeNull();
  view.rerender(<ThemeProvider><Migration account="account-b" /><AppearanceSettingsPage /></ThemeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "迁移" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
});
it("keeps theme switching usable when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  render(<Page />);
  fireEvent.click(screen.getByRole("radio", { name: /深色/ }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
});
