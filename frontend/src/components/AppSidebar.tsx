import {
  BookOpen,
  FolderKanban,
  GalleryThumbnails,
  History,
  LibraryBig,
  PanelLeft,
  Plus,
  Settings
} from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { sidebarHighlightForView, type SidebarHighlight } from "../constants";
import type { ViewKey } from "../types";
import { appRouteHash, type SettingsPage } from "../routing";
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
  href: string;
  active: boolean;
  /** "page" only when this item is exactly the page on screen; "true" when the user is somewhere inside its section. */
  current?: "page" | "true";
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
  const mobileNavRef = useRef<HTMLElement | null>(null);

  // On a narrow phone the tab strip scrolls inside its own column, so the tab for
  // the current page can sit outside the visible part. Bring it into view.
  useEffect(() => {
    const current = mobileNavRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [highlighted, weixinActive]);

  // A chat opened from the creation records sits inside that section, but the
  // history link itself leads to the list, so it must not claim to be this page.
  const inHistorySection = isActive("chat") && !weixinActive;
  const primaryItems: SidebarItem[] = [
    { key: "dashboard", label: "新建创作", mobileLabel: "创作", icon: <Plus size={18} />, href: appRouteHash({ section: "dashboard" }), active: isActive("dashboard"), current: isActive("dashboard") ? "page" : undefined, prefetch: "dashboard", onClick: () => onSelectNav("dashboard") },
    { key: "history", label: "创作记录", mobileLabel: "记录", icon: <History size={18} />, href: appRouteHash({ section: "history" }), active: isActive("history") || inHistorySection, current: isActive("history") ? "page" : inHistorySection ? "true" : undefined, onClick: () => onSelectNav("history") },
    { key: "works", label: "我的作品", mobileLabel: "作品", icon: <GalleryThumbnails size={18} />, href: appRouteHash({ section: "works" }), active: isActive("works"), current: isActive("works") ? "page" : undefined, onClick: () => onSelectNav("works") },
    { key: "library", label: "知识库", icon: <LibraryBig size={18} />, href: appRouteHash({ section: "chat", page: "library" }), active: isActive("library"), current: isActive("library") ? "page" : undefined, prefetch: "library", onClick: () => onSelectNav("library") },
    { key: "projects", label: "我的项目", mobileLabel: "项目", icon: <FolderKanban size={18} />, href: appRouteHash({ section: "projects" }), active: isActive("projects"), current: isActive("projects") ? "page" : undefined, onClick: () => onSelectNav("projects") },
    { key: "skills", label: "技能中心", mobileLabel: "技能", icon: <BookOpen size={18} />, href: appRouteHash({ section: "skills" }), active: isActive("skills"), current: isActive("skills") ? "page" : undefined, onClick: () => onSelectNav("skills") },
    { key: "settings", label: "设置", icon: <Settings size={18} />, href: appRouteHash({ section: "settings", page: "overview" }), active: isActive("settings"), current: isActive("settings") ? "page" : undefined, prefetch: "settings", onClick: () => onSelectNav("settings") }
  ];
  const [create, history, works, library, projects, skills, settings] = primaryItems;
  const desktopItems = [create, history, works, skills, library];

  // Destinations are real links so they can be opened in a new tab or copied.
  // A plain click still routes inside the app; modified clicks are left to the browser.
  function followInApp(event: MouseEvent<HTMLAnchorElement>, open: () => void) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open();
  }

  function renderItem(item: SidebarItem, extraClass = "") {
    return (
      <a
        className={`nav-item ${item.active ? "active" : ""} ${extraClass}`.trim()}
        key={item.key}
        href={item.href}
        onClick={(event) => followInApp(event, item.onClick)}
        onMouseEnter={() => item.prefetch && onPrefetchPage(item.prefetch)}
        onFocus={() => item.prefetch && onPrefetchPage(item.prefetch)}
        aria-current={item.current}
        aria-label={item.label}
        title={collapsed ? item.label : undefined}
        draggable={false}
      >
        {item.icon}<span>{extraClass === "mobile-nav-item" ? item.mobileLabel ?? item.label : item.label}</span>
      </a>
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
        {desktopItems.map((item) => renderItem(item))}
        {(collapsed || !shortcuts) && renderItem(projects)}
        {collapsed && renderItem(settings)}
      </nav>

      <nav className="nav nav-mobile" aria-label="移动端主导航" ref={mobileNavRef}>
        {primaryItems.map((item) => renderItem(item, "mobile-nav-item"))}
      </nav>

      {!collapsed && shortcuts}

      <div className="sidebar-identity-slot">
        {!collapsed && renderItem(settings, "sidebar-footer-settings")}
        {identity}
        {weixinBot?.connected && onOpenWeixin && <WeixinBotEntry active={weixinActive} unreadCount={weixinBot.unread_count} enabled={weixinBot.enabled} error={weixinBot.error} onOpen={onOpenWeixin} />}
        <ThemeToggleButton className="sidebar-theme-toggle" />
      </div>
    </aside>
  );
}
