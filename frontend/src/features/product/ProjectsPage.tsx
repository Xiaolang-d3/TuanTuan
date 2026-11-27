import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, FolderKanban, Plus } from "lucide-react";
import { ApiError } from "../../api/client";
import { ActionButton } from "../../components/ui/ActionButton";
import type { Conversation, LibrarySource } from "../../types";
import { readCreationRecords, type FetchCreationJson } from "./creationRecordsApi";
import type { StudioWork } from "./imageStudioApi";
import type { FinalWork } from "./finalWorksApi";
import { createProjectsApi, projectKinds, type Project, type ProjectDetail, type ProjectItem, type ProjectKind, type ProjectModelOption } from "./projectsApi";
import "./ProjectsPage.css";

type Props = {
  fetchJson: FetchCreationJson;
  id?: string;
  modelOptions: ProjectModelOption[];
  modelLoading: boolean;
  modelError: string;
  onRetryModels: () => void;
  conversationBusy: boolean;
  onSelect: (id?: string) => void;
  onOpen: (item: ProjectItem) => void;
  onOpenConversation: (create: (signal: AbortSignal) => Promise<Conversation>, signal: AbortSignal) => Promise<void>;
  /** Called once a project write (create, edit, archive, delete) is confirmed by the server. */
  onProjectsChanged?: () => void;
};
const itemKey = (item: ProjectItem) => `${item.kind}:${item.source_id}`;
const kinds = Object.keys(projectKinds) as ProjectKind[];
const maxConversationSources = 20;

function linkedSourceId(item: ProjectItem) {
  const id = Number(item.source_id);
  return item.kind === "library" && Number.isSafeInteger(id) && id > 0 && String(id) === item.source_id ? id : null;
}

function LinkSource({ fetchJson, linked, busy, onAdd }: { fetchJson: FetchCreationJson; linked: ProjectItem[]; busy: boolean; onAdd: (item: ProjectItem) => Promise<boolean> }) {
  const [kind, setKind] = useState<ProjectKind>("chat");
  const [selection, setSelection] = useState("");
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<{ kind: ProjectKind; page: number; items: ProjectItem[]; more: boolean; error: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (kind === "library") {
        const sources = await fetchJson<LibrarySource[]>("/library/sources", { signal: controller.signal });
        return { items: sources.filter(source => !source.trashed_at).map(source => ({ kind, source_id: String(source.id), title: source.title, conversation_id: null })), more: false };
      }
      if (kind === "image_work") {
        const { items } = await fetchJson<{ items: StudioWork[] }>("/image-studio/works", { signal: controller.signal });
        return { items: items.map(work => ({ kind, source_id: work.id, title: work.asset.original_filename, conversation_id: null })), more: false };
      }
      if (kind === "final_work") {
        const { items } = await fetchJson<{ items: FinalWork[] }>("/works/final", { signal: controller.signal });
        return { items: items.map(work => ({ kind, source_id: work.id, title: work.filename, conversation_id: null })), more: false };
      }
      const result = await readCreationRecords(fetchJson, { kind, limit: 30, offset: page * 30, signal: controller.signal });
      return { items: result.items.map(record => ({ kind: record.kind, source_id: record.id, title: record.title, conversation_id: record.conversation_id })), more: result.has_more };
    };
    void load().then(result => { if (!controller.signal.aborted) setCatalog({ ...result, kind, page, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setCatalog({ kind, page, items: [], more: false, error: true }); });
    return () => controller.abort();
  }, [attempt, fetchJson, kind, page]);
  const current = catalog?.kind === kind && catalog.page === page ? catalog : undefined;
  const used = new Set(linked.map(itemKey));
  const available = current?.items.filter(item => !used.has(itemKey(item))) ?? [];
  const selected = available.find(item => item.source_id === selection);
  return <form className="projects-link" aria-label="关联已有内容" onSubmit={async event => {
    event.preventDefault();
    if (selected && await onAdd(selected)) setSelection("");
  }}>
    <label>来源类型<select value={kind} disabled={busy} onChange={event => { setKind(event.currentTarget.value as ProjectKind); setSelection(""); setPage(0); }}>
      {kinds.map(value => <option value={value} key={value}>{projectKinds[value]}</option>)}
    </select></label>
    <label>已有内容<select value={selected?.source_id ?? ""} disabled={busy || !available.length} onChange={event => setSelection(event.currentTarget.value)}>
      <option value="">{!current ? "正在读取…" : available.length ? "选择一项" : "本页无可关联内容"}</option>
      {available.map(item => <option key={itemKey(item)} value={item.source_id}>{item.title}</option>)}
    </select></label>
    <ActionButton type="submit" disabled={busy || !selected}>关联</ActionButton>
    {current?.error && <><p role="alert">暂时无法读取来源。</p><ActionButton size="sm" onClick={() => { setCatalog(undefined); setAttempt(n => n + 1); }}>重试</ActionButton></>}
    {(page > 0 || current?.more) && <div className="projects-actions" aria-label="来源分页">
      <ActionButton size="sm" disabled={busy || !page} onClick={() => { setSelection(""); setPage(n => n - 1); }}>上一页</ActionButton>
      <ActionButton size="sm" disabled={busy || !current?.more} onClick={() => { setSelection(""); setPage(n => n + 1); }}>下一页</ActionButton>
    </div>}
  </form>;
}

