import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import type { FetchCreationJson } from "./creationRecordsApi";
import "./GlobalSearch.css";

const labels = {
  chat: "对话", image: "图片记录", document: "文档", presentation: "PPT",
  project: "项目", image_work: "图片作品", final_work: "文档 / PPT 定稿", knowledge: "知识资料",
};
export type SearchHit = { kind: keyof typeof labels; id: string; title: string; updated_at: string; conversation_id: number | null; status: string | null };
type Page = { items: SearchHit[]; has_more: boolean };
const limit = 24;

export function GlobalSearch({ fetchJson, onClose, onOpen }: {
  fetchJson: FetchCreationJson; onClose: () => void; onOpen: (hit: SearchHit) => void;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState("");
  const [request, setRequest] = useState<{ q: string; kind: string; offset: number }>();
  const [result, setResult] = useState<{ client: FetchCreationJson; request: typeof request; page?: Page }>();
  const current = result && result.client === fetchJson && result.request === request ? result : undefined;
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: request.q, limit: String(limit), offset: String(request.offset) });
    if (request.kind) params.set("kind", request.kind);
    fetchJson<Page>(`/search?${params}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, request, page });
    }, () => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, request });
    });
    return () => controller.abort();
  }, [fetchJson, request]);

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="global-search" backdropClassName="global-search-backdrop">
      <header>
        <div><DialogTitle>全局搜索</DialogTitle><DialogDescription>按关键词查找创作记录、项目、作品和知识资料。</DialogDescription></div>
        <DialogClose className="ui-button ui-button-secondary ui-button-sm">关闭</DialogClose>
      </header>
      <form onSubmit={event => {
        event.preventDefault();
        if (draft.trim()) setRequest({ q: draft.trim(), kind, offset: 0 });
      }}>
        <label>关键词<input aria-label="关键词" value={draft} onChange={event => setDraft(event.target.value)} maxLength={120} placeholder="输入标题或关键词" autoFocus /></label>
        <label>类型<select aria-label="搜索类型" value={kind} onChange={event => setKind(event.target.value)}>
          <option value="">全部</option>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <ActionButton type="submit" disabled={!draft.trim()}><Search size={16} aria-hidden="true" />搜索</ActionButton>
      </form>
      {request && (!current ? <p role="status">正在搜索…</p> : !current.page ? <div><p role="alert">暂时无法搜索，请重试。</p>
        <ActionButton size="sm" onClick={() => setRequest({ ...request })}>重新搜索</ActionButton></div>
        : <>
          {current.page.items.length ? <ul>{current.page.items.map(hit => <li key={`${hit.kind}:${hit.id}`}>
            <ActionButton onClick={() => onOpen(hit)}><strong>{hit.title}</strong><small>{labels[hit.kind]}</small></ActionButton>
          </li>)}</ul> : <p role="status">没有找到匹配的内容。</p>}
          {(request.offset > 0 || current.page.has_more) && <nav aria-label="搜索结果分页">
            <ActionButton size="sm" disabled={!request.offset} onClick={() => setRequest({ ...request, offset: Math.max(0, request.offset - limit) })}>上一页</ActionButton>
            <span>第 {request.offset / limit + 1} 页</span>
            <ActionButton size="sm" disabled={!current.page.has_more} onClick={() => setRequest({ ...request, offset: request.offset + limit })}>下一页</ActionButton>
          </nav>}
        </>)}
    </DialogContent>
  </Dialog>;
}
