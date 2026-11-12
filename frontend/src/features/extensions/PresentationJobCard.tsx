import { useEffect, useRef, useState } from "react";
import { Check, Download, FileSliders, LoaderCircle, RotateCcw, Square } from "lucide-react";
import type { FileArtifact } from "./activity-service";
import type { PresentationJob, PresentationService } from "./presentation-service";
import { currentPresentationArtifacts } from "./presentation-service";
import { PreviewDialog } from "./PreviewDialog";
import { PresentationPageImage as PageImage } from "./PresentationPageImage";
import { PresentationPreview } from "./PresentationPreview";

const steps = ["整理资料", "需求确认", "设计确认", "页面与讲稿", "导出预览"];
export const isPresentationActive = (job: PresentationJob) => ["queued", "running", "waiting_user"].includes(job.status);
function phase(job: PresentationJob) {
  if (job.status === "succeeded") return 5;
  if (["notes_ready", "delivery_ready"].includes(job.stage)) return 4;
  if (["final_confirmed", "spec_ready", "quality_repairing", "pages_ready"].includes(job.stage) || /^page_\d+_ready$/.test(job.stage)) return 3;
  if (["stage1_confirmed", "stage2_recommended"].includes(job.stage)) return 2;
  return job.stage === "stage1_recommended" ? 1 : 0;
}
function failedStageLabel(job: PresentationJob) {
  const stage = job.error_stage;
  if (!stage) return steps[Math.min(phase(job), 4)];
  if (stage === "stage1") return "整理资料";
  if (stage === "stage2") return "拟定设计方案";
  if (stage === "design_spec") return "编写设计规格";
  if (["design_spec_audit", "spec_lock", "spec_lock_audit"].includes(stage)) return "设计合同校验";
  if (/^page\./.test(stage)) return "页面编排";
  if (stage === "speaker_notes") return "讲稿编写";
  return steps[Math.min(phase(job), 4)];
}
function description(job: PresentationJob) {
  if (job.cancel_requested) return "正在停止制作，请稍候。";
  if (job.status === "succeeded") return "演示文稿已制作完成，可查看逐页预览或下载可编辑文件。";
  if (job.status === "failed") return `失败阶段：${failedStageLabel(job)}。原要求已保留。`;
  if (job.status === "cancelled") return "任务已停止，原要求已保留，可以编辑后重新制作。";
  if (job.status === "interrupted") return "制作已中断。恢复前会核对原任务状态，不能安全恢复时请编辑后重做。";
  if (job.confirmation_required) return job.stage === "stage1_recommended" ? "请审核内容方向和需求，提交确认后继续拟定设计方案。" : "请审核设计方案与制作参数，提交确认后开始编排页面。";
  const match = /^page_(\d+)_ready$/.exec(job.stage);
  if (match) return `已编排 ${match[1]} 页，正在继续制作。`;
  return ["正在分析主题并整理内容结构，完成后需要你确认需求。", "正在准备需求确认。", "正在拟定设计方案，完成后需要你确认设计。", "正在编排页面、检查版式并编写讲稿。", "正在导出可编辑 PPTX 并生成逐页预览。 "][Math.min(phase(job), 4)];
}

function requestStart(value: string | null | undefined) {
  if (!value) return NaN;
  // SQLite records are UTC even though they omit an explicit timezone.
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
}
function elapsedTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours} 小时 ` : ""}${hours || minutes ? `${minutes} 分 ` : ""}${seconds % 60} 秒`;
}

