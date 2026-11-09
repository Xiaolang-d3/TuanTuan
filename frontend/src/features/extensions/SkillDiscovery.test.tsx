import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SkillDiscovery } from "./SkillDiscovery";

afterEach(cleanup);

function setup(overrides = {}) {
  const service = {
    searchSkills: vi.fn().mockResolvedValue({ skills: [{ name: "weekly-report", source: "acme/reports", installs: 42, installed: false }] }),
    previewSkills: vi.fn().mockResolvedValue({ preview_id: "preview-1", repository: "acme/reports", commit: "a".repeat(40), expires_at: 1e12, skipped: 0,
      skills: [{ path: "skills/report", name: "weekly-report", description: "整理工作", content: "真实技能正文", files: ["references/format.md"] }] }),
    installSkill: vi.fn().mockResolvedValue({ id: "installed-1", name: "weekly-report", enabled: false }),
    ...overrides,
  };
  render(<SkillDiscovery service={service} onInstalled={vi.fn()} />);
  return service;
}

it("searches online, previews real content and installs only the selected snapshot", async () => {
  const service = setup();
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByText("weekly-report")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览 weekly-report" }));
  expect(await screen.findByText("真实技能正文")).toBeInTheDocument();
  expect(service.previewSkills).toHaveBeenCalledWith("acme/reports", undefined, "weekly-report", expect.any(AbortSignal));
  expect(screen.getByText("references/format.md")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "安装技能" }));
  await waitFor(() => expect(service.installSkill).toHaveBeenCalledWith("preview-1", "skills/report"));
  expect(await screen.findByText(/安装完成，当前为停用状态/)).toBeInTheDocument();
});

it("distinguishes failure from no results and permits retry", async () => {
  const searchSkills = vi.fn().mockRejectedValueOnce(new Error("服务暂时不可用")).mockResolvedValue({ skills: [] });
  setup({ searchSkills });
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
  expect(screen.queryByText("没有找到匹配的在线技能")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByText("没有找到匹配的在线技能")).toBeInTheDocument();
});

it("offers repository discovery and marks installed online results", async () => {
  const service = setup({ searchSkills: vi.fn().mockResolvedValue({ skills: [{ name: "weekly-report", source: "acme/reports", installs: 42, installed: true }] }) });
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByRole("button", { name: "已安装 weekly-report" })).toBeDisabled();
  fireEvent.click(screen.getByText("从 GitHub 仓库查找"));
  fireEvent.change(screen.getByLabelText("GitHub 仓库"), { target: { value: "acme/reports" } });
  fireEvent.click(screen.getByRole("button", { name: "查找仓库技能" }));
  await waitFor(() => expect(service.previewSkills).toHaveBeenCalledWith("acme/reports", undefined, undefined, expect.any(AbortSignal)));
});

it("ignores late search responses after a newer query", async () => {
  let finish: (value: unknown) => void = () => undefined;
  const searchSkills = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ skills: [] });
  setup({ searchSkills });
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(await screen.findByText("没有找到匹配的在线技能")).toBeInTheDocument();
  finish({ skills: [{ name: "stale", source: "a/b", installs: 1, installed: false }] });
  await waitFor(() => expect(screen.queryByText("stale")).not.toBeInTheDocument());
});

it("discards a pending preview when the user changes the search query", async () => {
  let finish: (value: unknown) => void = () => undefined;
  const previewSkills = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  setup({ previewSkills });
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览 weekly-report" }));
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "react" } });
  expect(previewSkills.mock.calls[0][3].aborted).toBe(true);
  finish({ preview_id: "stale", repository: "acme/reports", commit: "a".repeat(40), skills: [{ path: "old", name: "old", content: "旧预览", files: [] }] });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("starts a suggested search and progressively reveals longer result lists", async () => {
  const skills = Array.from({ length: 25 }, (_, index) => ({ name: `skill-${index}`, source: "acme/skills", installs: index, installed: false }));
  const service = setup({ searchSkills: vi.fn().mockResolvedValue({ skills }) });
  fireEvent.click(screen.getByRole("button", { name: "前端开发" }));
  await waitFor(() => expect(service.searchSkills).toHaveBeenCalledWith("react", expect.any(AbortSignal)));
  expect(await screen.findByText("skill-11")).toBeInTheDocument();
  expect(screen.queryByText("skill-12")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
  expect(screen.getByText("skill-23")).toBeInTheDocument();
  expect(screen.getByLabelText("搜索在线技能")).toHaveValue("react");
});

it("offers a direct route to manage the skill after installation", async () => {
  const onManageInstalled = vi.fn();
  const service = {
    searchSkills: vi.fn().mockResolvedValue({ skills: [{ name: "report", source: "acme/skills", installs: 1, installed: false }] }),
    previewSkills: vi.fn().mockResolvedValue({ preview_id: "p", repository: "acme/skills", commit: "a".repeat(40), skills: [{ name: "report", path: "report", content: "正文", files: [] }] }),
    installSkill: vi.fn().mockResolvedValue({ id: "new-skill", enabled: false }),
  };
  render(<SkillDiscovery service={service} onInstalled={vi.fn()} onManageInstalled={onManageInstalled} />);
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览 report" }));
  fireEvent.click(await screen.findByRole("button", { name: "安装技能" }));
  fireEvent.click(await screen.findByRole("button", { name: "去启用" }));
  expect(onManageInstalled).toHaveBeenCalledWith("new-skill");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("renders readable instructions and lets the user inspect the original metadata", async () => {
  setup({ previewSkills: vi.fn().mockResolvedValue({ preview_id: "p", repository: "acme/reports", commit: "a".repeat(40), skipped: 0,
    skills: [{ path: "report", name: "weekly-report", description: "整理工作", content: "---\nname: weekly-report\n---\n# 整理周报\n\n先收集材料。", files: [] }] }) });
  fireEvent.change(screen.getByLabelText("搜索在线技能"), { target: { value: "report" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览 weekly-report" }));
  expect(await screen.findByRole("heading", { name: "整理周报" })).toBeInTheDocument();
  expect(screen.queryByText(/name: weekly-report/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  expect(screen.getByText(/name: weekly-report/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "阅读" }));
  expect(screen.getByRole("heading", { name: "整理周报" })).toBeInTheDocument();
});
