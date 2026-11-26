import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskCenter } from "./TaskCenter";

const uncertain = {
  kind: "image", id: "receipt", title: "图片生成", status: "outcome_unknown",
  source: { kind: "image", id: "receipt" }, notification_key: "image:receipt:outcome_unknown",
  updated_at: "2026-09-22T08:00:00Z",
};
const running = { ...uncertain, id: "other", title: "演示文稿", status: "running", notification_key: "job:other:running" };

describe("TaskCenter", () => {
  it("uses the same read-only snapshot for tasks and deduplicated notifications", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ items: [uncertain, running], has_more: false });
    const onOpenSource = vi.fn();
    const props = { fetchJson, onOpenSource, onClose: vi.fn(), onChange: vi.fn() };
    const view = render(<TaskCenter {...props} view="tasks" />);
    const tasks = screen.getByRole("dialog", { name: "任务中心" });
    expect(await within(tasks).findByText("结果待核实", { exact: false })).toBeVisible();
    expect(within(tasks).getByText("运行中", { exact: false })).toBeVisible();
    fireEvent.click(within(tasks).getByRole("button", { name: "通知" }));
    expect(props.onChange).toHaveBeenCalledWith("notifications");
    view.rerender(<TaskCenter {...props} view="notifications" />);
    const notices = screen.getByRole("dialog", { name: "通知" });
    expect(within(notices).queryByText("演示文稿")).not.toBeInTheDocument();
    expect(within(notices).getByText(/不会自动重新提交/)).toBeVisible();
    fireEvent.click(within(notices).getByRole("button", { name: "查看来源：图片生成" }));
    expect(onOpenSource).toHaveBeenCalledWith(uncertain.source);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith("/task-center", { signal: expect.any(AbortSignal) });
  });

  it("does not display the previous session snapshot when the API client changes", async () => {
    const first = vi.fn().mockResolvedValue({ items: [uncertain, { ...uncertain, id: "duplicate" }], has_more: false });
    const next = vi.fn().mockResolvedValue({ items: [], has_more: false });
    const props = { view: "notifications" as const, onOpenSource: vi.fn(), onClose: vi.fn(), onChange: vi.fn() };
    const view = render(<TaskCenter {...props} fetchJson={first} />);
    const panel = within(screen.getByRole("dialog", { name: "通知" }));
    await panel.findByText("图片生成");
    expect(panel.getAllByRole("listitem")).toHaveLength(1);
    view.rerender(<TaskCenter {...props} fetchJson={next} />);
    expect(panel.getByRole("status")).toHaveTextContent("正在读取");
    expect(panel.queryByText("图片生成")).not.toBeInTheDocument();
    expect(await panel.findByText("当前没有任务状态通知。")).toBeVisible();
  });
});
