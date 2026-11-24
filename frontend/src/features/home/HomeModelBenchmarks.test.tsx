import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeModelBenchmarks } from "./HomeModelBenchmarks";
import type { HomeModelBenchmark, HomeModelBenchmarks as Data } from "./types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const model = (index: number, overrides: Partial<HomeModelBenchmark> = {}): HomeModelBenchmark => ({
  id: `model-${index}`, name: `Atlas ${index} (high)`, creator: "New Lab", creator_id: "new-lab", url: `https://artificialanalysis.ai/models/atlas-${index}`,
  intelligence: 50 + index / 100, coding: null, agentic: null, input_price: 1, output_price: 4, task_cost: 1.75,
  tokens_per_second: 100, first_token_seconds: 2, ...overrides,
});
const snapshot = (models: HomeModelBenchmark[], overrides: Partial<Data> = {}): Data => ({ models, status: "ready", error: null, collected_at: "2026-10-22T02:00:00Z", source_url: "https://artificialanalysis.ai/leaderboards/models", docs_url: "https://artificialanalysis.ai/data-api/docs/reference", ...overrides });

describe("official model Data API display", () => {
  it("plots every measured configuration without selecting one per creator or embedding a website", () => {
    const models = Array.from({ length: 61 }, (_, index) => model(index + 1));
    const view = render(<HomeModelBenchmarks data={snapshot(models)} />);
    const chart = screen.getByRole("group", { name: "模型能力与成本散点图" });
    expect(within(chart).getAllByRole("button")).toHaveLength(61);
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/61 个模型/)).toBeVisible();
    fireEvent.click(within(chart).getByRole("button", { name: /Atlas 61 \(high\)/ }));
    expect(screen.getByRole("link", { name: /Atlas 61/ })).toHaveAttribute("href", models[60].url);
    expect(screen.getByText(/输入 \$1 \/ 输出 \$4 每百万 token/)).toBeVisible();
    expect(chart).toHaveTextContent("评测任务成本：USD / 任务");
    expect(chart).toHaveTextContent("对数刻度");
    expect(view.container.querySelectorAll(".home-benchmark-point-label").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "筛选与显示设置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "模型名称" }));
    expect(view.container.querySelector(".home-benchmark-point-label")).toBeNull();
    expect(within(chart).getAllByRole("button")).toHaveLength(61);
    fireEvent.click(screen.getByRole("checkbox", { name: "成本对数刻度" }));
    expect(chart).toHaveTextContent("线性刻度");
  });

  it("keeps missing-score models in searchable paginated details and displays zero as free", () => {
    const models = Array.from({ length: 51 }, (_, index) => model(index + 1));
    models.push(model(99, { creator: "Unlisted Creator", creator_id: "other", intelligence: null, task_cost: null, input_price: 0 }));
    render(<HomeModelBenchmarks data={snapshot(models)} />);
    expect(within(screen.getByRole("group", { name: "模型能力与成本散点图" })).getAllByRole("button")).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "全部模型明细" }));
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("link", { name: "Atlas 99 (high)" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索评测模型" }), { target: { value: "Unlisted Creator" } });
    const row = screen.getByRole("link", { name: "Atlas 99 (high)" }).closest("tr")!;
    expect(row).toHaveTextContent("未提供");
    expect(row).toHaveTextContent("$0");
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "能力 × 速度" }));
    expect(screen.queryByRole("group", { name: "模型能力与速度散点图" })).not.toBeInTheDocument();
    expect(screen.getByText(/当前没有具备完整指标的模型/)).toBeVisible();
  });

  it("lets users filter any returned creator and restores every model when cleared", () => {
    render(<HomeModelBenchmarks data={snapshot([model(1), model(2, { creator: "Another Lab" })])} />);
    fireEvent.click(screen.getByRole("button", { name: "筛选与显示设置" }));
    fireEvent.change(screen.getByRole("combobox", { name: "评测厂商" }), { target: { value: "Another Lab" } });
    const chart = screen.getByRole("group", { name: "模型能力与成本散点图" });
    expect(within(chart).getAllByRole("button")).toHaveLength(1);
    expect(within(chart).getByRole("button")).toHaveAccessibleName(/Atlas 2/);
    fireEvent.change(screen.getByRole("combobox", { name: "评测厂商" }), { target: { value: "" } });
    expect(within(chart).getAllByRole("button")).toHaveLength(2);
  });

  it("reflows the chart into narrow containers without dropping models or crowding labels", () => {
    let width = 480;
    const observers = new Map<Element, () => void>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 380, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 380, toJSON: () => ({}) }));
    vi.stubGlobal("ResizeObserver", class {
      private targets = new Set<Element>();
      constructor(private callback: () => void) {}
      observe(target: Element) { this.targets.add(target); observers.set(target, this.callback); }
      unobserve(target: Element) { this.targets.delete(target); observers.delete(target); }
      disconnect() { for (const target of this.targets) this.unobserve(target); }
    });
    const view = render(<HomeModelBenchmarks data={snapshot(Array.from({ length: 61 }, (_, i) => model(i)))} />);
    const chart = screen.getByRole("group", { name: "模型能力与成本散点图" });
    expect(chart).toHaveAttribute("viewBox", "0 0 480 380");
    expect(within(chart).getAllByRole("button")).toHaveLength(61);
    expect(view.container.querySelectorAll(".home-benchmark-point-label").length).toBeLessThanOrEqual(5);
    const resize = observers.get(chart.parentElement!);
    expect(resize).toBeDefined();
    width = 760;
    act(() => resize!());
    expect(chart).toHaveAttribute("viewBox", "0 0 760 450");
    expect(within(chart).getAllByRole("button")).toHaveLength(61);
  });

  it("shows setup and source attribution without fake data, and retains old points on upstream errors", () => {
    const view = render(<HomeModelBenchmarks data={snapshot([], { status: "unconfigured", collected_at: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("尚未配置官方评测数据源");
    expect(screen.queryByRole("group", { name: /散点图/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Data API 文档" })).toHaveAttribute("href", "https://artificialanalysis.ai/data-api/docs/reference");
    view.rerender(<HomeModelBenchmarks data={snapshot([model(1)], { status: "error", error: "官方 API 请求额度受限" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("继续显示上次快照");
    expect(screen.getByRole("button", { name: /查看模型：Atlas 1/ })).toBeVisible();
    expect(screen.getByText(/采集于/)).toBeVisible();
  });
});
