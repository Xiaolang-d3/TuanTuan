import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceShortcuts } from "./WorkspaceShortcuts";

afterEach(cleanup);

function project(id: string, name: string, status = "active") {
  return { id, name, description: "", status, updated_at: "2026-08-11T00:00:00Z" };
}

function renderShortcuts(fetchJson: ReturnType<typeof vi.fn>, projectsRevision: number) {
  return (
    <WorkspaceShortcuts
      fetchJson={fetchJson as never}
      projectsRevision={projectsRevision}
      projectsOpen
      recordsOpen={false}
      projectsActive={false}
      onProject={vi.fn()}
      onRecord={vi.fn()}
      onOpenChange={vi.fn()}
      onViewProjects={vi.fn()}
      onViewRecords={vi.fn()}
    />
  );
}

describe("WorkspaceShortcuts project writes", () => {
  it("hides stale project rows right away and reloads after a confirmed write", async () => {
    let resolveSecond: (value: unknown) => void = () => undefined;
    const fetchJson = vi.fn()
      .mockResolvedValueOnce({ items: [project("a", "旧名称")] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    const view = render(renderShortcuts(fetchJson, 0));
    expect(await screen.findByRole("button", { name: "旧名称" })).toBeInTheDocument();

    view.rerender(renderShortcuts(fetchJson, 1));
    // The reload is still pending: the old row must not stay clickable.
    await waitFor(() => expect(screen.queryByRole("button", { name: "旧名称" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("正在读取");

    resolveSecond({ items: [project("a", "新名称")] });
    expect(await screen.findByRole("button", { name: "新名称" })).toBeInTheDocument();
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("does not list an archived project after the reload", async () => {
    const fetchJson = vi.fn()
      .mockResolvedValueOnce({ items: [project("a", "进行中项目")] })
      .mockResolvedValueOnce({ items: [project("a", "进行中项目", "archived")] });
    const view = render(renderShortcuts(fetchJson, 0));
    expect(await screen.findByRole("button", { name: "进行中项目" })).toBeInTheDocument();
    view.rerender(renderShortcuts(fetchJson, 1));
    expect(await screen.findByText("暂无进行中的项目。")).toBeInTheDocument();
  });
});
