import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HomePage } from "./HomePage";
import type { FetchJson, HomeFeedResponse, HomeWorkspaceResponse } from "./types";

const fixtureWorkspace = (): HomeWorkspaceResponse => ({
  generated_at: "2026-10-08T02:00:00Z",
  conversations: { items: [], error: null },
  jobs: { running: [], pending_confirmations: [] },
  weixin: { connected: false, unread_count: 0 },
  changelog: { items: [], error: null },
  skills: { items: [], error: null },
  library_recent: { items: [], error: null }
});

function setup(enabled = true) {
  let feed: HomeFeedResponse = {
    news: [], repositories: { day: [], week: [] }, updates: [], practices: [], sources: [], item_states: {},
    preferences: { topics: ["Agent"], repositories: [], digest_profile_id: enabled ? "p1" : "", ...(enabled ? { curation_enabled: true } : {}) },
    digest: { status: "unconfigured", profile_id: "", model_name: "", generated_at: null, date: null, error: "", overview: "", sections: [] },
    curation: { status: enabled ? "ready" : "disabled", date: "2026-10-18", generated_at: null, model_name: "text-model", error: "", warnings: [], items: [] },
    refreshing: false, last_synced_at: null
  };
  const client = vi.fn<FetchJson>(async (path, options) => {
    if (path === "/home/workspace") return structuredClone(fixtureWorkspace()) as never;
    if (path === "/agent/model-connections") return { connections: [{ id: "c1", enabled: true }], profiles: [{ id: "p1", model_name: "text-model", connection_id: "c1", enabled: true }] } as never;
    if (path === "/home/preferences") feed = { ...feed, preferences: JSON.parse(String(options?.body)) };
    if (path === "/home/feed/curation") feed = { ...feed, curation: { ...feed.curation!, status: "generating" } };
    return structuredClone(feed) as never;
  }) as Mock<FetchJson> & FetchJson;
  render(<HomePage fetchJson={client} accountName="开发者" accountKey="curation-account" onAnalyze={vi.fn()} onLibraryChanged={vi.fn()} />);
  return client;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("homepage daily curation integration", () => {
  it("requires explicit opt-in and a model, saves it, and discloses privacy/cost without requesting generation on opening", async () => {
    const client = setup(false);
    const region = await screen.findByRole("region", { name: /今日值得看/ });
    fireEvent.click(within(region).getByRole("button", { name: "兴趣设置" }));
    const dialog = screen.getByRole("dialog", { name: "兴趣设置" });
    await within(dialog).findByRole("option", { name: "text-model" });
    const checkbox = within(dialog).getByRole("checkbox", { name: "启用每日资讯精选" });
    expect(checkbox).not.toBeChecked();
    expect(within(dialog).getByText(/仅发送关注方向与公开内容/)).toHaveTextContent("现有搜索服务");
    expect(within(dialog).getByText(/每天最多 3 次搜索和 1 次文本模型调用/)).toHaveTextContent("应用运行并打开首页");
    expect(client.mock.calls.map(([path]) => path)).toEqual(["/home/feed", "/home/workspace", "/agent/model-connections"]);
    fireEvent.click(checkbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存设置" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("请先选择日报模型，再启用每日资讯精选");
    expect(client.mock.calls.some(([path]) => path === "/home/preferences")).toBe(false);
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "p1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client).toHaveBeenCalledWith("/home/preferences", expect.objectContaining({ method: "PUT", body: JSON.stringify({ topics: ["Agent"], repositories: [], digest_profile_id: "p1", curation_enabled: true }) }));
    expect(client.mock.calls.some(([path]) => path === "/home/feed/curation")).toBe(false);
  });
  it("places today's curation above the existing digest and posts once only after explicit regeneration", async () => {
    const client = setup();
    const region = await screen.findByRole("region", { name: /今日值得看/ });
    await waitFor(() => expect(client).toHaveBeenCalledTimes(2));
    const digest = screen.getByRole("region", { name: /今日 AI 日报/ });
    expect(region.compareDocumentPosition(digest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const button = within(region).getByRole("button", { name: "重新筛选" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(client.mock.calls.filter(([path]) => path === "/home/feed/curation")).toHaveLength(1));
    expect(client).toHaveBeenCalledWith("/home/feed/curation", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(button).toBeDisabled());
    expect(within(region).getByRole("status")).toHaveTextContent("正在搜索、去重并筛选今日资讯");
  });
});
