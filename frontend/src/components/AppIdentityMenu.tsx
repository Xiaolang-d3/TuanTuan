import { Bell, ChevronDown, ListTodo, LogOut, Search, Settings, ShieldCheck } from "lucide-react";
import type { ViewKey } from "../types";
import type { SettingsPage } from "../routing";
import { DropdownMenu, DropdownMenuContent } from "./ui/DropdownMenu";

type PrefetchPage = "account" | "settings";

export type AppIdentityMenuProps = {
  userEmail?: string;
  accountName?: string;
  avatarUrl?: string | null;
  activeView?: ViewKey;
  settingsPage?: SettingsPage;
  onOpenSearch?: () => void;
  onOpenAccount?: () => void;
  onOpenSettings?: () => void;
  onOpenTasks?: () => void;
  onOpenNotifications?: () => void;
  onLogout: () => void;
  onPrefetchPage?: (page: PrefetchPage) => void;
};

function identityInitial(accountName?: string, userEmail?: string) {
  return (accountName?.trim() || userEmail || "?").slice(0, 1).toUpperCase();
}

export function AppIdentityMenu({
  userEmail,
  accountName,
  avatarUrl,
  activeView,
  settingsPage,
  onOpenSearch,
  onOpenAccount,
  onOpenSettings,
  onOpenTasks,
  onOpenNotifications,
  onLogout,
  onPrefetchPage
}: AppIdentityMenuProps) {
  if (!userEmail) return null;

  const displayName = accountName?.trim() || userEmail.split("@")[0] || "本地账户";
  const accountActive = activeView === "settings" && settingsPage === "account";
  const settingsActive = activeView === "settings";

  return (
    <div className="app-identity">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          className={`sidebar-identity ${settingsActive ? "active" : ""}`}
          title={accountName?.trim() ? `${accountName.trim()} · ${userEmail}` : userEmail}
          aria-label="账号菜单"
        >
          <span className="sidebar-identity-avatar" aria-hidden="true">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : (
              <span className="sidebar-identity-glyph">{identityInitial(accountName, userEmail)}</span>
            )}
          </span>
          <ChevronDown className="app-identity-chevron" size={12} aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenuContent className="app-identity-menu" aria-label="账号菜单" side="top" sideOffset={8}>
          <div className="app-identity-summary">
            <strong title={displayName}>{displayName}</strong>
            <small title={userEmail}>{userEmail}</small>
          </div>
          {onOpenSearch && <DropdownMenu.Item onClick={onOpenSearch}><Search size={16} aria-hidden="true" />全局搜索</DropdownMenu.Item>}
          {(onOpenAccount || onOpenSettings) && (
            <>
              <DropdownMenu.Group aria-label="账户与设置">
                {onOpenAccount && (
                  <DropdownMenu.Item
                    aria-current={accountActive ? "page" : undefined}
                    onClick={onOpenAccount}
                    onMouseEnter={() => onPrefetchPage?.("account")}
                    onFocus={() => onPrefetchPage?.("account")}
                  >
                    <ShieldCheck size={16} aria-hidden="true" />
                    账号与安全
                  </DropdownMenu.Item>
                )}
                {onOpenSettings && (
                  <DropdownMenu.Item
                    aria-current={settingsActive && !accountActive ? "page" : undefined}
                    onClick={onOpenSettings}
                    onMouseEnter={() => onPrefetchPage?.("settings")}
                    onFocus={() => onPrefetchPage?.("settings")}
                  >
                    <Settings size={16} aria-hidden="true" />
                    设置
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Group>
              <DropdownMenu.Separator className="app-identity-divider" />
            </>
          )}
          {(onOpenTasks || onOpenNotifications) && <>
            <DropdownMenu.Group aria-label="创作状态">
              {onOpenTasks && <DropdownMenu.Item onClick={onOpenTasks}><ListTodo size={16} aria-hidden="true" />任务中心</DropdownMenu.Item>}
              {onOpenNotifications && <DropdownMenu.Item onClick={onOpenNotifications}><Bell size={16} aria-hidden="true" />通知</DropdownMenu.Item>}
            </DropdownMenu.Group>
            <DropdownMenu.Separator className="app-identity-divider" />
          </>}
          <DropdownMenu.Item className="danger" onClick={onLogout}>
            <LogOut size={16} aria-hidden="true" />
            退出登录
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Root>
    </div>
  );
}
