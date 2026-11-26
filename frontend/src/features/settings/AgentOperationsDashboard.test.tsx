import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import type { AgentOperationsSnapshot } from "../../types";
import { AgentOperationsDashboard } from "./AgentOperationsDashboard";

vi.mock("./AgentOperationsCharts", async (importOriginal) => {
  const charts = await importOriginal<typeof import("./AgentOperationsCharts")>();
  return {
    ...charts,
    RunTrendChart: ({ data, onDateChange }: Parameters<typeof charts.RunTrendChart>[0]) => (
      <button type="button" onClick={() => onDateChange(data[0].date)}>模拟图表选中日期</button>
    )
  };
});

type Run = AgentOperationsSnapshot["recent_runs"][number];
const failedRun: Run = {
  id: "run-42", message_id: 42, conversation_id: 73, conversation_available: true,
  conversation_title: "需要排查的对话", task_id: null, status: "failed", stop_reason: "timeout", provider: "local",
  platform: "manual", route: "conversation", goal: "生成摘要", rounds: 2, tool_call_count: 1,
  tools: ["公开搜索"], error_code: "timeout", error_message: "模型请求超时", created_at: "2026-11-25 14:48:00"
};
const cancelledRun: Run = {
  ...failedRun, id: "run-43", message_id: 43, conversation_available: false,
  conversation_title: "已删除的会话", status: "cancelled", error_message: "", error_code: ""
};

function snapshot(recent_runs: Run[], matching_runs = recent_runs.length): AgentOperationsSnapshot {
  return {
    window_days: 7, generated_at: "2026-11-26T01:30:00+00:00", freshness_at: failedRun.created_at,
    summary: {
      total_runs: 30, successful_runs: 7, failed_runs: 21, waiting_runs: 1, cancelled_runs: 1,
      success_rate: 23.3, total_tool_calls: 5, average_rounds: 1.2, model_requests: 12,
      model_success_rate: 75, model_p95_latency_ms: 4000, total_tokens: 910
    },
    status_breakdown: [{ status: "done", count: 7 }, { status: "failed", count: 21 }, { status: "waiting_user", count: 1 }, { status: "cancelled", count: 1 }],
    trend: [{ date: "2026-11-25", label: "11/25", total: 23, done: 0, failed: 21, waiting_user: 1, cancelled: 1 }],
    tool_breakdown: [], route_breakdown: [], recent_runs, matching_runs,
    coverage: { run_source: "messages", model_source: "events", precise_run_latency: false, tokens_attributed_to_run: false }
  };
}

function setup(load: (path: string, options?: RequestInit) => Promise<AgentOperationsSnapshot>, onOpenConversation = vi.fn(async () => true)) {
  const request = vi.fn(load);
  const ui = render(<AgentOperationsDashboard fetchJson={request as unknown as ReturnType<typeof createApiClient>} onOpenConversation={onOpenConversation} theme="light" />);
  return { request, onOpenConversation, ...ui };
}

const statusButton = (name: RegExp) => within(screen.getByRole("group", { name: "按运行状态筛选" })).getByRole("button", { name });
const dateSelect = () => screen.getByRole("combobox", { name: "按日期筛选" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("Agent operations drilldown", () => {
  afterEach(cleanup);

  it("combines status and date, pages over all matches, and keeps the overview unchanged", async () => {
    const { request } = setup(async (path) => path.includes("offset=") ? snapshot([failedRun], 21) : snapshot([], path.includes("run_status") ? 21 : 30));

    await screen.findByText("30 条");
    expect(screen.getByText("Agent 完成率")).toBeInTheDocument();
    expect(screen.getByText("模型请求成功率 75%")).toBeInTheDocument();
    fireEvent.click(statusButton(/失败 21/));
    await screen.findByText("21 条");
    fireEvent.click(screen.getByRole("button", { name: "模拟图表选中日期" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith("/agent/operations?days=7&limit=20&run_status=failed&run_date=2026-11-25", expect.anything()));
    expect(dateSelect()).toHaveValue("2026-11-25");
    expect(statusButton(/失败 21/)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("需要排查的对话")).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith("/agent/operations?days=7&limit=20&run_status=failed&run_date=2026-11-25&offset=20", expect.anything());
    expect(screen.getByText("第 21–21 条，共 21 条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "30 天" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith("/agent/operations?days=30&limit=20&run_status=failed", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith("/agent/operations?days=30&limit=20", expect.anything()));
  });

  it("ignores a superseded response even when the client resolves after being aborted", async () => {
    const old = deferred<AgentOperationsSnapshot>();
    const sameDay = deferred<AgentOperationsSnapshot>();
    const { request } = setup(async (path) => path.includes("run_date") ? sameDay.promise : path.includes("failed") ? old.promise : snapshot([]));
    await screen.findByText("0 条");
    fireEvent.click(statusButton(/失败 21/));
    const staleSignal = request.mock.lastCall?.[1]?.signal;
    fireEvent.change(dateSelect(), { target: { value: "2026-11-25" } });
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => sameDay.resolve(snapshot([])));
    expect(screen.getByText("没有符合当前筛选条件的运行记录。")).toBeInTheDocument();
    await act(async () => old.resolve(snapshot([failedRun])));
    expect(screen.queryByText("需要排查的对话")).not.toBeInTheDocument();
  });

  it("offers retry on request failure and does not confuse it with an empty result", async () => {
    let attempt = 0;
    setup(async () => {
      if (attempt++ === 0) throw new Error("offline");
      return snapshot([]);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 Agent 运行记录");
    expect(screen.queryByText(/还没有 Agent/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/还没有 Agent/)).toBeInTheDocument();
  });

  it("opens the exact conversation when available and explains when a conversation is missing", async () => {
    const open = vi.fn(async () => false);
    setup(async () => snapshot([failedRun, cancelledRun]), open);
    fireEvent.click(await screen.findByText(failedRun.conversation_title));
    expect(screen.getByText(/模型请求超时/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开原对话" }));
    expect(open).toHaveBeenCalledWith(73, expect.any(AbortSignal));
    expect(await screen.findByRole("alert")).toHaveTextContent("原对话已不可用");
    const deleted = screen.getByText(cancelledRun.conversation_title).closest("details")!;
    fireEvent.click(screen.getByText(cancelledRun.conversation_title));
    expect(within(deleted).getByText("原对话已不可用。")).toBeInTheDocument();
    expect(within(deleted).queryByRole("button", { name: "打开原对话" })).toBeNull();
  });
});
