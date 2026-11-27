import { useContext, useEffect, useRef, useState } from "react";
import { MarkdownContent } from "./ChatMarkdown";
import { LocalCitation, LocalCitationContext } from "./LocalCitation";
import { DEFAULT_REVIEW_BUDGET, type DocumentReviewJob, type DocumentReviewService, type ReviewBudget } from "./document-review-service";
import "./document-review.css";

const statusLabels = { queued: "等待开始", running: "正在审阅", waiting_user: "审阅已暂停", cancelled: "审阅已取消", interrupted: "审阅已中断", failed: "审阅失败", succeeded: "审阅结束，覆盖不完整" };
const budgetFields: { key: keyof ReviewBudget; label: string; max: number }[] = [
  { key: "calls", label: "追加调用次数", max: 256 },
  { key: "input_tokens", label: "追加输入 token", max: 2000000 },
  { key: "output_tokens", label: "追加输出 token", max: 256000 },
  { key: "active_seconds", label: "追加活动秒数", max: 14400 },
];

export function DocumentReviewCard({ job, service, onChange }: { job: DocumentReviewJob; service: DocumentReviewService; onChange: (job: DocumentReviewJob) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [addition, setAddition] = useState<ReviewBudget>({ ...DEFAULT_REVIEW_BUDGET });
  const latest = useRef(job);
  latest.current = job;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setAddition({ ...DEFAULT_REVIEW_BUDGET }); setError(""); }, [job.id, job.stage_id]);
  const result = job.result ?? job.checkpoint?.review;
  const citationLoaders = useContext(LocalCitationContext);
  const evidence = [...new Map((result?.local_evidence ?? []).map(item => [item.citation_id, item])).values()];
  const coverage = result?.coverage;
  const complete = job.status === "succeeded" && coverage?.status === "complete" && coverage.extraction_complete
    && coverage.total_blocks > 0 && coverage.completed_blocks === coverage.total_blocks && coverage.failed_blocks === 0 && coverage.unprocessed_ranges.length === 0;
  const uncertain = job.checkpoint?.external_outcome === "unknown";
  const waitingBudget = job.status === "waiting_user" && !uncertain && job.checkpoint?.budget_exhausted && !!job.stage_id;
  const active = ["queued", "running", "waiting_user", "interrupted"].includes(job.status);
  const validBudget = budgetFields.every(({ key, max }) => Number.isSafeInteger(addition[key]) && addition[key] >= 1 && addition[key] <= max);
  const format = (value: number) => Number.isFinite(value) ? value.toLocaleString() : "待填写";
  async function operate(operation: () => Promise<DocumentReviewJob>) {
    if (inFlight.current) return;
    const original = job;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const next = await operation();
      if (mounted.current && latest.current.id === next.id && next.revision >= latest.current.revision) onChange(next);
    } catch (caught) {
      if (mounted.current && latest.current.id === original.id && latest.current.revision === original.revision) setError(caught instanceof Error ? caught.message : "操作未完成，请刷新任务后重试");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <article className="document-review-card" aria-label={`全文审阅：${job.source_title || "所选资料"}`}>
    <header><h3>{job.source_title || "全文审阅"}</h3><span role="status">{active && job.cancel_requested ? "正在取消…" : complete ? "全文审阅完成" : statusLabels[job.status]}</span></header>
    {coverage ? <div className="document-review-progress">
      <p>已审阅 {coverage.completed_blocks} 块 · 共 {coverage.total_blocks} 块{coverage.failed_blocks ? ` · ${coverage.failed_blocks} 块失败` : ""}</p>
      {coverage.total_blocks > 0 ? <progress aria-label="已完成模型审阅的正文块" max={coverage.total_blocks} value={Math.min(coverage.completed_blocks, coverage.total_blocks)} /> : null}
      {!coverage.extraction_complete || coverage.unprocessed_ranges.length ? <p>{coverage.unprocessed_ranges.some(range => range.reason === "original_not_verified") ? "原件范围未核实，当前结果仅覆盖已保存正文。" : "部分页面缺少可提取文字或 OCR，当前结果不能代表完整原文。"}</p> : null}
    </div> : <p className="document-review-muted">准备读取固定版本，读取本身不计为已完成审阅。</p>}
    {job.model_budget ? <p className="document-review-muted">模型调用 {job.model_budget.calls_used} / {job.model_budget.calls_limit} · 活动时间 {Math.ceil(job.model_budget.active_seconds)} / {job.model_budget.active_seconds_limit} 秒</p> : null}
    {result?.summary ? <section className="document-review-result" aria-label={complete ? "审阅结果" : "已提交的部分结果"}><MarkdownContent localEvidence={result.local_evidence}>{result.summary}</MarkdownContent></section> : null}
    {citationLoaders && evidence.length ? <div className="document-review-actions" role="group" aria-label="审阅来源">{evidence.map(item => <LocalCitation key={item.citation_id} evidence={item} loaders={citationLoaders} />)}</div> : null}
    {uncertain ? <p className="document-review-muted">模型请求结果待核对，系统不会自动重复调用。请保留当前结果并核对调用记录。</p> : null}
    {waitingBudget ? <div className="document-review-budget">
      <p>{job.prompt || "本次预算已用完，追加后继续未完成的部分。"}</p>
      <p>追加上限：{format(addition.calls)} 次调用 · {format(addition.input_tokens)} 输入 token · {format(addition.output_tokens)} 输出 token · {format(addition.active_seconds)} 活动秒。缺失用量时按保守预留计入，上限不代表费用承诺。</p>
      <details><summary>调整追加上限</summary><fieldset disabled={busy}><legend>本次追加预算</legend>{budgetFields.map(({ key, label, max }) => <label key={key}>{label}<input type="number" inputMode="numeric" min={1} max={max} step={1} value={Number.isFinite(addition[key]) ? addition[key] : ""} onChange={event => setAddition(current => ({ ...current, [key]: event.target.valueAsNumber }))} /></label>)}</fieldset></details>
      <button className="extension-button primary" type="button" disabled={busy || !validBudget || job.cancel_requested} onClick={() => void operate(() => service.confirm(job.id, job.stage_id!, job.revision, { budget: addition, idempotency_key: `document-review-budget:${job.id}:${job.stage_id}:${job.revision}` }))}>追加预算并继续</button>
    </div> : null}
    {error || job.error ? <p role="alert">{error || job.error}</p> : null}
    <div className="document-review-actions">
      {active ? <button className="extension-button" type="button" disabled={busy || job.cancel_requested} onClick={() => void operate(() => service.cancel(job.id))}>取消审阅</button> : null}
      {job.status === "interrupted" && !uncertain ? <button className="extension-button" type="button" disabled={busy || job.cancel_requested} onClick={() => void operate(() => service.resume(job.id))}>恢复审阅</button> : null}
    </div>
  </article>;
}
