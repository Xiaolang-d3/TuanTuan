import {
  GalleryThumbnails,
  Image,
  MessageCircle,
  Settings,
  Video,
  PanelLeft
} from "lucide-react";
import { type ReactNode } from "react";
import { sidebarHighlightForView, type SidebarHighlight } from "../constants";
import type { ViewKey } from "../types";
import type { SettingsPage } from "../routing";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { WeixinBotEntry } from './WeixinBotEntry';
import type { WeixinBotState } from '../features/chat/useWeixinBot';

export type ProductNavKey = "dashboard" | "chat" | "images" | "video" | "works" | "library" | "settings";

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
  const highlighted = sidebarHighlightForView(activeView, { settingsPage, libraryOpen });
  const isActive = (key: SidebarHighlight) => highlighted === key;

  const primaryItems: SidebarItem[] = [
    { key: "chat", label: "对话", icon: <MessageCircle size={18} />, active: isActive("chat") && !weixinActive, prefetch: "chat", onClick: () => onSelectNav("chat") },
    { key: "images", label: "图片", icon: <Image size={18} />, active: isActive("images"), onClick: () => onSelectNav("images") },
    { key: "video", label: "视频", icon: <Video size={18} />, active: isActive("video"), onClick: () => onSelectNav("video") },
    { key: "works", label: "我的作品", icon: <GalleryThumbnails size={18} />, active: isActive("works"), onClick: () => onSelectNav("works") },
    { key: "settings", label: "设置", icon: <Settings size={18} />, active: isActive("settings"), prefetch: "settings", onClick: () => onSelectNav("settings") }
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
        <ThemeToggleButton className="sidebar-theme-toggle" />
      </div>
    </aside>
  );
}