export function PresentationJobCard({ job, service, onChange, onRecreate, onOpenModelSettings }: {
  job: PresentationJob; service: PresentationService; onChange: (job: PresentationJob) => void;
  onRecreate: (job: PresentationJob) => void; onOpenModelSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [opened, setOpened] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const retryKey = useRef(crypto.randomUUID());
  const [expanded, setExpanded] = useState(false);
  const [previewPage, setPreviewPage] = useState<string>();
  const [artifacts, setArtifacts] = useState<FileArtifact[]>([]);
  const [artifactError, setArtifactError] = useState("");
  const [artifactAttempt, setArtifactAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const startedAt = requestStart(job.progress?.started_at);
  useEffect(() => {
    setNow(Date.now());
    if (job.status !== "running" || !Number.isFinite(startedAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.id, job.status, startedAt]);
  const mounted = useRef(true);
  const operating = useRef(false);
  const latest = useRef(job); latest.current = job;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setConfirmation(""); setOpened(false); }, [job.stage, job.confirmation_required, job.status]);
  useEffect(() => { setConfirmRetry(false); retryKey.current = crypto.randomUUID(); }, [job.id, job.revision]);
  useEffect(() => {
    if (job.status !== "succeeded") { setArtifacts([]); setExpanded(false); return; }
    const controller = new AbortController();
    setArtifactError("");
    void service.activity.artifacts(job.id, controller.signal).then(result => {
      if (!controller.signal.aborted) { const current = currentPresentationArtifacts(job, result.artifacts); setArtifacts(current); if (!current.length) setArtifactError("暂未读取到成果，请重新读取。"); }
    }).catch(() => { if (!controller.signal.aborted) setArtifactError("成果读取失败，请重试。制作任务不会重新运行。"); });
    return () => controller.abort();
  }, [job.id, job.status, job.revision, service, artifactAttempt]);
  async function operate(action: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "操作失败，请重试。"); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  const active = isPresentationActive(job);
  const retryable = job.retryable ?? ["failed", "interrupted"].includes(job.status);
  const uncertainRetry = job.retry_requires_confirmation ?? Boolean(job.progress?.outcome_uncertain);
  function retry(acknowledgeUncertain = false) {
    void operate(async () => {
      const next = await service.retry(job.id, { expected_revision: job.revision, request_id: retryKey.current, ...(acknowledgeUncertain ? { acknowledge_uncertain: true } : {}) });
      if (mounted.current) { setConfirmRetry(false); onChange(next); }
    });
  }
  const activity = job.status === "running" ? job.progress?.activity : null;
  const elapsed = job.status === "running" && Number.isFinite(startedAt) && now >= startedAt ? Math.floor((now - startedAt) / 1000) : null;
  const completed = job.progress?.pages_completed;
  const total = job.progress?.pages_total;
  const connectionFailure = job.status === "failed" && job.error_code === "service_unavailable";
  const currentPhase = phase(job);
  const fullTopic = job.topic || "演示文稿";
  const firstLine = fullTopic.trim().split(/\r?\n/)[0];
  const title = [...firstLine].length > 64 ? `${[...firstLine].slice(0, 64).join("")}…` : firstLine;
  const previews = artifacts.filter(item => /^P\d{2}\.png$/.test(item.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
  const pptx = artifacts.find(item => item.filename.toLowerCase().endsWith(".pptx"));
  const progress = <ol className="ppt-stage-list" aria-label="制作阶段">{steps.map((step, index) => <li key={step} className={index < currentPhase ? "done" : index === currentPhase ? "current" : ""} aria-current={index === currentPhase ? "step" : undefined}><span aria-hidden="true">{index < currentPhase ? <Check size={12} /> : index + 1}</span>{step}</li>)}</ol>;
  const status = job.status === "failed" ? "制作失败" : job.status === "cancelled" ? "制作已取消" : job.status === "interrupted" ? "制作已中断" : job.status === "succeeded" ? "制作完成" : job.cancel_requested ? "正在取消" : job.confirmation_required ? "需要你确认" : job.status === "queued" ? "等待开始" : "正在制作";
  return <article className={`ppt-chat-card is-${job.status}`} aria-label={`PPT：${title}`}>
    <header className="ppt-card-heading"><FileSliders size={22} aria-hidden="true" /><div><h3>{title}</h3><p>{job.status === "succeeded" && previews.length ? `${previews.length} 页` : `建议 ${job.page_count ?? 8} 页`} · 16:9{job.model_name ? ` · ${job.model_name}` : ""}</p></div><span className="ppt-card-status">{active && !job.confirmation_required ? <LoaderCircle size={14} className="extension-spinning" aria-hidden="true" /> : null}{status}</span></header>
    {title !== fullTopic ? <details className="ppt-original-brief"><summary>查看制作要求</summary><p>{fullTopic}</p></details> : null}
    {active ? progress : null}
    <p className="ppt-card-description" role="status">{description(job)}</p>
    {activity || elapsed !== null || (completed !== undefined && completed > 0) ? <div className="ppt-card-progress" aria-label="制作进度">
      {activity ? <p className="ppt-current-activity" role="status">{activity}</p> : null}
      {elapsed !== null ? <p className="ppt-request-wait">本次请求已等待 {elapsedTime(elapsed)}</p> : null}
      {completed !== undefined && completed > 0 ? <p className="ppt-pages-completed">已完成 {completed} 页<span> · {total === null || total === undefined ? "总页数待确认" : `共 ${total} 页`}</span></p> : null}
    </div> : null}
    {job.error ? <p className="ppt-card-error" role="alert">{connectionFailure ? "当次模型调用连接失败。可检查模型设置后，在原任务中重试。" : job.error}</p> : null}
    {["failed", "interrupted"].includes(job.status) && job.progress?.outcome_uncertain ? <p className="ppt-card-guidance">当次请求结果待核对，系统不会自动重复请求。请先核对原任务与模型调用记录，再决定是否重做。</p> : null}
    {error ? <p className="ppt-card-error" role="alert">{error}</p> : null}
    {confirmRetry ? <div className="ppt-card-error" role="alert"><p>上次请求的结果尚未确认，重试可能重复调用模型并产生费用。确认后将在原任务继续。</p><button type="button" className="extension-button" disabled={busy} onClick={() => retry(true)}>确认重试</button><button type="button" className="extension-button" disabled={busy} onClick={() => setConfirmRetry(false)}>取消重试</button></div> : null}
    {opened ? <p role="status" className="ppt-card-description">确认窗口已打开，请在窗口中审核并提交。提交后将自动继续。</p> : null}
    {artifactError ? <div className="ppt-card-error" role="alert"><p>{artifactError}</p><button className="extension-button" type="button" onClick={() => setArtifactAttempt(value => value + 1)}>重新读取成果</button></div> : null}
    <div className="ppt-card-actions">
      {job.confirmation_required && active && !job.cancel_requested ? <button type="button" className="extension-button primary" disabled={busy} onClick={() => void operate(async () => {
        // Keep this call in the click stack so cross-origin popups retain user activation.
        const url = await service.confirmation(job.id);
        if (mounted.current && latest.current.stage === job.stage && latest.current.confirmation_required && !latest.current.cancel_requested) { setConfirmation(url); setOpened(!url); }
      })}>{job.stage === "stage1_recommended" ? "确认需求" : "确认设计"}</button> : null}
      {job.status === "succeeded" && pptx ? <button type="button" className="extension-button primary" disabled={busy} onClick={() => void operate(() => service.activity.download(pptx))}><Download size={15} />下载 PPTX</button> : null}
      {previews.length ? <button className="extension-button" type="button" onClick={() => setExpanded(true)}>查看逐页预览</button> : null}
      {job.error_code && ["authentication_failed", "model_unavailable", "protocol_unsupported", "service_unavailable"].includes(job.error_code) ? <button type="button" className="extension-button" onClick={onOpenModelSettings}>检查模型设置</button> : null}
      {retryable ? <button type="button" className="extension-button primary" disabled={busy} onClick={() => uncertainRetry ? setConfirmRetry(true) : retry()}><RotateCcw size={14} />重试制作</button> : null}
      {!active ? <button type="button" className="extension-button" disabled={busy} onClick={() => onRecreate(job)}>{job.status === "succeeded" ? "以此要求新建" : "编辑要求后重做"}</button> : null}
      {active ? <button type="button" className="extension-button" disabled={busy || job.cancel_requested} onClick={() => void operate(async () => { const next = await service.cancel(job.id); if (mounted.current) onChange(next); })}><Square size={13} />{job.cancel_requested ? "正在取消…" : "取消制作"}</button> : null}
      <button className="ppt-refresh-button" type="button" disabled={busy} onClick={() => void operate(async () => { const next = await service.get(job.id); if (mounted.current) onChange(next); })}>刷新状态</button>
    </div>
    {!active ? <p className="ppt-card-guidance">刷新只会更新状态，不会重新制作。{job.status === "succeeded" ? "以此要求新建将创建新任务。" : retryable ? "重试与编辑要求都在原任务继续；未修改要求时保留已确认内容和已完成页面。" : "编辑要求后可重新制作。"}</p> : null}
    {job.status === "succeeded" && previews[0] ? <div className="ppt-card-cover"><PageImage key={`${previews[0].id}:${previews[0].version}`} service={service} artifact={previews[0]} page={1} onOpen={() => { setPreviewPage(`${previews[0].id}:${previews[0].version}`); setExpanded(true); }} /><span>{previews.length} 页预览已就绪</span></div> : null}
    {!active ? <details className="ppt-stage-history"><summary>查看制作过程</summary>{progress}</details> : null}
    {confirmation ? <PreviewDialog title="PPT 确认" wide onClose={() => setConfirmation("")}><iframe className="presentation-confirmation-frame" title={`PPT ${job.stage === "stage1_recommended" ? "需求" : "设计"}确认`} src={confirmation} referrerPolicy="no-referrer" /></PreviewDialog> : null}
    {expanded && previews.length ? <PresentationPreview service={service} previews={previews} initialPage={previewPage} onSelectPage={setPreviewPage} busy={busy} error={error} onClose={() => setExpanded(false)} onDownload={pptx ? () => void operate(() => service.activity.download(pptx)) : undefined} /> : null}
  </article>;
}
