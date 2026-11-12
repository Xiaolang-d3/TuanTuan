import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, THEME_STORAGE_KEY } from "../features/appearance/ThemeProvider";
import { AppSidebar } from "./AppSidebar";
import type { SettingsPage } from "../routing";
import type { ViewKey } from "../types";

function renderSidebar(
  identity?: ReactNode,
  collapsed = false,
  activeView: ViewKey = "chat",
  extras: { settingsPage?: SettingsPage; libraryOpen?: boolean } = {}
) {
  const props = {
    collapsed,
    activeView,
    onToggle: vi.fn(),
    onGoHome: vi.fn(),
    onPrefetchPage: vi.fn(),
    onSelectNav: vi.fn(),
    identity,
    ...extras
  };
  render(<ThemeProvider><AppSidebar {...props} /></ThemeProvider>);
  return props;
}

describe("AppSidebar", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
  });

  it("cycles through the three theme colors and preserves the choice after a collapsed sidebar remount", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderSidebar();
    const light = screen.getByRole("button", { name: "当前浅色，点击切换到深色" });
    expect(light.closest(".sidebar-identity-slot")).toBeTruthy();
    fireEvent.click(light);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "当前深色，点击切换到主题色蓝" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("blue");
    fireEvent.click(screen.getByRole("button", { name: "当前主题色蓝，点击切换到浅色" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    cleanup();
    renderSidebar(undefined, true);
    const reset = screen.getByRole("button", { name: "当前浅色，点击切换到深色" });
    expect(reset).toHaveAttribute("title", "当前浅色，点击切换到深色");
  });

  it("returns to home from the brand mark", () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
    expect(props.onGoHome).toHaveBeenCalledOnce();
  });

  it.each([false, true])("places an icon-only theme switch after the account control (collapsed=%s)", collapsed => {
    const account = vi.fn();
    renderSidebar(<button type="button" aria-label="账号菜单" onClick={account}>账户</button>, collapsed);
    const trigger = screen.getByRole("button", { name: "账号菜单" });
    const theme = screen.getByRole("button", { name: /^当前(浅色|深色|主题色蓝)，点击切换到/ });
    expect(trigger.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(theme.textContent).toBe("");
    expect(theme.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(theme);
    expect(account).not.toHaveBeenCalled();
  });

  it("identifies the controlled navigation and reports the expanded state", () => {
    renderSidebar();
    const toggle = screen.getByRole("button", { name: "收起侧边栏" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "app-primary-navigation");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(
      screen.getByRole("navigation", { name: "主导航" })
    );
  });

  it("keeps home navigation separate from the named sidebar toggle", () => {
    const expanded = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(expanded.onToggle).toHaveBeenCalledOnce();
    cleanup();
    const collapsed = renderSidebar(undefined, true);
    const toggle = screen.getByRole("button", { name: "展开侧边栏" });
    const logo = toggle.querySelector("img");
    expect(logo).toHaveAttribute("src", "/tuantuan-logo.png");
    expect(logo).toHaveAttribute("alt", "");
    expect(logo?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(
      screen.getByRole("navigation", { name: "主导航" })
    );
    fireEvent.click(toggle);
    expect(collapsed.onToggle).toHaveBeenCalledOnce();
    expect(collapsed.onGoHome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
    expect(collapsed.onGoHome).toHaveBeenCalledOnce();
    expect(collapsed.onToggle).toHaveBeenCalledOnce();
  });

  it("keeps the shared identity slot without becoming a second app top bar", () => {
    renderSidebar(
      <button className="sidebar-identity" type="button" aria-label="账号菜单">
        <span className="sidebar-identity-avatar">O</span>
      </button>
    );
    expect(document.querySelector("header.app-topbar")).toBeNull();
    expect(screen.getByRole("button", { name: "账号菜单" }).closest(".sidebar-identity-slot")).toBeTruthy();
  });

  it("exposes the available product navigation", () => {
    renderSidebar();
    const desktopNav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(desktopNav).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual([
      "首页",
      "AI 工作区",
      "文件库",
      "设置"
    ]);
    expect(screen.queryByText("快速搜索…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "机会中心" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "资料库" })).not.toBeInTheDocument();
  });

  it("opens home, library, settings, and the AI workspace from the sidebar", () => {
    const props = renderSidebar();
    fireEvent.click(screen.getAllByRole("button", { name: "首页" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "AI 工作区" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "文件库" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "设置" })[0]);
    expect(props.onSelectNav).toHaveBeenCalledWith("dashboard");
    expect(props.onSelectNav).toHaveBeenCalledWith("chat");
    expect(props.onSelectNav).toHaveBeenCalledWith("library");
    expect(props.onSelectNav).toHaveBeenCalledWith("settings");
    expect(props.onSelectNav).toHaveBeenCalledTimes(4);
  });

  it("prefetches a module when its navigation item is hovered", () => {
    const props = renderSidebar();
    fireEvent.mouseEnter(screen.getAllByRole("button", { name: "首页" })[0]);
    fireEvent.mouseEnter(screen.getAllByRole("button", { name: "AI 工作区" })[0]);
    fireEvent.mouseEnter(screen.getAllByRole("button", { name: "文件库" })[0]);
    fireEvent.mouseEnter(screen.getAllByRole("button", { name: "设置" })[0]);
    expect(props.onPrefetchPage).toHaveBeenCalledWith("dashboard");
    expect(props.onPrefetchPage).toHaveBeenCalledWith("chat");
    expect(props.onPrefetchPage).toHaveBeenCalledWith("library");
    expect(props.onPrefetchPage).toHaveBeenCalledWith("settings");
  });

  it("shows primary destinations in the mobile navigation", () => {
    const props = renderSidebar();
    const mobile = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(within(mobile).getByRole("button", { name: "首页" })).toBeInTheDocument();
    expect(within(mobile).getByRole("button", { name: "文件库" })).toBeInTheDocument();
    expect(within(mobile).getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(within(mobile).getByRole("button", { name: "AI 工作区" })).toHaveAttribute("aria-current", "page");
    expect(within(mobile).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual([
      "首页", "AI 工作区", "文件库", "设置"
    ]);
    fireEvent.click(within(mobile).getByRole("button", { name: "AI 工作区" }));
    expect(props.onSelectNav).toHaveBeenCalledWith("chat");
  });

  it("highlights the current destination, including settings", () => {
    renderSidebar(undefined, false, "settings", { settingsPage: "overview" });
    const settingsNav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(settingsNav).getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page");
    expect(within(settingsNav).getByRole("button", { name: "AI 工作区" })).not.toHaveAttribute("aria-current");
    cleanup();

    renderSidebar(undefined, false, "settings", { settingsPage: "model" });
    const modelNav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(modelNav).getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page");
    cleanup();

    renderSidebar(undefined, false, "chat");
    const workspaceNav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(workspaceNav).getByRole("button", { name: "AI 工作区" })).toHaveAttribute("aria-current", "page");
    cleanup();

    renderSidebar(undefined, false, "chat", { libraryOpen: true });
    const filesNav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(filesNav).getByRole("button", { name: "文件库" })).toHaveAttribute("aria-current", "page");
    expect(within(filesNav).getByRole("button", { name: "AI 工作区" })).not.toHaveAttribute("aria-current");
  });

  it("does not expose retired opportunity or analysis product entries", () => {
    renderSidebar(undefined, false, "dashboard");
    expect(screen.queryByRole("button", { name: "机会中心" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分析" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目解析" })).not.toBeInTheDocument();
  });
});