function ProjectView({ fetchJson, id, onSelect, onOpen, modelOptions, modelLoading, modelError, onRetryModels, conversationBusy, onOpenConversation, onProjectsChanged }: Props) {
  const api = useMemo(() => createProjectsApi(fetchJson), [fetchJson]);
  const [list, setList] = useState<Project[]>();
  const [detail, setDetail] = useState<ProjectDetail>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string; modelId: string }>();
  const [linking, setLinking] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [sourceIds, setSourceIds] = useState<number[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [library, setLibrary] = useState<LibrarySource[]>();
  const [libraryError, setLibraryError] = useState(false);
  const hasLinkedSources = detail?.items.some(item => linkedSourceId(item) !== null) ?? false;
  const eligibleIds = new Set(library?.filter(source => source.enabled && source.parse_status === "ready" && !source.trashed_at).map(source => source.id));
  const chatSources = detail?.items.flatMap(item => {
    const id = linkedSourceId(item);
    return id !== null && eligibleIds.has(id) ? [{ id, title: item.title }] : [];
  }) ?? [];
  const selectedModelId = detail?.default_model_profile_id ?? "";
  const savedModel = modelOptions.find(option => option.id === selectedModelId);
  const editedModelMissing = Boolean(form?.modelId && !modelOptions.some(option => option.id === form.modelId));
  const canSaveModel = !form?.modelId || form.modelId === selectedModelId || (!modelLoading && !modelError && !editedModelMissing);

  useEffect(() => {
    const controller = new AbortController();
    const request = id ? api.detail(id, controller.signal).then(project => {
      if (!controller.signal.aborted) setDetail(project);
    }) : api.list(controller.signal).then(result => {
      if (!controller.signal.aborted) setList(result.items);
    });
    void request.catch(() => { if (!controller.signal.aborted) setError(id ? "无法打开项目，项目可能已被删除。" : "暂时无法读取项目列表。"); });
    return () => controller.abort();
  }, [api, attempt, id]);

  useEffect(() => {
    if (!startingChat || !hasLinkedSources || detail?.status !== "active") return;
    const controller = new AbortController();
    void fetchJson<LibrarySource[]>("/library/sources", { signal: controller.signal }).then(sources => {
      if (!controller.signal.aborted) setLibrary(sources);
    }).catch(() => { if (!controller.signal.aborted) setLibraryError(true); });
    return () => controller.abort();
  }, [detail?.status, fetchJson, hasLinkedSources, sourceAttempt, startingChat]);
  useEffect(() => () => {
    mutation.current?.abort();
    mutation.current = null;
  }, []);

  async function mutate(action: (signal: AbortSignal) => Promise<void>, failure: string | ((error: unknown) => string), onError: (message: string) => void = setMutationError) {
    if (mutation.current) return false;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    onError("");
    try {
      await action(controller.signal);
      return !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) onError(typeof failure === "string" ? failure : failure(error));
      return false;
    } finally {
      if (mutation.current === controller) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form?.name.trim() || !canSaveModel) return;
    const input = { name: form.name.trim(), description: form.description.trim() };
    void mutate(async signal => {
      if (detail) {
        const modelChange = form.modelId === selectedModelId ? {} : { default_model_profile_id: form.modelId || null };
        const saved = await api.update(detail.id, { ...input, ...modelChange }, signal);
        onProjectsChanged?.();
        if (signal.aborted) return;
        setDetail(old => old && { ...old, ...saved });
        setForm(undefined);
      } else {
        const created = await api.create(input, signal);
        onProjectsChanged?.();
        if (!signal.aborted) onSelect(created.id);
      }
    }, "暂时无法保存项目，请重试。");
  }

  function retrySources() {
    setLibrary(undefined);
    setLibraryError(false);
    setSourceAttempt(attempt => attempt + 1);
  }

  function submitConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (detail?.status !== "active" || conversationBusy) return;
    const availableIds = new Set(chatSources.map(source => source.id));
    if (sourceIds.length > maxConversationSources || sourceIds.some(id => !availableIds.has(id))) {
      setSourceError("部分资料已不可用，请重新选择后重试。");
      return;
    }
    void mutate(signal => onOpenConversation(requestSignal => api.createConversation(detail.id, sourceIds, requestSignal), signal), error => {
      if (error instanceof ApiError && error.status === 422 && sourceIds.length) {
        setSourceIds([]);
        retrySources();
        return "部分资料可能已不可用。已清空选择，请核对可用资料后重新勾选。";
      }
      return error instanceof Error ? error.message : "暂时无法创建项目对话，请重试。";
    }, setSourceError);
  }

  return <section className="projects-page" aria-label={id ? "项目详情" : "我的项目"}>
    {id && <ActionButton size="sm" onClick={() => onSelect()}><ArrowLeft size={16} aria-hidden="true"/>返回我的项目</ActionButton>}
    <header className="projects-heading">
      <div><h1><FolderKanban size={22} aria-hidden="true"/>{id ? detail?.name || "项目详情" : "我的项目"}</h1>
        {detail && <><p>状态：{detail.status === "archived" ? "已归档" : "进行中"}</p>
          <p>默认对话模型：{savedModel?.label ?? (selectedModelId ? (modelLoading ? "正在读取…" : modelError ? "未能读取模型" : "原模型不可用，使用账户默认模型") : "使用账户默认模型")}</p></>}
        <p>{id ? detail?.description || "把相关创作和资料放在一起，来源仍保留在原处。" : "把对话、图片、文档、PPT 和资料关联到同一个项目。"}</p></div>
      {!id && !form && <ActionButton onClick={() => setForm({ name: "", description: "", modelId: "" })}><Plus size={16} aria-hidden="true"/>新建项目</ActionButton>}
      {detail && !form && !confirmDelete && <div className="projects-actions">
        {detail.status === "active" && !startingChat && <ActionButton disabled={busy || conversationBusy} onClick={() => { retrySources(); setStartingChat(true); }}><Plus size={16} aria-hidden="true"/>新建项目对话</ActionButton>}
        <ActionButton size="sm" disabled={busy} onClick={() => setForm({ name: detail.name, description: detail.description, modelId: selectedModelId })}>编辑项目</ActionButton>
        <ActionButton size="sm" disabled={busy} onClick={() => void mutate(async signal => {
          const saved = await api.update(detail.id, { status: detail.status === "active" ? "archived" : "active" }, signal);
          onProjectsChanged?.();
          if (signal.aborted) return;
          setDetail(old => old && { ...old, ...saved });
          if (saved.status === "archived") { setStartingChat(false); setSourceIds([]); setSourceError(""); }
        }, "暂时无法更新项目状态，请重试。")}>{detail.status === "active" ? "归档项目" : "恢复项目"}</ActionButton>
        <ActionButton size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</ActionButton>
      </div>}
    </header>
    {error ? <div className="projects-actions"><p role="alert">{error}</p><ActionButton size="sm" onClick={() => { setError(""); setAttempt(n => n + 1); }}>重试</ActionButton></div>
      : (id ? !detail : !list) && <p role="status">正在读取项目…</p>}
    {mutationError && <p role="alert">{mutationError}</p>}
    {form && <form className="projects-form" aria-label={id ? "编辑项目" : "新建项目"} onSubmit={submit}>
      <label>项目名称<input required maxLength={120} value={form.name} disabled={busy} onChange={event => setForm({ ...form, name: event.currentTarget.value })}/></label>
      <label>项目说明<textarea maxLength={2000} rows={3} value={form.description} disabled={busy} onChange={event => setForm({ ...form, description: event.currentTarget.value })}/></label>
      {detail && <>
        <label>项目默认对话模型<select value={form.modelId} disabled={busy} onChange={event => setForm({ ...form, modelId: event.currentTarget.value })}>
          <option value="">使用账户默认模型</option>
          {editedModelMissing && <option value={form.modelId} disabled>{modelLoading ? "正在读取已保存的模型…" : modelError ? "未能读取已保存的模型" : "原模型不可用"}</option>}
          {modelOptions.map(option => <option key={option.id} value={option.id} disabled={modelLoading || Boolean(modelError)}>{option.label}</option>)}
        </select></label>
        <p>仅影响在此项目中新建的对话；仍可在每个对话中切换模型。</p>
        {modelLoading && <p role="status">正在读取可用模型…</p>}
        {modelError && <div className="projects-actions"><p role="alert">无法读取可用模型。</p><ActionButton size="sm" onClick={onRetryModels}>重试读取模型</ActionButton></div>}
      </>}
      <div className="projects-actions"><ActionButton type="submit" disabled={busy || !form.name.trim() || !canSaveModel}>保存项目</ActionButton><ActionButton disabled={busy} onClick={() => setForm(undefined)}>取消</ActionButton></div>
    </form>}
    {startingChat && detail?.status === "active" && !form && !confirmDelete && <form className="projects-form" aria-label="新建项目对话" onSubmit={submitConversation}>
      <h2>新建项目对话</h2>
      <fieldset className="projects-source-list" disabled={busy || conversationBusy}>
        <legend>对话资料（可选）</legend>
        <p>只使用本次勾选的项目资料，默认不带入资料。不会自动发送消息或执行任务。</p>
        <p role="status">已选 {sourceIds.length} / {maxConversationSources}</p>
        {!library && !libraryError && hasLinkedSources && <p role="status">正在读取可用资料…</p>}
        {libraryError && <div className="projects-actions"><p role="status">无法读取可用资料，仍可不带资料创建对话。</p><ActionButton size="sm" onClick={retrySources}>重试读取资料</ActionButton></div>}
        {(!hasLinkedSources || library) && chatSources.length === 0 && <p>没有可用的项目资料。仅显示已关联且启用、解析完成、未移入回收站的资料。</p>}
        {chatSources.map(source => <label key={source.id} className="projects-source-option">
          <input type="checkbox" checked={sourceIds.includes(source.id)} disabled={!sourceIds.includes(source.id) && sourceIds.length >= maxConversationSources} onChange={event => {
            const checked = event.currentTarget.checked;
            setSourceIds(current => checked ? (current.length < maxConversationSources && !current.includes(source.id) ? [...current, source.id] : current) : current.filter(id => id !== source.id));
          }}/>{source.title}
        </label>)}
      </fieldset>
      {sourceError && <p role="alert">{sourceError}</p>}
      <div className="projects-actions"><ActionButton type="submit" disabled={busy || conversationBusy}>创建对话</ActionButton><ActionButton disabled={busy} onClick={() => { setStartingChat(false); setSourceIds([]); setSourceError(""); }}>取消新建对话</ActionButton></div>
    </form>}
    {confirmDelete && detail && <section className="projects-form" aria-label="确认删除项目">
      <p>删除后将解除全部关联，不会删除原对话、文件或作品。</p>
      <div className="projects-actions"><ActionButton disabled={busy} onClick={() => void mutate(async signal => { await api.remove(detail.id, signal); onProjectsChanged?.(); if (!signal.aborted) onSelect(); }, "暂时无法删除项目，请重试。")}>确认删除项目</ActionButton>
        <ActionButton disabled={busy} onClick={() => setConfirmDelete(false)}>取消删除</ActionButton></div>
    </section>}
    {list?.length === 0 && <p>还没有项目。创建一个项目，把相关工作整理在一起。</p>}
    {list && list.length > 0 && <ul className="projects-list">{list.map(project => <li key={project.id}>
      <button type="button" disabled={busy} className="projects-row" onClick={() => onSelect(project.id)}><strong>{project.name}</strong><span>{project.status === "archived" ? "已归档" : "进行中"}{project.description ? ` · ${project.description}` : ""}</span></button>
    </li>)}</ul>}
    {detail && <section className="projects-content" aria-label="项目关联内容">
      <header className="projects-heading"><h2>关联内容</h2><ActionButton size="sm" disabled={busy} aria-expanded={linking} onClick={() => setLinking(value => !value)}>{linking ? "收起添加" : "添加关联"}</ActionButton></header>
      {linking && <LinkSource fetchJson={fetchJson} linked={detail.items} busy={busy} onAdd={item => mutate(async signal => {
        const saved = await api.addItem(detail.id, item, signal);
        if (signal.aborted) return;
        if (startingChat && linkedSourceId(saved) !== null) {
          setSourceIds([]);
          retrySources();
        }
        setDetail(old => old && { ...old, items: [...old.items.filter(existing => itemKey(existing) !== itemKey(saved)), saved] });
      }, "无法关联这项内容，来源可能已被移除。")}/>}
      {!detail.items.length && <p>还没有关联内容。历史记录不会自动加入项目。</p>}
      {detail.items.length > 0 && <ul className="projects-list">{detail.items.map(item => <li key={itemKey(item)}>
        <button type="button" className="projects-row" disabled={busy} onClick={() => onOpen(item)}><strong>{item.title}</strong><span>{projectKinds[item.kind]}</span></button>
        <ActionButton size="sm" disabled={busy} aria-label={`解除关联：${item.title}`} onClick={() => void mutate(async signal => {
          await api.removeItem(detail.id, item, signal);
          if (signal.aborted) return;
          const sourceId = linkedSourceId(item);
          if (sourceId !== null) setSourceIds(current => current.filter(id => id !== sourceId));
          setDetail(old => old && { ...old, items: old.items.filter(existing => itemKey(existing) !== itemKey(item)) });
        }, "暂时无法解除关联，请重试。")}>解除关联</ActionButton>
      </li>)}</ul>}
    </section>}
  </section>;
}

export function ProjectsPage(props: Props) {
  return <ProjectView key={props.id ?? "list"} {...props}/>;
}
