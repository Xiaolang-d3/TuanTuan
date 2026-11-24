import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeInfoTabs, type HomeInfoTabDef } from "./HomeInfoTabs";

const tabs: HomeInfoTabDef[] = [
  { id: "ai", title: "AI 动态", count: "2 条新" },
  { id: "trending", title: "技术热榜" },
  { id: "stack", title: "我的技术栈" }
];
const panels = {
  ai: <div>AI 面板内容</div>,
  trending: <div>热榜面板内容</div>,
  stack: <div>技术栈面板内容</div>
};

function renderTabs(accountKey = "tabs-account") {
  return render(<HomeInfoTabs accountKey={accountKey} tabs={tabs} panels={panels} />);
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); });

describe("HomeInfoTabs", () => {
  it("activates the first tab, renders only its panel, and shows the count badge", () => {
    renderTabs();
    const tablist = screen.getByRole("tablist", { name: "信息流分类" });
    const aiTab = within(tablist).getByRole("tab", { name: /AI 动态/ });
    expect(aiTab).toHaveAttribute("aria-selected", "true");
    expect(within(aiTab).getByText("2 条新")).toBeInTheDocument();
    const activePanel = screen.getByRole("tabpanel");
    expect(aiTab).toHaveAttribute("aria-controls", activePanel.id);
    expect(screen.getByText("AI 面板内容")).toBeVisible();
    expect(screen.queryByText("热榜面板内容")).not.toBeInTheDocument();
    expect(screen.queryByText("技术栈面板内容")).not.toBeInTheDocument();
    expect(activePanel).toHaveAttribute("aria-labelledby", aiTab.id);
  });

  it("mounts a panel on first visit, preserves its DOM state, and persists the choice per account", () => {
    const editablePanels = { ...panels, trending: <input aria-label="热榜筛选" /> };
    render(<HomeInfoTabs accountKey="tabs-account" tabs={tabs} panels={editablePanels} />);
    const trendingTab = screen.getByRole("tab", { name: "技术热榜" });
    const aiTab = screen.getByRole("tab", { name: /AI 动态/ });
    expect(screen.queryByLabelText("热榜筛选")).not.toBeInTheDocument();

    fireEvent.click(trendingTab);
    expect(trendingTab).toHaveAttribute("aria-selected", "true");
    const field = screen.getByRole("textbox", { name: "热榜筛选" });
    fireEvent.change(field, { target: { value: "keep this" } });
    expect(screen.getByText("AI 面板内容")).not.toBeVisible();
    expect(screen.queryByText("技术栈面板内容")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-home-tab:tabs-account")).toBe("trending");

    fireEvent.click(aiTab);
    expect(field).toBeInTheDocument();
    expect(field).not.toBeVisible();
    fireEvent.click(trendingTab);
    expect(screen.getByRole("textbox", { name: "热榜筛选" })).toBe(field);
    expect(field).toHaveValue("keep this");
  });

  it("restores the last active tab from storage and ignores invalid values", () => {
    window.localStorage.setItem("tuantuan-home-tab:tabs-account", "stack");
    renderTabs();
    expect(screen.getByRole("tab", { name: /我的技术栈/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("技术栈面板内容")).toBeVisible();
    expect(screen.queryByText("AI 面板内容")).not.toBeInTheDocument();
    cleanup();
    window.localStorage.setItem("tuantuan-home-tab:tabs-account", "unknown-tab");
    renderTabs();
    expect(screen.getByRole("tab", { name: /AI 动态/ })).toHaveAttribute("aria-selected", "true");
  });

  it("scopes the persisted tab per account", () => {
    window.localStorage.setItem("tuantuan-home-tab:account-a", "stack");
    renderTabs("account-b");
    expect(screen.getByRole("tab", { name: /AI 动态/ })).toHaveAttribute("aria-selected", "true");
  });

  it("supports arrow, Home, and End keyboard navigation with focus movement", async () => {
    renderTabs();
    const aiTab = screen.getByRole("tab", { name: /AI 动态/ });
    const trendingTab = screen.getByRole("tab", { name: "技术热榜" });
    const stackTab = screen.getByRole("tab", { name: "我的技术栈" });
    aiTab.focus();
    fireEvent.keyDown(aiTab, { key: "ArrowRight" });
    await waitFor(() => expect(trendingTab).toHaveFocus());
    expect(trendingTab).toHaveAttribute("aria-selected", "true");
    expect(window.localStorage.getItem("tuantuan-home-tab:tabs-account")).toBe("trending");
    fireEvent.keyDown(trendingTab, { key: "End" });
    await waitFor(() => expect(stackTab).toHaveFocus());
    fireEvent.keyDown(stackTab, { key: "ArrowLeft" });
    await waitFor(() => expect(trendingTab).toHaveFocus());
    fireEvent.keyDown(trendingTab, { key: "Home" });
    await waitFor(() => expect(aiTab).toHaveFocus());
    fireEvent.keyDown(aiTab, { key: "ArrowLeft" });
    await waitFor(() => expect(stackTab).toHaveFocus());
    fireEvent.keyDown(stackTab, { key: "ArrowRight" });
    await waitFor(() => expect(aiTab).toHaveFocus());
  });
});
