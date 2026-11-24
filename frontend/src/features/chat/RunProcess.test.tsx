import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerClarification, RunProcess } from "./MessagePresentation";
import { ImageGenerationProgress } from "./ImageGenerationProgress";
import type { AgentRunResult } from "./types";

type RunEvent = AgentRunResult["events"][number];

function event(toolCallId: string, message: string, options: Partial<RunEvent> = {}): RunEvent {
  return { round: 1, tool_call_id: toolCallId, tool_name: "agent_thinking", status: "done", message, ...options };
}

function run(options: Partial<AgentRunResult> = {}): AgentRunResult {
  return { provider: "test", platform: "local", rounds: 1, status: "done", events: [], ...options };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ComposerClarification", () => {
  it("submits only a nonblank confirmed reply and resets choices for a different question", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    const question = { question: "哪一份？", options: [{ id: "a", label: "甲", send: "选择甲" }], allowCustom: true };
    const view = render(<ComposerClarification clarification={question} busy={false} onChoose={onChoose} onCancel={onCancel} />);
    const proceed = screen.getByRole("button", { name: "继续" });
    fireEvent.click(screen.getByRole("radio", { name: "自定义回复" }));
    const input = screen.getByRole("textbox", { name: "填写自定义回复" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(proceed).toBeDisabled();
    fireEvent.change(input, { target: { value: "  选第三份  " } });
    fireEvent.click(proceed);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("选第三份");
    fireEvent.click(screen.getByRole("button", { name: "结束任务" }));
    expect(onCancel).toHaveBeenCalledOnce();
    view.rerender(<ComposerClarification clarification={{ ...question, question: "换一个问题", allowCustom: false }} busy={false} onChoose={onChoose} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
    expect(screen.queryByRole("radio", { name: "自定义回复" })).not.toBeInTheDocument();
  });
});

describe("RunProcess", () => {
  it("renders only the actual plan as task rows and does not imply work is running after stop", () => {
    const steps: NonNullable<AgentRunResult["plan"]>["steps"] = [
      { id: "read", title: "读资料", tool_name: "search_library", risk: "read_only", status: "done" },
      { id: "check", title: "核对内容", tool_name: "citation_validator", risk: "read_only", status: "running" },
      { id: "write", title: "整理提纲", tool_name: "agent_tool", risk: "read_only", status: "blocked" }
    ];
    const agent = run({ plan: { goal: "阅读", route: "general", requires_confirmation: false, steps } });
    const view = render(<RunProcess streaming agent={agent} />);
    const tasks = screen.getByRole("region", { name: "任务步骤" });
    expect(tasks).toHaveTextContent("已完成 1/3");
    const rows = within(tasks).getAllByRole("listitem");
    expect(rows[1]).toHaveAttribute("aria-current", "step");
    expect(rows[2]).toHaveTextContent("受阻");
    view.rerender(<RunProcess streaming stopping agent={agent} />);
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveTextContent("未完成");
  });

  it("animates a decorative status and updates only a real elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T09:00:00Z"));
    const view = render(<RunProcess streaming agent={run({ started_at: "2026-11-24T09:00:00Z" })} />);
    expect(view.container.querySelector(".run-loading-indicator")).toHaveAttribute("aria-hidden", "true");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("已用时 2s")).toBeVisible();
    expect(screen.getByRole("status")).not.toHaveTextContent("已用时");
    view.rerender(<RunProcess streaming={false} />);
    expect(view.container).toBeEmptyDOMElement();
  });
  it("shows live internal phases immediately without adding empty execution nodes", () => {
    const classify = event("model-stage-classify", "正在理解你的请求", { tool_name: "agent_run_state", status: "running", data: { stage: "classify" } });
    const view = render(<RunProcess streaming agent={run({ events: [classify] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在理解你的请求");
    expect(screen.queryByRole("region", { name: "执行记录，可滚动查看" })).not.toBeInTheDocument();
    const plan = event("model-stage-plan", "正在规划步骤", { tool_name: "agent_run_state", status: "running", data: { stage: "plan" } });
    view.rerender(<RunProcess streaming agent={run({ events: [classify, { ...classify, status: "done" }, plan] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在规划步骤");
    expect(screen.queryByText("正在理解你的请求")).not.toBeInTheDocument();
    view.rerender(<RunProcess streaming agent={run({ events: [classify, { ...classify, status: "done" }, plan, { ...plan, status: "done" }] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在等待模型响应");
  });

  it("shows one truthful status without an empty disclosure while waiting for the model", () => {
    render(<RunProcess streaming />);
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    expect(within(process).queryByRole("button")).not.toBeInTheDocument();
    expect(within(process).getByRole("status")).toHaveTextContent("正在等待模型响应");
    expect(screen.queryByText("等待模型响应…")).not.toBeInTheDocument();
    expect(process).not.toHaveTextContent("已用时");
  });

  it("stops describing a finished tool as running and switches to streamed output", () => {
    const read = event("read", "正在读取知识库", { tool_name: "get_library_context", status: "running" });
    const view = render(<RunProcess streaming agent={run({ events: [read] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取知识库");
    const agent = run({ events: [read, { ...read, status: "done", message: "已读取知识库" }] });
    view.rerender(<RunProcess streaming agent={agent} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在等待模型响应");
    expect(screen.getByText("已读取知识库")).toBeVisible();
    view.rerender(<RunProcess streaming agent={agent} content="这是回答" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在生成回复");
  });

  it("shows the current activity in the header and its expandable record", () => {
    const agent = run({ events: [event("search", "正在检索公开资料", { tool_name: "search_public_web", status: "running" })] });
    render(<RunProcess streaming agent={agent} />);
    expect(screen.getAllByText("正在检索公开资料")).toHaveLength(2);
  });

  it("shows the specific tool task in the current execution header", () => {
    const agent = run({ events: [event("search", "正在检索：Python 异步任务", { tool_name: "search_public_web", status: "running" })] });
    render(<RunProcess streaming agent={agent} />);
    expect(screen.getAllByText("正在检索：Python 异步任务")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "收起思考与执行过程" })).toHaveTextContent("Python 异步任务");
  });

  it("shows only the accessible dot animation during image generation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:08Z"));
    const image = event("image", "正在生成图片", { tool_name: "image_generation", status: "running" });
    const view = render(<><RunProcess streaming agent={run({ started_at: "2026-10-17T12:00:00Z", events: [image] })} /><ImageGenerationProgress /></>);
    expect(screen.getByRole("status", { name: "正在生成图片" })).toHaveTextContent("");
    expect(view.container.querySelector(".image-generation-dots")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("正在生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("已用时 8s")).not.toBeInTheDocument();
    expect(view.container.querySelector(".spinning")).toBeNull();
    expect(screen.queryByRole("button", { name: /思考与执行过程/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "执行记录，可滚动查看" })).not.toBeInTheDocument();
  });

  it("updates image progress in place and keeps the completed operation inspectable", () => {
    const image = event("image", "正在生成图片", { tool_name: "image_generation", status: "running" });
    const view = render(<RunProcess streaming agent={run({ events: [image] })} />);
    view.rerender(<RunProcess streaming agent={run({ events: [image, { ...image, message: "正在保存图片" }] })} />);
    expect(screen.queryByText("正在生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("正在保存图片")).not.toBeInTheDocument();
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<RunProcess streaming={false} agent={run({ duration_ms: 8200, events: [{ ...image, status: "done", message: "已生成 1 张图片" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("已生成 1 张图片")).toBeVisible();
    expect(view.container.querySelector(".image-generation-progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "展开已生成 1 张图片的执行说明" })).not.toBeInTheDocument();
    expect(screen.queryByText("未记录")).not.toBeInTheDocument();
  });

  it("keeps earlier reasoning and image failures while removing only the live duplicate", () => {
    const thought = event("thought", "按用户描述安排构图。");
    const image = event("image", "正在生成图片", { tool_name: "image_generation", status: "running" });
    const view = render(<RunProcess streaming agent={run({ events: [thought, image] })} />);
    expect(screen.queryByText(thought.message)).not.toBeInTheDocument();
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<RunProcess streaming={false} agent={run({ status: "failed", events: [thought, { ...image, status: "failed", message: "生图服务超时" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    fireEvent.click(screen.getByRole("button", { name: "展开生图服务超时的执行说明" }));
    expect(screen.getByText("原因：生图服务超时")).toBeVisible();
  });

  it("removes image animation as soon as stopping is requested and keeps the cancelled outcome", () => {
    const image = event("image", "正在生成图片", { tool_name: "image_generation", status: "running" });
    const agent = run({ events: [image] });
    const view = render(<RunProcess streaming agent={agent} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<RunProcess streaming stopping agent={agent} />);
    expect(view.container.querySelector(".image-generation-dots")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("正在停止生成");
    view.rerender(<RunProcess streaming={false} agent={{ ...agent, status: "cancelled", duration_ms: 3000 }} />);
    expect(screen.getByText("已停止")).toBeVisible();
    expect(view.container.querySelector(".image-generation-dots")).toBeNull();
  });

  it("shows action nodes without exposing raw provider reasoning or routing text", () => {
    const raw = `Internal reasoning. ${"Private deliberation. ".repeat(40)}`;
    const view = render(<RunProcess streaming agent={run({ events: [
      event("route", "已识别为资料研究，需要先规划并限制可用工具"),
      event("thought-1", raw, { data: { source: "model_reasoning" } }),
      event("read", "已读取项目资料", { tool_name: "get_library_context" }),
      event("thought-2", "Now decide what to answer.")
    ] })} />);
    expect(screen.getByText("已读取项目资料")).toBeVisible();
    expect(view.container.querySelector(".run-process-thought")).toBeNull();
    expect(view.container.textContent).not.toMatch(/Internal reasoning|Private deliberation|Now decide|已识别为/);
  });

  it("uses only a thinking status when no action has started", () => {
    render(<RunProcess streaming agent={run({ events: [event("thought", "Unfiltered deliberation", { status: "running" })] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在思考");
    expect(screen.queryByText("Unfiltered deliberation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /思考与执行过程/ })).not.toBeInTheDocument();
  });

  it("updates a repeated call in its original position and preserves distinct calls with the same text", () => {
    const agent = run({ events: [
      event("search-1", "正在搜索资料", { tool_name: "search_public_web", status: "running" }),
      event("thought", "现在核对来源的可信度。"),
      event("search-1", "已读取公开资料", { tool_name: "search_public_web", status: "done" }),
      event("read-1", "已读取项目资料", { tool_name: "get_library_context" }),
      event("read-2", "已读取项目资料", { tool_name: "get_library_context" })
    ] });
    render(<RunProcess agent={agent} streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    const completed = screen.getByText("已读取公开资料");
    const firstRead = screen.getAllByText("已读取项目资料")[0];
    expect(screen.queryByText("正在搜索资料")).not.toBeInTheDocument();
    expect(completed.compareDocumentPosition(firstRead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("现在核对来源的可信度。")).not.toBeInTheDocument();
    expect(screen.getAllByText("已读取项目资料")).toHaveLength(2);
  });

  it("summarizes only distinct visible execution records and keeps their details expandable", () => {
    const search = event("search", "正在搜索资料", { tool_name: "search_public_web", status: "running" });
    render(<RunProcess streaming={false} agent={run({ duration_ms: 3200, events: [
      search,
      event("internal", "隐藏的内部阶段", { tool_name: "agent_run_state" }),
      { ...search, status: "failed", message: "搜索超时" },
      event("read", "已读取知识库", { tool_name: "get_library_context" }),
      event("write", "写入被阻止", { tool_name: "agent_tool", status: "blocked" })
    ] })} />);
    const toggle = screen.getByRole("button", { name: "展开思考与执行过程" });
    expect(toggle).toHaveTextContent("用时 3.2s");
    expect(toggle).toHaveAccessibleDescription("3 条执行记录 · 1 条失败 · 1 条受阻");
    expect(screen.queryByRole("region", { name: "执行记录，可滚动查看" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const log = screen.getByRole("region", { name: "执行记录，可滚动查看" });
    expect(within(log).getByText("已读取知识库")).toBeVisible();
    fireEvent.click(within(log).getByRole("button", { name: "展开搜索超时的执行说明" }));
    expect(within(log).getByText("原因：搜索超时")).toBeVisible();
  });

  it("keeps the user's collapsed choice while live events update", () => {
    const agent = run({ events: [event("read", "已读取资料", { tool_name: "get_library_context" })] });
    const view = render(<RunProcess agent={agent} streaming />);
    fireEvent.click(screen.getByRole("button", { name: "收起思考与执行过程" }));
    view.rerender(<RunProcess agent={{ ...agent, events: [event("read", "已读取两份资料", { tool_name: "get_library_context" })] }} streaming />);
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("已读取两份资料")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("已读取两份资料")).toBeVisible();
  });

  it("collapses when the run ends, freezes its duration and keeps its process available", () => {
    const agent = run({ events: [event("read", "已读取资料", { tool_name: "get_library_context" })] });
    const view = render(<RunProcess agent={agent} streaming />);
    view.rerender(<RunProcess agent={{ ...agent, duration_ms: 389_000 }} streaming={false} />);
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("用时 389s");
    expect(screen.getByText("已读取资料")).not.toBeVisible();
    expect(process.querySelector(".spinning")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("已读取资料")).toBeVisible();
  });

  it.each([
    ["failed", "生成失败"],
    ["cancelled", "已停止"],
    ["waiting_user", "等待确认"]
  ] as const)("shows %s as a single terminal outcome without a spinner", (status, label) => {
    const agent = run({ status, duration_ms: 8_000, events: [event("search", "正在检索资料", { tool_name: "search_library", status: "running" })] });
    const view = render(<RunProcess agent={agent} streaming={false} />);
    const toggle = screen.getByRole("button", { name: "展开思考与执行过程" });
    expect(toggle).toHaveTextContent("用时 8s");
    expect(within(toggle).getAllByText(label)).toHaveLength(1);
    expect(view.container.querySelector(".spinning")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("检索资料")).toBeVisible();
  });

  it("does not report a completed answer as failed because one tool failed", () => {
    const agent = run({ duration_ms: 12_000, events: [event("search", "本次检索没有结果，已改用已有资料。", { tool_name: "search_library", status: "failed" })] });
    render(<RunProcess agent={agent} streaming={false} />);
    expect(screen.queryByText("生成失败")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("本次检索没有结果，已改用已有资料。")).toBeVisible();
    expect(screen.queryByText("生成失败")).not.toBeInTheDocument();
  });

  it("does not invent elapsed time for historical messages without run timing", () => {
    const agent = run({ events: [event("read", "已读取资料", { tool_name: "get_library_context" })] });
    render(<RunProcess agent={agent} streaming={false} />);
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("思考与执行过程");
    expect(screen.queryByText(/用时/)).not.toBeInTheDocument();
  });

  it("uses persisted duration for a historical run rather than time since opening it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T03:00:00Z"));
    render(<RunProcess agent={run({ duration_ms: 61_500 })} streaming={false} />);
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("用时 61.5s");
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("用时 61.5s");
  });

  it("uses the run's start time without resetting elapsed time when the activity changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T03:00:11Z"));
    const agent = run({ started_at: "2026-10-11T03:00:00Z", events: [event("search", "正在查阅公开资料", { tool_name: "search_public_web", status: "running" })] });
    const view = render(<RunProcess agent={agent} streaming />);
    expect(screen.getByText("已用时 11s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4_000));
    view.rerender(<RunProcess agent={{ ...agent, events: [event("search", "已完成查阅", { tool_name: "search_public_web" })] }} streaming content="回答正在生成" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在生成回复");
    expect(screen.getByText("已用时 15s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("已用时 17s")).toBeInTheDocument();
  });

  it("shows the stop request in the same process header", () => {
    const view = render(<RunProcess streaming stopping />);
    const process = screen.getByRole("region", { name: "思考与执行过程" });
    expect(within(process).getByRole("status")).toHaveTextContent("正在停止生成");
    expect(screen.getAllByText("正在停止生成")).toHaveLength(1);
    view.rerender(<RunProcess agent={run({ status: "cancelled", duration_ms: 3_000 })} streaming={false} />);
    expect(process.querySelector(".spinning")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("已停止");
  });
});


describe("execution record interaction", () => {
  it("collapses the previous node when another one is selected", () => {
    render(<RunProcess streaming agent={run({ events: [
      event("a", "已检索甲", { tool_name: "search_public_web", data: { query: "甲", sources: [] } }),
      event("b", "已检索乙", { tool_name: "search_public_web", data: { query: "乙", sources: [] } })
    ] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开已检索甲的执行说明" }));
    expect(screen.getByText("检索：甲")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开已检索乙的执行说明" }));
    expect(screen.queryByText("检索：甲")).not.toBeInTheDocument();
    expect(screen.getByText("检索：乙")).toBeVisible();
  });

  it("merges historical citation repair rounds into one node and identifies the failing stage", () => {
    const reason = "来源引用修正未返回有效补丁，已保留原始草稿";
    render(<RunProcess streaming={false} content="保留的草稿" agent={run({ status: "failed", duration_ms: 182200,
      error: { code: "citation_validation_failed", message: reason, retryable: false }, events: [
        event("citation-2", "回答没有使用 Markdown 链接引用本轮搜索来源，正在自动修正", { tool_name: "citation_validator", status: "running" }),
        event("citation-3", reason, { tool_name: "citation_validator", status: "failed", data: { original_draft_preserved: true } })
      ] })} />);
    expect(screen.queryByText("生成失败")).not.toBeInTheDocument();
    expect(screen.getByText("引用校验未通过")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getAllByText("核对引用未通过")).toHaveLength(1);
    expect(screen.queryByText(/检查：/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开核对引用未通过的执行说明" }));
    expect(screen.getByText("检查：回答未附本轮来源链接")).toBeVisible();
    expect(screen.getByText(`原因：${reason}`)).toBeVisible();
    expect(screen.getByText("处理：原始草稿已保留，来源引用尚未核验。")).toBeVisible();
  });

  it("does not repeat the draft warning already present in the answer", () => {
    render(<RunProcess streaming={false} content="草稿\n\n> 来源引用校验未完成，已保留原始草稿。" agent={run({ status: "failed",
      error: { code: "citation_validation_failed", message: "引用修正失败", retryable: false } })} />);
    expect(screen.getByText("引用校验未通过")).toBeVisible();
    expect(screen.queryByText(/展开执行节点可查看原因/)).not.toBeInTheDocument();
  });

  it("never renders a paused-follow hint or jump button in the execution record", () => {
    const view = render(<RunProcess streaming agent={run({ events: [event("read", "已读取资料", { tool_name: "get_library_context", data: { sources: [] } })] })} />);
    expect(screen.getByRole("region", { name: "执行记录，可滚动查看" })).toBeVisible();
    expect(view.container.querySelector(".run-process-followbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起思考与执行过程" }));
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(view.container.querySelector(".run-process-followbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开已读取资料的执行说明" }));
    expect(view.container.querySelector(".run-process-followbar")).toBeNull();
    expect(screen.queryByText("已暂停跟随")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /回到最新/ })).not.toBeInTheDocument();
  });

  it("preserves reading position and resumes following after scrolling back to the latest", () => {
    const a = event("a", "已读取资料", { tool_name: "get_library_context", data: { sources: [] } });
    const view = render(<RunProcess streaming agent={run({ events: [a] })} />);
    const records = screen.getByRole("region", { name: "执行记录，可滚动查看" });
    let height = 600;
    Object.defineProperties(records, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } });
    const b = event("b", "正在检索 A", { tool_name: "search_public_web", status: "running", data: { arguments: { query: "A" } } });
    view.rerender(<RunProcess streaming agent={run({ events: [a, b] })} />);
    expect(records.scrollTop).toBe(600);
    records.scrollTop = 90;
    fireEvent.scroll(records);
    const c = event("c", "已核对引用", { tool_name: "citation_validator" });
    height = 800;
    view.rerender(<RunProcess streaming agent={run({ events: [a, b, c] })} />);
    expect(records.scrollTop).toBe(90);
    view.rerender(<RunProcess streaming agent={run({ events: [a, { ...b, status: "done" }, c] })} />);
    expect(records.scrollTop).toBe(90);
    records.scrollTop = 800;
    fireEvent.scroll(records);
    fireEvent.click(screen.getByRole("button", { name: "展开已读取资料的执行说明" }));
    height = 900;
    const d = event("d", "正在生成回答", { tool_name: "model_provider", status: "running" });
    view.rerender(<RunProcess streaming agent={run({ events: [a, b, c, d] })} />);
    expect(records.scrollTop).toBe(800);
    expect(screen.getByRole("button", { name: "收起已读取资料的执行说明" })).toHaveAttribute("aria-expanded", "true");
    records.scrollTop = 700;
    fireEvent.scroll(records);
    expect(view.container.querySelector(".run-process-followbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起思考与执行过程" }));
    view.rerender(<RunProcess streaming agent={run({ events: [a, b, c, { ...d, message: "正在生成最终回答" }] })} />);
    expect(screen.getByRole("button", { name: "展开思考与执行过程" })).toHaveTextContent("正在生成最终回答");
    expect(records).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(records.scrollTop).toBe(900);
  });

  it("opens only the selected call and updates its result without exposing raw payloads", () => {
    const a = event("a", "正在检索甲", { tool_name: "search_public_web", status: "running", data: { arguments: { query: "甲", api_key: "secret-key" }, debug: "private-debug" } });
    const b = event("b", "已检索乙", { tool_name: "search_public_web", data: { query: "乙", sources: [{ title: "乙来源", url: "https://example.com/b", content: "private-body" }] } });
    const view = render(<RunProcess streaming agent={run({ events: [a, b] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开正在检索甲的执行说明" }));
    expect(screen.getByText("检索：甲")).toBeVisible();
    expect(screen.queryByText("正在等待返回结果。")).not.toBeInTheDocument();
    expect(screen.queryByText("检索：乙")).not.toBeInTheDocument();
    const done = { ...a, status: "done", message: "已检索甲", data: { sources: [{ title: "甲来源", url: "https://example.com/a" }] } };
    view.rerender(<RunProcess streaming agent={run({ events: [a, done, b] })} />);
    expect(screen.getByRole("button", { name: "收起已检索甲的执行说明" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("检索：甲")).toBeVisible();
    expect(screen.getByText("找到 1 条公开来源：甲来源")).toBeVisible();
    expect(view.container.textContent).not.toMatch(/secret-key|private-debug|private-body|https:\/\/example|api_key/);
    expect(screen.queryByText("详情")).not.toBeInTheDocument();
  });

  it("ticks from the real node start, freezes recorded seconds and removes the loading indicator at completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00.800Z"));
    const a = event("a", "正在读取资料", { tool_name: "get_library_context", status: "running", started_at: "2026-10-15T00:00:00Z" });
    const view = render(<RunProcess streaming agent={run({ events: [a] })} />);
    expect(screen.getByText("已用 0.8s")).toBeVisible();
    expect(view.container.querySelectorAll(".run-loading-indicator")).toHaveLength(1);
    expect(view.container.querySelectorAll(".is-current-execution")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("已用 2.8s")).toBeVisible();
    view.rerender(<RunProcess streaming={false} agent={run({ duration_ms: 2800, events: [{ ...a, status: "done", message: "已读取资料", duration_ms: 2800 }] })} />);
    expect(view.container.querySelector(".is-current-execution")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("2.8s")).toBeVisible();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("2.8s")).toBeVisible();
  });

  it("keeps failed tools inspectable when the answer already contains their error", () => {
    const error = "检索服务连接超时";
    render(<RunProcess streaming={false} content={error} agent={run({ status: "failed", error: { code: "timeout", message: error, retryable: true }, events: [event("a", error, { tool_name: "search_public_web", status: "failed", duration_ms: 4200 })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考与执行过程" }));
    expect(screen.getByText("4.2s")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "展开检索公开资料失败的执行说明" }));
    expect(screen.getByText(`原因：${error}`)).toBeVisible();
  });

  it("shows the selected call's failure reason and missing history without borrowing the run error", () => {
    const a = event("a", "搜索连接超时", { tool_name: "search_public_web", status: "failed" });
    const b = event("b", "已读取资料", { tool_name: "get_library_context" });
    render(<RunProcess streaming agent={run({ error: { code: "other", message: "另一处错误", retryable: false }, events: [a, b] })} />);
    fireEvent.click(screen.getByRole("button", { name: "展开搜索连接超时的执行说明" }));
    expect(screen.getByText("原因：搜索连接超时")).toBeVisible();
    expect(screen.queryByRole("button", { name: "展开已读取资料的执行说明" })).not.toBeInTheDocument();
    expect(screen.getByText("已读取资料")).toBeVisible();
    expect(screen.queryByText("这次调用未保留更多说明。")).not.toBeInTheDocument();
    expect(screen.queryByText("未记录")).not.toBeInTheDocument();
    expect(screen.queryByText("另一处错误")).not.toBeInTheDocument();
  });
});
