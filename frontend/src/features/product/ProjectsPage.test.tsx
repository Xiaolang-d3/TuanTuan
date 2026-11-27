import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { Conversation, LibrarySource } from "../../types";
import { ProjectsPage } from "./ProjectsPage";
import type { ProjectDetail, ProjectItem } from "./projectsApi";

function item(id: number | string, kind: ProjectItem["kind"] = "library"): ProjectItem {
  return { kind, source_id: String(id), title: `来源 ${id}`, conversation_id: null };
}

function source(id: number, extra: Partial<LibrarySource> = {}) {
  return { id, enabled: true, parse_status: "ready", trashed_at: null, ...extra };
}

const detail: ProjectDetail = {
  id: "project/123", name: "调研项目", description: "研究计划", status: "active", created_at: "", updated_at: "",
  default_model_profile_id: null, items: [item(1)],
};
const conversation: Conversation = { id: 17, title: "新对话", status: "active", summary: "", updated_at: "" };
const path = "/projects/project%2F123";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

function setup(options: { project?: ProjectDetail; sources?: ReturnType<typeof source>[]; post?: () => Promise<Conversation> } = {}) {
  let project = options.project ?? detail;
  const fetch = vi.fn(async (requestPath: string, init?: RequestInit) => {
    if (requestPath === `${path}/conversations`) return options.post ? options.post() : conversation;
    if (requestPath === "/library/sources") return options.sources ?? [source(1)];
    if (requestPath === path && init?.method === "PATCH") {
      project = { ...project, ...JSON.parse(String(init.body)) };
      return project;
    }
    if (requestPath === path) return project;
    if (requestPath === "/projects/other") return { ...detail, id: "other", name: "其他项目", items: [] };
    throw new Error(`Unexpected request ${requestPath}`);
  });
  const opened = vi.fn();
  const props = {
    id: detail.id, fetchJson: async <T,>(requestPath: string, init?: RequestInit) => await fetch(requestPath, init) as T,
    modelOptions: [{ id: "model-a", label: "聊天模型 A" }], modelLoading: false, modelError: "", onRetryModels: vi.fn(),
    conversationBusy: false, onSelect: vi.fn(), onOpen: vi.fn(),
    onOpenConversation: async (create: (signal: AbortSignal) => Promise<Conversation>, signal: AbortSignal) => {
      const result = await create(signal);
      if (!signal.aborted) opened(result);
    },
  };
  const view = render(<ProjectsPage {...props} />);
  const requests = (method: string) => fetch.mock.calls.filter(([, init]) => init?.method === method);
  return { fetch, opened, props, view, requests };
}

async function openForm() {
  fireEvent.click(await screen.findByRole("button", { name: "新建项目对话" }));
  return within(screen.getByRole("form", { name: "新建项目对话" }));
}

afterEach(cleanup);

describe("Project conversation form", () => {
  it("does not submit on open and sends an explicit empty scope by default", async () => {
    const { requests, opened } = setup();
    const form = await openForm();
    expect(await form.findByRole("checkbox", { name: "来源 1" })).not.toBeChecked();
    expect(requests("POST")).toEqual([]);
    fireEvent.click(form.getByRole("button", { name: "创建对话" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(conversation));
    expect(requests("POST").map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([[`${path}/conversations`, { source_ids: [] }]]);
  });

  it("offers only eligible linked library entries and limits the selection to 20", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => index + 1);
    const { requests, opened } = setup({
      project: { ...detail, items: [...ids.map(id => item(id)), item(22), item(23), item(24), item(25, "chat"), item("026"), item(27)] },
      sources: [...ids.map(id => source(id)), source(22, { enabled: false }), source(23, { parse_status: "pending" }), source(24, { trashed_at: "now" }), source(25), source(26), source(28)],
    });
    const form = await openForm();
    const boxes = await form.findAllByRole("checkbox");
    expect(boxes).toHaveLength(21);
    boxes.slice(0, 20).forEach(box => fireEvent.click(box));
    expect(form.getByText("已选 20 / 20")).toBeVisible();
    expect(boxes[20]).toBeDisabled();
    fireEvent.click(boxes[0]);
    expect(boxes[20]).toBeEnabled();
    fireEvent.click(boxes[20]);
    fireEvent.click(form.getByRole("button", { name: "创建对话" }));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(requests("POST")[0][1]?.body))).toEqual({ source_ids: ids.slice(1) });
  });

  it("clears and reloads a selection rejected by the server", async () => {
    let calls = 0;
    const { fetch, requests } = setup({ post: async () => {
      if (++calls === 1) throw new ApiError("Source no longer eligible", 422);
      return conversation;
    } });
    const form = await openForm();
    fireEvent.click(await form.findByRole("checkbox", { name: "来源 1" }));
    fireEvent.click(form.getByRole("button", { name: "创建对话" }));
    expect(await form.findByRole("alert")).toHaveTextContent("已清空选择");
    expect(await form.findByRole("checkbox", { name: "来源 1" })).not.toBeChecked();
    expect(fetch.mock.calls.filter(([url]) => url === "/library/sources")).toHaveLength(2);
    fireEvent.click(form.getByRole("button", { name: "创建对话" }));
    await waitFor(() => expect(requests("POST").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ source_ids: [1] }, { source_ids: [] }]));
  });

  it("aborts a pending create when switching projects and drops the stale completion", async () => {
    const pending = deferred<Conversation>();
    const { requests, props, view, opened } = setup({ post: () => pending.promise });
    const form = await openForm();
    fireEvent.click(form.getByRole("button", { name: "创建对话" }));
    view.rerender(<ProjectsPage {...props} id="other" />);
    expect(requests("POST")[0][1]?.signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(conversation); });
    expect(await screen.findByRole("heading", { name: "其他项目" })).toBeVisible();
    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "新建项目对话" })).not.toBeInTheDocument();
  });

  it("does not offer a new conversation in an archived project", async () => {
    const { requests } = setup({ project: { ...detail, status: "archived" } });
    expect(await screen.findByText("状态：已归档")).toBeVisible();
    expect(screen.queryByRole("button", { name: "新建项目对话" })).not.toBeInTheDocument();
    expect(requests("POST")).toEqual([]);
  });
});

describe("Project default chat model", () => {
  it("saves a profile and allows switching back to the account default", async () => {
    const { requests } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "编辑项目" }));
    fireEvent.change(screen.getByRole("combobox", { name: "项目默认对话模型" }), { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    expect(await screen.findByText("默认对话模型：聊天模型 A")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "编辑项目" }));
    fireEvent.change(screen.getByRole("combobox", { name: "项目默认对话模型" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    expect(await screen.findByText("默认对话模型：使用账户默认模型")).toBeVisible();
    expect(requests("PATCH").map(([, init]) => JSON.parse(String(init?.body)).default_model_profile_id)).toEqual(["model-a", null]);
  });

  it("does not resend an unavailable profile when an unrelated field is saved", async () => {
    const { requests } = setup({ project: { ...detail, default_model_profile_id: "obsolete" } });
    expect(await screen.findByText("默认对话模型：原模型不可用，使用账户默认模型")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "编辑项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    expect(await screen.findByRole("heading", { name: "新名称" })).toBeVisible();
    expect(JSON.parse(String(requests("PATCH")[0][1]?.body))).toEqual({ name: "新名称", description: detail.description });
  });
});
