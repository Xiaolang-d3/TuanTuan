import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeModelBenchmarks } from "./HomeModelBenchmarks";
import type { HomeMediaBoard, HomeMediaModel, HomeModelBenchmarks as Data } from "./types";

afterEach(cleanup);
const model = (id: string, extra: Partial<HomeMediaModel> = {}): HomeMediaModel => ({
  id, name: `Model ${id}`, creator: "New Lab", creator_id: "new-lab", url: "https://artificialanalysis.ai/image/arena",
  elo: 1200, ci_95: 10, bba_score: null, fdb_score: null, tau_voice_score: null, wer: null, ...extra,
});
const board = (id: string, category: HomeMediaBoard["category"], label: string, models: HomeMediaModel[], extra: Partial<HomeMediaBoard> = {}): HomeMediaBoard => ({
  id, category, label, models, metric: id === "speech-to-text" ? "wer" : id === "speech-to-speech" ? "bba_score" : "elo",
  source_url: "https://artificialanalysis.ai/image/arena", status: "ready", collected_at: "2026-10-22T04:00:00Z", error: null, ...extra,
});
const snapshot = (media: HomeMediaBoard[]): Data => ({ media, models: [], status: "ready", error: null, collected_at: null, source_url: "https://artificialanalysis.ai/", docs_url: "https://artificialanalysis.ai/data-api/docs/reference" });

describe("four model categories", () => {
  it("matches the four requested categories, supports keyboard tabs and independent task boards", async () => {
    render(<HomeModelBenchmarks data={snapshot([
      board("text-to-image", "image", "图像生成", [model("image")]),
      board("image-editing", "image", "图像编辑", [model("edit")]),
      board("text-to-video", "video", "文生视频 · 无声", [model("video")]),
    ])} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map(tab => tab.textContent)).toEqual(["语言模型", "图像", "视频", "语音"]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    await waitFor(() => expect(tabs[3]).toHaveFocus());
    expect(tabs[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[3], { key: "Home" });
    await waitFor(() => expect(tabs[0]).toHaveFocus());
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    await waitFor(() => expect(tabs[1]).toHaveFocus());
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("图像");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", tabs[1].getAttribute("aria-controls"));
    expect(screen.getByRole("button", { name: /查看媒体模型：Model image/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /查看媒体模型：Model video/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图像编辑" }));
    expect(screen.getByRole("button", { name: /查看媒体模型：Model edit/ })).toBeVisible();
    fireEvent.click(tabs[2]);
    expect(screen.getByRole("button", { name: /查看媒体模型：Model video/ })).toBeVisible();
    fireEvent.click(tabs[1]);
    expect(screen.getByRole("button", { name: /查看媒体模型：Model image/ })).toBeVisible();
  });

  it("retains every returned media model, ranks Elo descending, searches unknown creators and shows confidence", () => {
    render(<HomeModelBenchmarks data={snapshot([board("text-to-image", "image", "图像生成", [
      model("low", { elo: 0 }), model("high", { elo: 1400, creator: "Other Lab" }), model("missing", { elo: null, ci_95: null }),
    ])])} />);
    fireEvent.click(screen.getByRole("tab", { name: "图像" }));
    const list = screen.getByRole("list", { name: "图像生成模型榜单" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(/Model high/);
    expect(within(list).getAllByRole("button")[1]).toHaveAccessibleName(/Elo 评分 0/);
    fireEvent.click(within(list).getAllByRole("button")[0]);
    expect(screen.getByRole("link", { name: /Model high/ })).toBeVisible();
    expect(screen.getByText(/95% CI ± 10/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索媒体模型" }), { target: { value: "Other Lab" } });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByText("指标说明"));
    expect(screen.getByText(/公开数据未提供此类别的价格与速度/)).toBeVisible();
  });

  it("ranks WER ascending with real zero, keeps null scores, and never combines speech metrics", () => {
    render(<HomeModelBenchmarks data={snapshot([
      board("speech-to-text", "speech", "语音识别", [model("wrong", { wer: .1 }), model("zero", { wer: 0 }), model("none")]),
      board("speech-to-speech", "speech", "语音对话", [model("chat", { bba_score: .54, fdb_score: null, tau_voice_score: .37 })]),
    ])} />);
    fireEvent.click(screen.getByRole("tab", { name: "语音" }));
    let list = screen.getByRole("list", { name: "语音识别模型榜单" });
    expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(/Model zero.*0%/);
    expect(within(list).getAllByRole("button")[2]).toHaveAccessibleName(/未提供/);
    expect(screen.getByText(/越低越好/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "语音对话" }));
    list = screen.getByRole("list", { name: "语音对话模型榜单" });
    expect(within(list).getByRole("button")).toHaveAccessibleName(/0.54/);
    fireEvent.click(screen.getByRole("button", { name: "媒体筛选设置" }));
    fireEvent.change(screen.getByRole("combobox", { name: "语音对话指标" }), { target: { value: "fdb_score" } });
    expect(within(list).getByRole("button")).toHaveAccessibleName(/FDB.*未提供/);
    fireEvent.change(screen.getByRole("combobox", { name: "语音对话指标" }), { target: { value: "tau_voice_score" } });
    expect(within(list).getByRole("button")).toHaveAccessibleName(/0.37/);
  });

  it("shows per-board stale snapshots and explicit empty states without language data as media", () => {
    const view = render(<HomeModelBenchmarks data={snapshot([board("text-to-image", "image", "图像生成", [model("old")], { status: "error", error: "此榜单更新失败" })])} />);
    fireEvent.click(screen.getByRole("tab", { name: "图像" }));
    expect(screen.getByRole("status")).toHaveTextContent("继续显示上次快照");
    expect(screen.getByRole("button", { name: /查看媒体模型：Model old/ })).toBeVisible();
    view.rerender(<HomeModelBenchmarks data={snapshot([board("text-to-image", "image", "图像生成", [], { status: "empty" })])} />);
    expect(screen.getByRole("status")).toHaveTextContent("未返回此榜单");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
