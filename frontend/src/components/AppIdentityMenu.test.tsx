import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIdentityMenu } from "./AppIdentityMenu";
import type { SettingsPage } from "../routing";

describe("AppIdentityMenu", () => {
  afterEach(cleanup);

  it("keeps the avatar glyph decorative and optically wrapped", () => {
    render(
      <AppIdentityMenu
        userEmail="owner@example.com"
        accountName="小林"
        onLogout={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "账号菜单" });
    const avatar = trigger.querySelector(".sidebar-identity-avatar");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveTextContent("小");
    expect(avatar?.querySelector(".sidebar-identity-glyph")).toHaveTextContent("小");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const summary = screen.getByRole("menu", { name: "账号菜单" }).querySelector(".app-identity-summary");
    expect(summary?.querySelector(".sidebar-identity-avatar")).toBeNull();
    expect(summary).toHaveTextContent("小林");
    expect(summary).toHaveTextContent("owner@example.com");
  });

  it("separates the account name from the complete email when no nickname is set", () => {
    const email = "a-very-long-account-name@example.com";
    render(<AppIdentityMenu userEmail={email} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "账号菜单" }));
    const summary = screen.getByRole("menu").querySelector(".app-identity-summary");
    expect(summary?.querySelector("strong")).toHaveTextContent("a-very-long-account-name");
    expect(summary?.querySelector("strong")).toHaveAttribute("title", "a-very-long-account-name");
    expect(summary?.querySelector("small")).toHaveTextContent(email);
    expect(summary?.querySelector("small")).toHaveAttribute("title", email);
  });

  it("supports keyboard navigation and restores focus on Escape", async () => {
    render(<AppIdentityMenu userEmail="owner@example.com" onOpenAccount={vi.fn()} onOpenSettings={vi.fn()} onLogout={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "账号菜单" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const account = screen.getByRole("menuitem", { name: "账号与安全" });
    const settings = screen.getByRole("menuitem", { name: "设置" });
    const logout = screen.getByRole("menuitem", { name: "退出登录" });
    await waitFor(() => expect(account).toHaveFocus());
    fireEvent.keyDown(account, { key: "ArrowDown" });
    await waitFor(() => expect(settings).toHaveFocus());
    fireEvent.keyDown(settings, { key: "End" });
    await waitFor(() => expect(logout).toHaveFocus());
    fireEvent.keyDown(logout, { key: "ArrowDown" });
    await waitFor(() => expect(account).toHaveFocus());
    fireEvent.keyDown(account, { key: "ArrowUp" });
    await waitFor(() => expect(logout).toHaveFocus());
    fireEvent.keyDown(logout, { key: "Home" });
    await waitFor(() => expect(account).toHaveFocus());
    fireEvent.keyDown(account, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).not.toHaveAttribute("aria-controls");
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "退出登录" })).toHaveFocus());
  });

  it("dismisses on outside pointer input", () => {
    render(<><AppIdentityMenu userEmail="owner@example.com" onOpenAccount={vi.fn()} onLogout={vi.fn()} /><button>菜单之外</button></>);
    const trigger = screen.getByRole("button", { name: "账号菜单" });
    const outside = screen.getByRole("button", { name: "菜单之外" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the uploaded avatar and closes after settings or logout actions", async () => {
    const onOpenSettings = vi.fn();
    const onLogout = vi.fn();
    render(<AppIdentityMenu userEmail="owner@example.com" avatarUrl="blob:test-avatar" onOpenSettings={onOpenSettings} onLogout={onLogout} />);
    const trigger = screen.getByRole("button", { name: "账号菜单" });
    expect(trigger.querySelector("img")).toHaveAttribute("src", "blob:test-avatar");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const settings = screen.getByRole("menuitem", { name: "设置" });
    await waitFor(() => expect(settings).toHaveFocus());
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the account menu focused on account, settings, and logout", () => {
    const onOpenAccount = vi.fn();
    const onOpenSettings = vi.fn();
    const onLogout = vi.fn();

    render(
      <AppIdentityMenu
        userEmail="owner@example.com"
        onOpenAccount={onOpenAccount}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "账号菜单" }));

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "账号与安全", "设置", "退出登录"
    ]);
    expect(screen.queryByRole("menuitem", { name: "文件库管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "文件库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "对话" })).not.toBeInTheDocument();
  });

  it("preserves active state, prefetching, and account actions", () => {
    const onOpenAccount = vi.fn();
    const onOpenSettings = vi.fn();
    const onPrefetchPage = vi.fn();

    render(
      <AppIdentityMenu
        userEmail="owner@example.com"
        activeView="settings"
        settingsPage="library"
        onOpenAccount={onOpenAccount}
        onOpenSettings={onOpenSettings}
        onLogout={vi.fn()}
        onPrefetchPage={onPrefetchPage}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "账号菜单" }));
    const settings = screen.getByRole("menuitem", { name: "设置" });
    expect(settings).toHaveAttribute("aria-current", "page");
    fireEvent.focus(settings);
    fireEvent.click(settings);

    expect(onPrefetchPage).toHaveBeenCalledWith("settings");
    expect(onOpenSettings).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "账号菜单" }));
    const account = screen.getByRole("menuitem", { name: "账号与安全" });
    fireEvent.mouseEnter(account);
    fireEvent.click(account);
    expect(onPrefetchPage).toHaveBeenCalledWith("account");
    expect(onPrefetchPage).not.toHaveBeenCalledWith("library");
    expect(onOpenAccount).toHaveBeenCalledOnce();
  });

  it.each<SettingsPage>(["overview", "account", "library", "model", "appearance", "agent"])(
    "indicates the active settings destination on %s",
    (settingsPage) => {
      render(<AppIdentityMenu userEmail="owner@example.com" activeView="settings" settingsPage={settingsPage}
        onOpenAccount={vi.fn()} onOpenSettings={vi.fn()} onLogout={vi.fn()} />);
      const trigger = screen.getByRole("button", { name: "账号菜单" });
      expect(trigger).toHaveClass("active");
      fireEvent.click(trigger);
      const account = screen.getByRole("menuitem", { name: "账号与安全" });
      const settings = screen.getByRole("menuitem", { name: "设置" });
      expect(settingsPage === "account" ? account : settings).toHaveAttribute("aria-current", "page");
      expect(settingsPage === "account" ? settings : account).not.toHaveAttribute("aria-current");
    }
  );

  it("does not mark the account menu as active in the file workspace", () => {
    render(<AppIdentityMenu userEmail="owner@example.com" activeView="chat"
      onOpenAccount={vi.fn()} onOpenSettings={vi.fn()} onLogout={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "账号菜单" });
    expect(trigger).not.toHaveClass("active");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { current: "page" })).not.toBeInTheDocument();
  });
});
