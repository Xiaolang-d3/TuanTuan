import {
  Folder,
  Home,
  MessageCircle,
  Moon,
  Sun,
  PanelLeft
} from "lucide-react";
import { type ReactNode } from "react";
import { sidebarHighlightForView, type SidebarHighlight } from "../constants";
import type { ViewKey } from "../types";
import type { SettingsPage } from "../routing";
import { useTheme } from "../features/appearance/ThemeProvider";
import { WeixinBotEntry } from './WeixinBotEntry';
import type { WeixinBotState } from '../features/chat/useWeixinBot';

export type ProductNavKey = "dashboard" | "chat" | "library";

type PrefetchPage = "chat" | "library" | "dashboard" | "settings";

type SidebarItem = {
  key: ProductNavKey;
  label: string;
  icon: ReactNode;
  active: boolean;
  prefetch?: PrefetchPage;
  onClick: () => void;
};

type AppSidebarProps = {
  collapsed: boolean;
  activeView: ViewKey;
  onToggle: () => void;
  onGoHome: () => void;
  onPrefetchPage: (page: PrefetchPage) => void;
  settingsPage?: SettingsPage;
  libraryOpen?: boolean;
  onSelectNav: (key: ProductNavKey) => void;
  identity?: ReactNode;
  weixinBot?: WeixinBotState | null;
  weixinActive?: boolean;
  onOpenWeixin?: () => void;
};

export function AppSidebar({
  collapsed,
  activeView,
  onToggle,
  onGoHome,
  onPrefetchPage,
  settingsPage,
  libraryOpen,
  onSelectNav,
  identity,
  weixinBot,
  weixinActive = false,
  onOpenWeixin
}: AppSidebarProps) {
  const { resolved, setPreference } = useTheme();
  const nextTheme = resolved === "dark" ? "light" : "dark";
  const themeLabel = nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题";
  const highlighted = sidebarHighlightForView(activeView, { settingsPage, libraryOpen });
  const isActive = (key: SidebarHighlight) => highlighted === key;

  const primaryItems: SidebarItem[] = [
    { key: "dashboard", label: "首页", icon: <Home size={18} />, active: isActive("dashboard"), prefetch: "dashboard", onClick: () => onSelectNav("dashboard") },
    { key: "chat", label: "AI 工作区", icon: <MessageCircle size={18} />, active: isActive("chat") && !weixinActive, prefetch: "chat", onClick: () => onSelectNav("chat") },
    { key: "library", label: "文件库", icon: <Folder size={18} />, active: isActive("library"), prefetch: "library", onClick: () => onSelectNav("library") }
  ];

  function renderItem(item: SidebarItem, extraClass = "") {
    return (
      <button
        className={`nav-item ${item.active ? "active" : ""} ${extraClass}`.trim()}
        key={item.key}
        onClick={item.onClick}
        onMouseEnter={() => item.prefetch && onPrefetchPage(item.prefetch)}
        onFocus={() => item.prefetch && onPrefetchPage(item.prefetch)}
        aria-current={item.active ? "page" : undefined}
        aria-label={item.label}
        title={collapsed ? item.label : undefined}
      >
        {item.icon}<span>{item.label}</span>
      </button>
    );
  }

  return (
    <aside className={`sidebar context-navigation shell-light ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <button className="brand-home" type="button" onClick={onGoHome} aria-label="返回首页" title="返回首页">
          <span className="brand-mark" aria-hidden="true">
            <img className="brand-mark-image" src="/tuantuan-logo.png" alt="" />
          </span>
          <span className="brand-copy">
            <strong>团团</strong>
            <small>理解你的想法，帮你把事情做好。</small>
          </span>
        </button>
        <button
          className="sidebar-toggle sidebar-header-toggle"
          type="button"
          onClick={onToggle}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-expanded={!collapsed}
          aria-controls="app-primary-navigation"
        >
          {collapsed ? (
            <span className="sidebar-toggle-logo" aria-hidden="true">
              <img src="/tuantuan-logo.png" alt="" />
            </span>
          ) : null}
          <PanelLeft className="sidebar-toggle-icon" size={20} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <nav className="nav nav-desktop" id="app-primary-navigation" aria-label="主导航">
        {primaryItems.map((item) => renderItem(item))}
      </nav>

      <nav className="nav nav-mobile" aria-label="移动端主导航">
        {primaryItems.map((item) => renderItem(item, "mobile-nav-item"))}
      </nav>

      <div className="sidebar-identity-slot">
        {identity}
        {weixinBot?.connected && onOpenWeixin && <WeixinBotEntry active={weixinActive} unreadCount={weixinBot.unread_count} enabled={weixinBot.enabled} error={weixinBot.error} onOpen={onOpenWeixin} />}
        <button
          className="sidebar-theme-toggle"
          type="button"
          onClick={() => setPreference(nextTheme)}
          aria-label={themeLabel}
          title={themeLabel}
        >
          {nextTheme === "light" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
        </button>
      </div>
    </aside>
  );
}
