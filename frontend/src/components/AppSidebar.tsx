import {
  BookOpen,
  Blocks,
  FolderKanban,
  GalleryThumbnails,
  History,
  LibraryBig,
  PanelLeft,
  Plus,
  Settings
} from "lucide-react";
import { type ReactNode } from "react";
import { sidebarHighlightForView, type SidebarHighlight } from "../constants";
import type { ViewKey } from "../types";
import type { SettingsPage } from "../routing";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { WeixinBotEntry } from './WeixinBotEntry';
import type { WeixinBotState } from '../features/chat/useWeixinBot';

export type ProductNavKey = "dashboard" | "history" | "works" | "projects" | "library" | "skills" | "settings";

type PrefetchPage = "chat" | "library" | "dashboard" | "settings";

type SidebarItem = {
  key: ProductNavKey;
  label: string;
  mobileLabel?: string;
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
  shortcuts?: ReactNode;
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
  shortcuts,
  weixinBot,
  weixinActive = false,
  onOpenWeixin
}: AppSidebarProps) {
  const highlighted = sidebarHighlightForView(activeView, { settingsPage, libraryOpen });
  const isActive = (key: SidebarHighlight) => highlighted === key;
  const home = activeView === "dashboard";

  const primaryItems: SidebarItem[] = [
    { key: "dashboard", label: "新建创作", mobileLabel: "创作", icon: <Plus size={18} />, active: isActive("dashboard"), prefetch: "dashboard", onClick: () => onSelectNav("dashboard") },
    { key: "history", label: "创作记录", mobileLabel: "记录", icon: <History size={18} />, active: isActive("history") || (isActive("chat") && !weixinActive), onClick: () => onSelectNav("history") },
    { key: "works", label: "我的作品", mobileLabel: "作品", icon: <GalleryThumbnails size={18} />, active: isActive("works"), onClick: () => onSelectNav("works") },
    { key: "library", label: "知识库", icon: <LibraryBig size={18} />, active: isActive("library"), prefetch: "library", onClick: () => onSelectNav("library") },
    { key: "projects", label: "我的项目", mobileLabel: "项目", icon: <FolderKanban size={18} />, active: isActive("projects"), onClick: () => onSelectNav("projects") },
    { key: "skills", label: "技能中心", mobileLabel: "技能", icon: <BookOpen size={18} />, active: isActive("skills"), onClick: () => onSelectNav("skills") },
    { key: "settings", label: "设置", icon: <Settings size={18} />, active: isActive("settings"), prefetch: "settings", onClick: () => onSelectNav("settings") }
  ];
  const [create, history, works, library, projects, skills, settings] = primaryItems;
  const homeItems = [create, { ...history, label: "创作空间", icon: <Blocks size={18} /> }, works, skills, library];

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
        {item.icon}<span>{extraClass ? item.mobileLabel ?? item.label : item.label}</span>
      </button>
    );
  }

  return (
    <aside className={`sidebar context-navigation shell-light ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <button className="brand-home" type="button" onClick={onGoHome} aria-label="返回首页" title="返回首页">
          <span className="brand-mark" aria-hidden="true">
            <img className="brand-mark-image" src="/tuantuan-mark.svg" alt="" />
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
              <img src="/tuantuan-mark.svg" alt="" />
            </span>
          ) : null}
          <PanelLeft className="sidebar-toggle-icon" size={20} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <nav className="nav nav-desktop" id="app-primary-navigation" aria-label="主导航">
        {(home ? [...homeItems, ...(collapsed ? [projects, settings] : [])] : primaryItems).map((item) => renderItem(item))}
      </nav>

      <nav className="nav nav-mobile" aria-label="移动端主导航">
        {primaryItems.map((item) => renderItem(item, "mobile-nav-item"))}
      </nav>

      {!collapsed && shortcuts}

      <div className="sidebar-identity-slot">
        {home && !collapsed && <div className="sidebar-home-settings">{renderItem(settings)}</div>}
        {identity}
        {weixinBot?.connected && onOpenWeixin && <WeixinBotEntry active={weixinActive} unreadCount={weixinBot.unread_count} enabled={weixinBot.enabled} error={weixinBot.error} onOpen={onOpenWeixin} />}
        {!home && <ThemeToggleButton className="sidebar-theme-toggle" />}
      </div>
    </aside>
  );
}
