import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsOverview, SettingsWorkspace } from "./SettingsWorkspace";
import { emptyLibraryEditor } from "../../constants";
import { isLibraryReady } from "../home/home-metrics";
import type { SettingsPage } from "../../routing";

function renderOverview(
  overrides: Partial<Parameters<typeof SettingsOverview>[0]> = {}
) {
  const onOpen = overrides.onOpen ?? vi.fn();
  render(
    <SettingsOverview
      library={{ ...emptyLibraryEditor, name: "资料库里的名字" }}
      libraryReady
      accountEmail="owner@example.com"
      onOpen={onOpen}
      {...overrides}
    />
  );
  return { onOpen };
}

describe("SettingsOverview", () => {
  afterEach(cleanup);

  it("opens the extension center", () => {
    const { onOpen } = renderOverview();
    fireEvent.click(screen.getByRole("button", { name: /扩展中心/ }));
    expect(onOpen).toHaveBeenCalledWith("extensions");
  });

  it("separates account security from the career library", () => {
    const { onOpen } = renderOverview({ accountName: "小林" });

    expect(screen.getByText("账号与安全")).toBeInTheDocument();
    expect(screen.getByText("小林")).toBeInTheDocument();
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("文件库管理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /账号与安全/ }).querySelector(".lucide-shield-check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /文件库管理/ }).querySelector(".lucide-library")).toBeInTheDocument();
    expect(screen.getByText("文件、主题集合与知识")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "了解 团团" })).toHaveAttribute("href", "#/about");

    fireEvent.click(screen.getByRole("button", { name: /账号与安全/ }));
    expect(onOpen).toHaveBeenCalledWith("account");
  });

  it("opens a dedicated global appearance page without adding sidebar children", () => {
    const { onOpen } = renderOverview();
    fireEvent.click(screen.getByRole("button", { name: /外观/ }));
    expect(onOpen).toHaveBeenCalledWith("appearance");
    expect(screen.queryByText("浅色、深色或跟随系统")).not.toBeInTheDocument();
  });

  it("includes 模型设置 and opens the existing model page", () => {
    const { onOpen } = renderOverview({
      modelName: "gpt-5.5",
      apiKeyConfigured: true
    });

    expect(screen.getByText("模型设置")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
    expect(screen.getByText("密钥已配置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /模型设置/ }));
    expect(onOpen).toHaveBeenCalledWith("model");
  });

  it("keeps unconfigured model settings reachable and labels the missing configuration", () => {
    const { onOpen } = renderOverview({ modelName: " ", apiKeyConfigured: false });
    const modelEntry = screen.getByRole("button", { name: /模型设置/ });
    expect(modelEntry).toHaveTextContent("尚未设置模型");
    expect(modelEntry).toHaveTextContent("待配置密钥");
    expect(screen.queryByText("密钥已配置")).not.toBeInTheDocument();
    fireEvent.click(modelEntry);
    expect(onOpen).toHaveBeenCalledWith("model");
  });

  it("opens file management even without a profile name or enabled material", () => {
    const { onOpen } = renderOverview({ library: emptyLibraryEditor, libraryReady: false, fileCount: 0 });
    expect(screen.queryByText("暂无文件，可随时添加")).not.toBeInTheDocument();
    expect(screen.queryByText("待完善")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /文件库管理/ }));
    expect(onOpen).toHaveBeenCalledWith("library");
  });

  it("keeps the overview free of secondary descriptions", () => {
    renderOverview({ fileCount: 3 });
    expect(screen.queryByText("共 3 个文件")).not.toBeInTheDocument();
    expect(screen.queryByText("与 AI 工作区共用同一文件库")).not.toBeInTheDocument();
    expect(screen.queryByText("昵称、头像和密码")).not.toBeInTheDocument();
    expect(screen.queryByText("对话与分析共用此模型")).not.toBeInTheDocument();
    expect(screen.queryByText("填写模型名称、服务地址和 API Key")).not.toBeInTheDocument();
    expect(screen.queryByText("所有模块统一外观，立即生效")).not.toBeInTheDocument();
  });

});

describe("SettingsWorkspace", () => {
  afterEach(cleanup);

  it("uses the shared content container for every settings page", () => {
    const pages: SettingsPage[] = ["overview", "model", "agent", "library", "account", "appearance"];
    const { container, rerender } = render(
      <SettingsWorkspace page={pages[0]} onBack={vi.fn()}>
        <div data-testid="settings-content" />
      </SettingsWorkspace>
    );

    for (const page of pages) {
      rerender(
        <SettingsWorkspace page={page} onBack={vi.fn()}>
          <div data-testid="settings-content" />
        </SettingsWorkspace>
      );

      const workspace = container.querySelector(".settings-workspace");
      expect(workspace).toHaveClass(`settings-${page}`);
      expect(screen.getByTestId("settings-content").parentElement).toBe(workspace);
    }
  });

  it("includes file management in the settings path", () => {
    const onBack = vi.fn();
    render(
      <SettingsWorkspace page="library" onBack={onBack}>
        <div />
      </SettingsWorkspace>
    );

    expect(screen.getByRole("navigation", { name: "设置路径" })).toHaveTextContent("文件库管理");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("isLibraryReady", () => {
  it("uses the saved name and enabled sources", () => {
    expect(isLibraryReady("小林", 1)).toBe(true);
    expect(isLibraryReady("小林", 0)).toBe(false);
    expect(isLibraryReady("", 1)).toBe(false);
  });
});
