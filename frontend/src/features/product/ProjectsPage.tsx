import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, FolderKanban, Plus } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import type { LibrarySource } from "../../types";
import { readCreationRecords, type CreationKind, type FetchCreationJson } from "./creationRecordsApi";
import { createProjectsApi, projectKinds, type Project, type ProjectDetail, type ProjectItem, type ProjectKind } from "./projectsApi";
import "./ProjectsPage.css";

type Props = { fetchJson: FetchCreationJson; id?: string; onSelect: (id?: string) => void; onOpen: (item: ProjectItem) => void };
const itemKey = (item: ProjectItem) => `${item.kind}:${item.source_id}`;
const kinds: ProjectKind[] = ["chat", "image", "document", "presentation", "library"];

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
      const result = await readCreationRecords(fetchJson, { kind: kind as CreationKind, limit: 30, offset: page * 30, signal: controller.signal });
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

function ProjectView({ fetchJson, id, onSelect, onOpen }: Props) {
  const api = useMemo(() => createProjectsApi(fetchJson), [fetchJson]);
  const [list, setList] = useState<Project[]>();
  const [detail, setDetail] = useState<ProjectDetail>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string }>();
  const [linking, setLinking] = useState(false);

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

  async function mutate(action: () => Promise<void>, failure: string) {
    if (busy) return false;
    setBusy(true);
    setMutationError("");
    try { await action(); return true; }
    catch { setMutationError(failure); return false; }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form?.name.trim()) return;
    const input = { name: form.name.trim(), description: form.description.trim() };
    void mutate(async () => {
      if (detail) {
        const saved = await api.update(detail.id, input);
        setDetail({ ...saved, items: detail.items });
        setForm(undefined);
      } else {
        const created = await api.create(input);
        onSelect(created.id);
      }
    }, "暂时无法保存项目，请重试。");
  }

  return <section className="projects-page" aria-label={id ? "项目详情" : "我的项目"}>
    {id && <ActionButton size="sm" onClick={() => onSelect()} disabled={busy}><ArrowLeft size={16} aria-hidden="true"/>返回我的项目</ActionButton>}
    <header className="projects-heading">
      <div><h1><FolderKanban size={22} aria-hidden="true"/>{id ? detail?.name || "项目详情" : "我的项目"}</h1>
        <p>{id ? detail?.description || "把相关创作和资料放在一起，来源仍保留在原处。" : "把对话、图片、文档、PPT 和资料关联到同一个项目。"}</p></div>
      {!id && !form && <ActionButton onClick={() => setForm({ name: "", description: "" })}><Plus size={16} aria-hidden="true"/>新建项目</ActionButton>}
      {detail && !form && !confirmDelete && <div className="projects-actions">
        <ActionButton size="sm" disabled={busy} onClick={() => setForm({ name: detail.name, description: detail.description })}>编辑项目</ActionButton>
        <ActionButton size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</ActionButton>
      </div>}
    </header>
    {error ? <div className="projects-actions"><p role="alert">{error}</p><ActionButton size="sm" onClick={() => { setError(""); setAttempt(n => n + 1); }}>重试</ActionButton></div>
      : (id ? !detail : !list) && <p role="status">正在读取项目…</p>}
    {mutationError && <p role="alert">{mutationError}</p>}
    {form && <form className="projects-form" aria-label={id ? "编辑项目" : "新建项目"} onSubmit={submit}>
      <label>项目名称<input required maxLength={120} value={form.name} disabled={busy} onChange={event => setForm({ ...form, name: event.currentTarget.value })}/></label>
      <label>项目说明<textarea maxLength={2000} rows={3} value={form.description} disabled={busy} onChange={event => setForm({ ...form, description: event.currentTarget.value })}/></label>
      <div className="projects-actions"><ActionButton type="submit" disabled={busy || !form.name.trim()}>保存项目</ActionButton><ActionButton disabled={busy} onClick={() => setForm(undefined)}>取消</ActionButton></div>
    </form>}
    {confirmDelete && detail && <section className="projects-form" aria-label="确认删除项目">
      <p>删除后将解除全部关联，不会删除原对话、文件或作品。</p>
      <div className="projects-actions"><ActionButton disabled={busy} onClick={() => void mutate(async () => { await api.remove(detail.id); onSelect(); }, "暂时无法删除项目，请重试。")}>确认删除项目</ActionButton>
        <ActionButton disabled={busy} onClick={() => setConfirmDelete(false)}>取消删除</ActionButton></div>
    </section>}
    {list?.length === 0 && <p>还没有项目。创建一个项目，把相关工作整理在一起。</p>}
    {list && list.length > 0 && <ul className="projects-list">{list.map(project => <li key={project.id}>
      <button type="button" disabled={busy} className="projects-row" onClick={() => onSelect(project.id)}><strong>{project.name}</strong><span>{project.description || "查看关联内容"}</span></button>
    </li>)}</ul>}
    {detail && <section className="projects-content" aria-label="项目关联内容">
      <header className="projects-heading"><h2>关联内容</h2><ActionButton size="sm" disabled={busy} aria-expanded={linking} onClick={() => setLinking(value => !value)}>{linking ? "收起添加" : "添加关联"}</ActionButton></header>
      {linking && <LinkSource fetchJson={fetchJson} linked={detail.items} busy={busy} onAdd={item => mutate(async () => {
        const saved = await api.addItem(detail.id, item);
        setDetail(old => old && { ...old, items: [...old.items.filter(existing => itemKey(existing) !== itemKey(saved)), saved] });
      }, "无法关联这项内容，来源可能已被移除。")}/>}
      {!detail.items.length && <p>还没有关联内容。历史记录不会自动加入项目。</p>}
      {detail.items.length > 0 && <ul className="projects-list">{detail.items.map(item => <li key={itemKey(item)}>
        <button type="button" className="projects-row" disabled={busy} onClick={() => onOpen(item)}><strong>{item.title}</strong><span>{projectKinds[item.kind]}</span></button>
        <ActionButton size="sm" disabled={busy} aria-label={`解除关联：${item.title}`} onClick={() => void mutate(async () => {
          await api.removeItem(detail.id, item);
          setDetail(old => old && { ...old, items: old.items.filter(existing => itemKey(existing) !== itemKey(item)) });
        }, "暂时无法解除关联，请重试。")}>解除关联</ActionButton>
      </li>)}</ul>}
    </section>}
  </section>;
}

export function ProjectsPage(props: Props) {
  return <ProjectView key={props.id ?? "list"} {...props}/>;
}
