import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Download, LoaderCircle, RefreshCw, Server, Square, TriangleAlert } from "lucide-react";
import type { ActivityService, BackgroundJob, ExecutionStatus, FileArtifact, JobEvent } from "./activity-service";

const labels: Record<string, string> = { queued: "排队中", running: "执行中", waiting_user: "等待确认", succeeded: "已完成", failed: "执行失败", cancelled: "已取消", interrupted: "已中断", confirmed: "已收到确认", resumed: "已请求恢复", cancel_requested: "正在停止", artifact_published: "成果已保存" };
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "waiting_user"]);

export function ExecutionActivity({ service }: { service: ActivityService }) {
  const [environment, setEnvironment] = useState<ExecutionStatus | null>(null);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackgroundJob | null>(null);
  const [files, setFiles] = useState<FileArtifact[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void Promise.all([service.environment(controller.signal), service.list(controller.signal)]).then(([status, result]) => {
      if (controller.signal.aborted) return;
      setEnvironment(status); setJobs(result.jobs); setError("");
    }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "任务读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [service, epoch]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null); setFiles([]); setEvents([]);
    async function refresh() {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void refresh(), 1500); return; }
      try {
        const [job, artifacts, history] = await Promise.all([service.get(selectedId!, controller.signal), service.artifacts(selectedId!, controller.signal), service.events(selectedId!, controller.signal)]);
        if (controller.signal.aborted) return;
        setDetail(job); setFiles(artifacts.artifacts); setEvents(history.events);
        setJobs(current => current.map(item => item.id === job.id ? job : item));
        if (!terminal.has(job.status)) timer = setTimeout(() => void refresh(), 1500);
      } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "任务详情读取失败"); }
    }
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [selectedId, service, epoch]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await operation(); setEpoch(value => value + 1); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作未完成，请刷新后重试"); }
    finally { setBusy(false); }
  }
  const schema = detail?.answer_schema;
  const supportsApproval = schema?.properties?.approved?.type === "boolean"
    && (schema.type === undefined || schema.type === "object")
    && (schema.required || []).every(key => key === "approved")
    && Object.keys(schema).every(key => ["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key))
    && Object.keys(schema.properties.approved).every(key => ["type", "title", "description", "default"].includes(key));
  return <section className="execution-activity" aria-label="执行环境与后台任务">
    <header className="execution-activity-header"><div><h2>执行环境与后台任务</h2><p className="extension-muted">任务状态与成果按账号保存，关闭页面不会取消任务。</p></div><button className="extension-button compact" type="button" disabled={loading || busy} onClick={() => setEpoch(value => value + 1)}><RefreshCw size={14} />刷新</button></header>
    {loading ? <p role="status" className="extension-muted">正在读取执行状态…</p> : null}
    {environment ? <div className={`execution-status ${environment.available ? "ready" : "unavailable"}`}>{environment.available ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}<div><strong>{environment.available ? "隔离环境已就绪" : "执行环境未就绪"}</strong><p>{environment.reason}</p><small>环境就绪与具体工作流可用状态分别检查。</small></div></div> : null}
    {error ? <p className="extension-error" role="alert">{error}</p> : null}
    {!loading && !error && !jobs.length ? <div className="execution-empty"><Server size={22} /><p>暂无后台任务</p><small>工作流接通后，任务进度、确认和文件成果会显示在这里。</small></div> : null}
    <div className="execution-jobs">{jobs.map(job => <button type="button" key={job.id} className={`execution-job-row${selectedId === job.id ? " selected" : ""}`} aria-pressed={selectedId === job.id} onClick={() => { setSelectedId(job.id); setError(""); }}><span><strong>{typeof job.request.topic === "string" ? job.request.topic : job.kind}</strong><small>{job.kind}</small></span><span>{labels[job.cancel_requested && ["queued", "running", "waiting_user", "interrupted"].includes(job.status) ? "cancel_requested" : job.status]}</span><ChevronRight size={15} /></button>)}</div>
    {detail ? <div className="execution-job-detail" aria-label="任务详情"><div className="execution-job-status" role="status"><strong>{labels[detail.cancel_requested && !["succeeded", "failed", "cancelled"].includes(detail.status) ? "cancel_requested" : detail.status]}</strong>{detail.error ? <p>{detail.error}</p> : null}</div>
      {detail.status === "waiting_user" ? <div className="execution-confirmation"><h3>需要你的确认</h3><p>{detail.prompt}</p>{supportsApproval && detail.stage_id ? <div className="extension-actions"><button className="extension-button" type="button" disabled={busy} onClick={() => void action(() => service.confirm(detail.id, detail.stage_id!, detail.revision, { approved: false }))}>暂不继续</button><button className="extension-button primary" type="button" disabled={busy} onClick={() => void action(() => service.confirm(detail.id, detail.stage_id!, detail.revision, { approved: true }))}>确认继续</button></div> : <p className="extension-footnote">请回到原工作流填写这一步所需的信息。</p>}</div> : null}
      {events.length ? <ol className="execution-events" aria-label="任务进度记录">{events.slice(-10).map(event => <li key={event.cursor}><span />{labels[event.type] || event.type}</li>)}</ol> : null}
      {files.length ? <section className="execution-artifacts" aria-label="文件成果"><h3>文件成果</h3>{files.map(file => <div key={`${file.id}:${file.version}`}><span><strong>{file.filename}</strong><small>v{file.version} · {file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KB`}</small></span><button className="extension-button compact" type="button" disabled={busy} aria-label={`下载 ${file.filename} v${file.version}`} onClick={() => void action(() => service.download(file))}><Download size={14} />下载</button></div>)}</section> : null}
      <div className="execution-job-actions">{["queued", "running", "waiting_user", "interrupted"].includes(detail.status) ? <button className="extension-button" type="button" disabled={busy || detail.cancel_requested} onClick={() => void action(() => service.cancel(detail.id))}>{detail.cancel_requested ? <LoaderCircle size={13} className="extension-spinning" /> : <Square size={13} />}{detail.cancel_requested ? "正在停止…" : "取消任务"}</button> : null}{detail.status === "interrupted" && detail.kind !== "ppt.quick_generate" && detail.checkpoint?.external_outcome !== "unknown" ? <button className="extension-button" type="button" disabled={busy || detail.cancel_requested} onClick={() => void action(() => service.resume(detail.id))}><RefreshCw size={13} />恢复任务</button> : null}</div>
    </div> : null}
  </section>;
}
