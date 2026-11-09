import { useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySourceDetail } from "../../types";
import type { ChatAttachment } from "./types";
import { DocumentReviewCard } from "./DocumentReviewCard";
import { DEFAULT_REVIEW_BUDGET, type DocumentReviewJob, type DocumentReviewService, type ReviewBudget } from "./document-review-service";
import "./document-review.css";

type Props = { service: DocumentReviewService; conversationId?: number; source?: LibrarySourceDetail; attachments?: ChatAttachment[]; onContentChange?: (hasContent: boolean) => void };
type Scope = { service: DocumentReviewService; conversationId?: number; sourceKey: string };
const same = (left: Scope, right: Scope) => left.service === right.service && left.conversationId === right.conversationId && left.sourceKey === right.sourceKey;
const fields: { key: keyof ReviewBudget; label: string; max: number }[] = [
  { key: "calls", label: "调用次数上限", max: 256 }, { key: "input_tokens", label: "输入 token 上限", max: 2000000 },
  { key: "output_tokens", label: "输出 token 上限", max: 256000 }, { key: "active_seconds", label: "活动秒数上限", max: 14400 },
];

export function DocumentReviewPanel({ service, conversationId, source, attachments = [], onContentChange }: Props) {
  const sourceKey = source ? `${source.id}:${source.source_revision ?? "pending"}` : "chat";
  const scope = { service, conversationId, sourceKey };
  const latest = useRef(scope);
  latest.current = scope;
  const [store, setStore] = useState<{ scope: Scope; jobs: DocumentReviewJob[] }>({ scope, jobs: [] });
  const [epoch, setEpoch] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState("");
  const [budget, setBudget] = useState<ReviewBudget>({ ...DEFAULT_REVIEW_BUDGET });
  const inFlight = useRef<object | null>(null);
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const documents = source ? [{ key: `source:${source.id}`, title: source.title, source, attachment: undefined, characters: source.character_count }]
    : [...new Map(attachments.filter(item => item.kind === "document").map(attachment => [attachment.id, { key: attachment.id, title: attachment.original_filename, source: undefined, attachment, characters: attachment.metadata?.character_count }])).values()];
  const selected = documents.find(document => document.key === choice) ?? documents[0];
  const jobs = same(store.scope, scope) ? store.jobs : [];
  const merge = useCallback((incoming: DocumentReviewJob[], captured: Scope) => {
    if (!same(latest.current, captured)) return;
    setStore(previous => {
      const items = new Map((same(previous.scope, captured) ? previous.jobs : []).map(job => [job.id, job]));
      for (const job of incoming) if (!items.has(job.id) || items.get(job.id)!.revision <= job.revision) items.set(job.id, job);
      return { scope: captured, jobs: [...items.values()] };
    });
  }, []);
  useEffect(() => {
    inFlight.current = null; receipt.current = null; setBusy(false); setError("");
    setOpen(false); setChoice(""); setBudget({ ...DEFAULT_REVIEW_BUDGET });
  }, [service, conversationId, sourceKey]);
  useEffect(() => {
    const captured = { service, conversationId, sourceKey };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void refresh(), 1500); return; }
      try {
        const result = await service.list(conversationId, controller.signal);
        if (controller.signal.aborted) return;
        const items = result.jobs.filter(job => job.kind === "document.review" && (!source || (job.request.target.source_kind === "library" && job.request.target.source_id === source.id)));
        merge(items, captured);
        if (items.some(job => ["queued", "running"].includes(job.status))) timer = setTimeout(() => void refresh(), 1500);
      } catch (caught) {
        if (!controller.signal.aborted && same(latest.current, captured)) setError(caught instanceof Error ? caught.message : "审阅任务读取失败，请刷新重试");
      }
    }
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [service, conversationId, sourceKey, epoch, merge]);
  useEffect(() => { onContentChange?.(jobs.length > 0); }, [jobs.length, onContentChange]);
  const validBudget = fields.every(({ key, max }) => Number.isSafeInteger(budget[key]) && budget[key] >= 1 && budget[key] <= max);
  const alreadyActive = selected && jobs.some(job => ["queued", "running", "waiting_user"].includes(job.status) && (selected.source
    ? job.request.target.source_kind === "library" && job.request.target.source_id === selected.source.id && job.request.target.source_revision === selected.source.source_revision
    : job.request.target.source_kind === "attachment" && job.request.target.attachment_id === selected.attachment?.id));
  async function create() {
    if (!selected || !validBudget || inFlight.current) return;
    const captured = scope;
    const action = {};
    inFlight.current = action; setBusy(true); setError("");
    try {
      const target = selected.source ? { source_kind: "library" as const, source_id: selected.source.id, source_revision: selected.source.source_revision! } : await service.prepareAttachment(selected.attachment!.id);
      if (!same(latest.current, captured)) return;
      if (!target.source_revision) throw new Error("资料版本尚未就绪，请稍后刷新重试");
      const input = { target, budget, ...(conversationId === undefined ? {} : { conversation_id: conversationId }) };
      const fingerprint = JSON.stringify(input);
      if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, key: crypto.randomUUID() };
      const created = await service.create({ ...input, idempotency_key: receipt.current.key });
      if (same(latest.current, captured)) {
        merge([created], captured); receipt.current = null; setOpen(false); setEpoch(value => value + 1);
      }
    } catch (caught) {
      if (same(latest.current, captured)) setError(caught instanceof Error ? caught.message : "创建失败，请刷新任务后重试");
    } finally {
      if (inFlight.current === action) { inFlight.current = null; setBusy(false); }
    }
  }
  if (!documents.length && !jobs.length && !error) return null;
  const format = (value: number) => Number.isFinite(value) ? value.toLocaleString() : "待填写";
  return <section className="document-review-panel" aria-label="资料全文审阅">
    {documents.length ? <details className="document-review-create" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>全文审阅</summary>
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <p>按所选文件的当前版本逐批处理，保留已提交的结果。预算用完会暂停，追加后才继续。</p>
        <label>审阅文件<select value={selected?.key ?? ""} disabled={busy} onChange={event => setChoice(event.target.value)}>{documents.map(document => <option key={document.key} value={document.key}>{document.title}</option>)}</select></label>
        <p>本次上限：{format(budget.calls)} 次调用 · {format(budget.input_tokens)} 输入 token · {format(budget.output_tokens)} 输出 token · {format(budget.active_seconds)} 活动秒。</p>
        <p className="document-review-muted">{selected?.characters ? `预计至少 ${Math.ceil(selected.characters / 3600) + 1} 次调用，实际批次与汇总可能增加。` : "提取后分批处理，不一次发送全部正文。"} 缺失用量时保守预留，上限不代表费用承诺。</p>
        <details><summary>调整本次上限</summary><fieldset disabled={busy}><legend>本次预算</legend>{fields.map(({ key, label, max }) => <label key={key}>{label}<input type="number" min={1} max={max} step={1} value={Number.isFinite(budget[key]) ? budget[key] : ""} onChange={event => setBudget(current => ({ ...current, [key]: event.target.valueAsNumber }))} /></label>)}</fieldset></details>
        <button className="extension-button primary" type="submit" disabled={busy || !validBudget || Boolean(alreadyActive) || !selected}>{busy ? "正在准备…" : "开始全文审阅"}</button>
        {alreadyActive ? <p className="document-review-muted">所选资料已有进行中的审阅，请在下方查看或继续。</p> : null}
      </form>
    </details> : null}
    {error ? <p role="alert">{error}</p> : null}
    {jobs.length || error ? <button className="extension-button compact" type="button" disabled={busy} onClick={() => { setError(""); setEpoch(value => value + 1); }}>刷新审阅任务</button> : null}
    {jobs.map(job => <div key={job.id}>{source?.source_revision && job.request.target.source_revision !== source.source_revision ? <p className="document-review-muted">该审阅基于较早的资料版本。</p> : null}<DocumentReviewCard job={job} service={service} onChange={next => { merge([next], scope); setEpoch(value => value + 1); }} /></div>)}
  </section>;
}
