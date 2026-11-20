import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FileSliders, X } from "lucide-react";
import { isPresentationActive, PresentationJobCard } from "./PresentationJobCard";
import type { PresentationCapabilities, PresentationJob, PresentationService } from "./presentation-service";
import { presentationDrafts } from "./presentation-drafts";
import "./extensions.css";
import "./presentation-chat.css";

const briefExamples = [
  { label: "工作汇报", template: "面向【请填写汇报对象】，汇报【请填写项目或工作主题】，梳理实际进展、问题和下一步安排。", previous: "面向项目团队制作一份工作汇报，梳理已有进展、遇到的问题和下一步安排。" },
  { label: "项目提案", template: "面向【请填写客户或受众】，提出【请填写项目主题】的方案，说明需求、解决思路和预期目标。", previous: "面向客户制作一份项目提案，说明需求、解决方案、实施安排和预期目标。" },
  { label: "知识分享", template: "面向初学者介绍【请填写分享主题】，重点解释【请填写核心概念】，再给出应用场景与练习建议。", previous: "面向初学者制作一份知识分享，先解释核心概念，再给出应用场景与练习建议。" }
];

type Props = { service: PresentationService; conversationId: number; request: number; modelScope?: string; disabled?: boolean; hideStoredForm?: boolean; submittedJob?: PresentationJob; onReuseQuick?: (job: PresentationJob) => void; onOpenModelSettings: () => void; onContentChange?: (conversationId: number, hasContent: boolean) => void };
// The keyed inner component drops all draft, preview and request state on scope changes.
export function PresentationChat(props: Props) {
  return <ConversationPresentations key={props.conversationId} {...props} />;
}
function ConversationPresentations({ service, conversationId, request, modelScope, disabled, hideStoredForm, submittedJob, onReuseQuick, onOpenModelSettings, onContentChange }: Props) {
  const drafts = presentationDrafts(service);
  const initialDraft = useRef(drafts.get(conversationId));
  const [jobs, setJobs] = useState<PresentationJob[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [readError, setReadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [formOpen, setFormOpen] = useState(request > 0 || Boolean(initialDraft.current?.open));
  const formVisible = formOpen && !hideStoredForm;
  const [topic, setTopic] = useState(initialDraft.current?.topic ?? "");
  const [pages, setPages] = useState(initialDraft.current?.pages ?? 8);
  const [retryTarget, setRetryTarget] = useState(initialDraft.current?.retry);
  const [acknowledgeRetry, setAcknowledgeRetry] = useState(false);
  const [capabilities, setCapabilities] = useState<PresentationCapabilities | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const paging = useRef(false);
  const paginated = useRef(false);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const retryJob = jobs.find(job => job.id === retryTarget?.id);
  const retryBlocked = Boolean(retryTarget && retryJob && !["failed", "interrupted"].includes(retryJob.status));
  const key = useRef(initialDraft.current?.key ?? crypto.randomUUID());
  const pageHintId = useId();
  const topicHintId = useId();
  const validPages = Number.isInteger(pages) && pages >= 1 && pages <= 20;
  const incompleteBrief = /【请填写[^】]*】/.test(topic) || briefExamples.some(example => topic.trim() === example.previous);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!formOpen && !topic.trim()) drafts.delete(conversationId);
    else drafts.set(conversationId, { topic, pages, key: key.current, open: formOpen, retry: retryTarget });
  }, [drafts, conversationId, topic, pages, formOpen, retryTarget]);
  useEffect(() => { if (request > 0) setFormOpen(true); }, [request]);
  useEffect(() => {
    if (retryTarget && retryJob && ["failed", "interrupted"].includes(retryJob.status) && retryJob.revision > retryTarget.revision) {
      key.current = crypto.randomUUID();
      setRetryTarget({ id: retryJob.id, revision: retryJob.revision, uncertain: retryJob.retry_requires_confirmation ?? Boolean(retryJob.progress?.outcome_uncertain) });
      setAcknowledgeRetry(false);
    }
  }, [retryJob, retryTarget]);
  useEffect(() => { onContentChange?.(conversationId, formVisible || jobs.length > 0 || Boolean(readError)); }, [conversationId, formVisible, jobs.length, readError, onContentChange]);
  const merge = useCallback((incoming: PresentationJob[]) => {
    if (!mounted.current) return;
    setJobs(previous => {
      const values = new Map(previous.map(job => [job.id, job]));
      for (const next of incoming) {
        if (next.conversation_id !== conversationId) continue;
        const old = values.get(next.id);
        if (!old || next.revision >= old.revision) values.set(next.id, next);
      }
      return [...values.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
    });
  }, [conversationId]);
  useEffect(() => {
    if (submittedJob?.conversation_id === conversationId) { merge([submittedJob]); setRefresh(value => value + 1); }
  }, [submittedJob, conversationId, merge]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let receivedActive = false;
      try {
        const result = await service.list(conversationId, controller.signal, undefined);
        if (controller.signal.aborted) return;
        merge(result.jobs); setReadError("");
        receivedActive = result.jobs.some(isPresentationActive);
        if (!paginated.current) setNextCursor(result.next_cursor);
        const seen = new Set(result.jobs.map(job => job.id));
        const olderActive = jobsRef.current.filter(job => !seen.has(job.id) && isPresentationActive(job));
        const updates = await Promise.all(olderActive.map(job => service.get(job.id, controller.signal)));
        receivedActive ||= updates.some(isPresentationActive);
        if (!controller.signal.aborted) merge(updates);
      } catch (caught) {
        if (!controller.signal.aborted) setReadError(caught instanceof Error ? caught.message : "PPT 任务读取失败，请重试。");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), receivedActive || jobsRef.current.some(isPresentationActive) ? 2000 : 10000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [service, conversationId, merge, refresh]);
  useEffect(() => {
    if (!formVisible) return;
    const controller = new AbortController();
    setChecking(true); setCapabilities(null); setError("");
    void service.capabilities(controller.signal, conversationId).then(result => { if (!controller.signal.aborted) setCapabilities(result); })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "制作环境检查失败，请重试。"); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [service, conversationId, modelScope, formVisible, checkRevision]);
  useEffect(() => { if (formVisible) formRef.current?.scrollIntoView?.({ block: "nearest" }); }, [formVisible]);
  function recreate(job: PresentationJob) {
    if (job.kind === "ppt.quick_generate") { onReuseQuick?.(job); return; }
    setTopic(job.topic || ""); setPages(job.page_count || 8); key.current = crypto.randomUUID(); setFormOpen(true); setError("");
    setRetryTarget(["failed", "interrupted"].includes(job.status) ? { id: job.id, revision: job.revision, uncertain: job.retry_requires_confirmation ?? Boolean(job.progress?.outcome_uncertain) } : undefined);
    setAcknowledgeRetry(false);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || disabled || checking || !capabilities?.available || !topic.trim() || incompleteBrief || !Number.isInteger(pages) || pages < 1 || pages > 20) return;
    if (retryBlocked || retryTarget?.uncertain && !acknowledgeRetry) return;
    submitting.current = true; setBusy(true); setError("");
    const submittedKey = key.current;
    try {
      const next = retryTarget ? await service.retry(retryTarget.id, { expected_revision: retryTarget.revision, request_id: submittedKey, topic: topic.trim(), page_count: pages, ...(acknowledgeRetry ? { acknowledge_uncertain: true } : {}) }) : await service.create(topic.trim(), pages, submittedKey, conversationId);
      if (drafts.get(conversationId)?.key === submittedKey) drafts.delete(conversationId);
      if (mounted.current) {
        merge([next]); setRefresh(value => value + 1);
        if (key.current === submittedKey) { setFormOpen(false); setTopic(""); setPages(8); setRetryTarget(undefined); setAcknowledgeRetry(false); key.current = crypto.randomUUID(); }
      }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "制作提交失败，请重试。"); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  async function loadMore() {
    if (!nextCursor || paging.current) return;
    paging.current = true; setLoadingMore(true);
    try {
      const result = await service.list(conversationId, undefined, nextCursor);
      if (mounted.current) { paginated.current = true; merge(result.jobs); setNextCursor(result.next_cursor); setReadError(""); }
    } catch (caught) { if (mounted.current) setReadError(caught instanceof Error ? caught.message : "较早任务读取失败，请重试。"); }
    finally { paging.current = false; if (mounted.current) setLoadingMore(false); }
  }
  return <section className="ppt-chat-feed" aria-label="本会话的 PPT 制作">
    {readError ? <div className="ppt-read-error" role="alert"><p>PPT 任务暂时无法读取：{readError}</p><button className="extension-button" type="button" onClick={() => setRefresh(value => value + 1)}>重新读取任务</button></div> : null}
    {nextCursor ? <button type="button" className="ppt-older-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "查看更早的 PPT"}</button> : null}
    {jobs.map(job => <PresentationJobCard key={job.id} job={job} service={service} onChange={next => merge([next])} onRecreate={recreate} onOpenModelSettings={onOpenModelSettings} />)}
    {formVisible ? <form className="ppt-chat-form" aria-label="PPT 制作要求" onSubmit={event => void create(event)} ref={formRef}>
      <header><div><FileSliders size={21} aria-hidden="true" /><h3>一起完成这份演示文稿</h3></div><button type="button" aria-label="收起制作要求" className="ppt-refresh-button" disabled={busy} onClick={() => setFormOpen(false)}><X size={17} /></button></header>
      <p>{retryTarget ? "将在原任务中重试。修改主题或页数后会重新确认需求与设计，之前的制作记录保留。" : "先说清楚内容与目标。内容方向和设计方案都会交由你确认。"}</p>
      <ol className="ppt-brief-steps" aria-label="制作流程"><li>填写要求</li><li>确认需求与设计</li><li>预览和下载</li></ol>
      <label>演示主题与要求<textarea autoFocus required disabled={busy} rows={4} maxLength={8000} value={topic} aria-invalid={incompleteBrief || undefined} aria-describedby={topicHintId} onChange={event => { setTopic(event.target.value); key.current = crypto.randomUUID(); }} placeholder="例如：面向初学者介绍大语言模型，解释基本原理、实际应用与练习建议。" /></label>
      <p id={topicHintId} className={incompleteBrief ? "ppt-card-error" : "ppt-draft-note"} role={incompleteBrief ? "alert" : undefined}>{incompleteBrief ? "请补充具体的演示主题和核心要点，并替换所有“【请填写…】”。示例只提供结构，补充后才能开始制作。" : "请写明具体主题与核心内容；提供已有要点或资料，可以让内容更准确。"}</p>
      {!topic.trim() ? <div className="ppt-brief-examples" aria-label="用途示例">{briefExamples.map(example => <button type="button" key={example.label} disabled={busy} onClick={() => { setTopic(example.template); key.current = crypto.randomUUID(); }}>{example.label}</button>)}</div> : null}
      <div className="ppt-form-options"><div className="ppt-page-setting"><label>建议页数<input required type="number" min={1} max={20} step={1} aria-invalid={!validPages || undefined} aria-describedby={pageHintId} disabled={busy} value={pages || ""} onChange={event => { setPages(Number(event.target.value)); key.current = crypto.randomUUID(); }} /></label><small id={pageHintId} role={!validPages ? "alert" : undefined}>{validPages ? "1–20 页，确认时还可调整" : "请输入 1–20 之间的整数页数"}</small></div><p>{capabilities?.model_name ? `制作模型：${capabilities.model_name}` : "使用当前会话的文本模型"}<button type="button" onClick={onOpenModelSettings}>模型设置</button></p></div>
      <p role="status" className="ppt-check-status">{checking ? "正在检查制作条件，你可以先填写要求…" : capabilities?.reason}</p>
      {error ? <p className="ppt-card-error" role="alert">{error}</p> : null}
      {retryBlocked ? <p className="ppt-card-error" role="alert">原任务状态已更新，请查看卡片中的制作进度。当前修改已保留。</p> : null}
      {retryTarget?.uncertain ? <label className="ppt-card-guidance"><input type="checkbox" checked={acknowledgeRetry} disabled={busy} onChange={event => setAcknowledgeRetry(event.target.checked)} />我已核对上次请求，确认重试可能重复调用模型并产生费用。</label> : null}
      <div className="ppt-card-actions"><button className="extension-button primary" type="submit" disabled={busy || disabled || checking || !capabilities?.available || !topic.trim() || incompleteBrief || !validPages || retryBlocked || Boolean(retryTarget?.uncertain && !acknowledgeRetry)}>{busy ? "正在提交…" : retryTarget ? "保存并重试" : "开始制作"}</button>{!checking && (!capabilities?.available || error) ? <button type="button" className="extension-button" onClick={() => setCheckRevision(value => value + 1)}>重新检查</button> : null}<span>中文 · 16:9</span></div>
      <p className="ppt-draft-note">切换会话或查看模型设置后，可继续编辑草稿。</p>
    </form> : null}
  </section>;
}
