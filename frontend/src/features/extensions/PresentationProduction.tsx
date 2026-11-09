import { useEffect, useRef, useState, type FormEvent } from "react";
import { Download, FileSliders, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { PreviewDialog } from "./PreviewDialog";
import type { FileArtifact } from "./activity-service";
import type { PresentationCapabilities, PresentationJob, PresentationService } from "./presentation-service";
import { currentPresentationArtifacts } from "./presentation-service";

const stageNames: Record<string, string> = {
  queued: "等待开始", sources_ready: "整理资料", stage1_recommended: "等待需求确认",
  stage1_confirmed: "拟定设计方案", stage2_recommended: "等待设计确认", final_confirmed: "编写设计规格",
  spec_ready: "编排页面", quality_repairing: "修正版式", pages_ready: "编写讲稿与导出",
  notes_ready: "导出与生成预览", delivery_ready: "发布成果"
};
const jobStatusNames: Record<string, string> = { queued: "等待开始", running: "制作中", waiting_user: "等待确认", succeeded: "制作完成", failed: "制作失败", cancelled: "已取消", interrupted: "已中断" };

function PageImage({ service, artifact }: { service: PresentationService; artifact: FileArtifact }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let current = "";
    setUrl(""); setError("");
    void service.preview(artifact, controller.signal).then(value => {
      if (controller.signal.aborted) { URL.revokeObjectURL(value); return; }
      current = value; setUrl(value);
    }).catch(() => { if (!controller.signal.aborted) setError("页面预览读取失败，请切换页面重试。"); });
    return () => { controller.abort(); if (current) URL.revokeObjectURL(current); };
  }, [service, artifact]);
  return error ? <p role="alert">{error}</p> : url ? <img className="presentation-page-image" src={url} alt={`演示文稿页面 ${artifact.filename}`} /> : <p role="status">正在读取页面…</p>;
}

export function PresentationProduction({ service, onClose }: { service: PresentationService; onClose: () => void }) {
  const [topic, setTopic] = useState("");
  const [pages, setPages] = useState(8);
  const [job, setJob] = useState<PresentationJob | null>(null);
  const [recent, setRecent] = useState<{ id: string; status: string }[]>([]);
  const [artifacts, setArtifacts] = useState<FileArtifact[]>([]);
  const [selected, setSelected] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const [confirmationOpened, setConfirmationOpened] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [capabilities, setCapabilities] = useState<PresentationCapabilities | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState("");
  const [checkRevision, setCheckRevision] = useState(0);
  const key = useRef(crypto.randomUUID());
  const active = useRef(true);
  const operating = useRef(false);
  const jobRef = useRef<PresentationJob | null>(null);
  const currentId = job?.id;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true); setCheckError(""); setCapabilities(null);
    void service.capabilities(controller.signal).then(result => {
      if (!controller.signal.aborted) setCapabilities(result);
    }).catch(caught => {
      if (!controller.signal.aborted) setCheckError(caught instanceof Error ? caught.message : "制作环境检查失败，请重试。");
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [service, checkRevision]);
  function updateJob(next: PresentationJob) {
    const previous = jobRef.current;
    if (!active.current || (previous?.id === next.id && previous.revision > next.revision)) return false;
    jobRef.current = next; setJob(next); return true;
  }
  useEffect(() => { setConfirmation(""); setConfirmationOpened(false); }, [currentId, job?.stage, job?.confirmation_required]);

  useEffect(() => {
    const controller = new AbortController();
    void service.activity.list(controller.signal).then(result => {
      if (!controller.signal.aborted) setRecent(result.jobs.filter(entry => entry.kind === "ppt.generate").slice(0, 10));
    }).catch(() => { if (!controller.signal.aborted) setError("历史任务读取失败，您仍可新建制作任务。"); });
    return () => controller.abort();
  }, [service, historyRefresh]);

  useEffect(() => {
    if (!currentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await service.get(currentId!, controller.signal);
        if (controller.signal.aborted) return;
        setPollError("");
        const accepted = updateJob(next);
        if (accepted && next.status !== "succeeded") setArtifacts([]);
        if (accepted && next.status === "succeeded") {
          const result = await service.activity.artifacts(currentId!, controller.signal);
          if (!controller.signal.aborted) setArtifacts(currentPresentationArtifacts(next, result.artifacts));
          return;
        }
        if (accepted && ["failed", "cancelled", "interrupted"].includes(next.status)) return;
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPollError(caught instanceof Error ? caught.message : "任务状态读取失败，请刷新。");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [service, currentId, refresh]);

  async function operate(operation: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (caught) { if (active.current) setError(caught instanceof Error ? caught.message : "操作失败，请重试。"); }
    finally { operating.current = false; if (active.current) setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (checking || !capabilities?.available || !topic.trim() || !Number.isInteger(pages) || pages < 1 || pages > 20) return;
    void operate(async () => { if (updateJob(await service.create(topic.trim(), pages, key.current))) { setArtifacts([]); setSelected(0); } });
  }
  const previews = artifacts.filter(item => /^P\d{2}\.png$/.test(item.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
  const pptx = artifacts.find(item => item.filename.endsWith(".pptx"));
  const running = job && ["queued", "running", "waiting_user"].includes(job.status);
  const status = job?.status === "succeeded" ? "制作完成" : job?.status === "failed" ? "制作失败"
    : job?.status === "cancelled" ? "制作已取消" : job?.status === "interrupted" ? "制作已中断"
    : stageNames[job?.stage ?? "queued"] ?? (/^page_\d+_ready$/.test(job?.stage ?? "") ? `已编排第 ${job!.stage.split("_")[1]} 页` : "正在制作");

  return <PreviewDialog title="PPT 制作" wide onClose={onClose}>
    <div className="presentation-preview-banner"><FileSliders size={16} /><span>确认需求与设计后，生成可编辑 PPTX 和逐页预览。关闭此窗口后任务继续运行。</span></div>
    <div className="presentation-workbench">
      <section className="presentation-controls" aria-label="制作设置" aria-busy={busy}>
        {!job ? <form className="extension-form" onSubmit={create}>
          <div><h3>这次想讲些什么？</h3><p className="extension-muted">写下内容、听众与希望达成的目标。</p></div>
          <label>演示主题与要求<textarea required disabled={busy} rows={6} maxLength={8000} value={topic} onChange={event => { setTopic(event.target.value); key.current = crypto.randomUUID(); }} placeholder="例如：面向项目团队的季度产品复盘，突出进展、问题与下一步安排。" /></label>
          <label>建议页数<input disabled={busy} type="number" min={1} max={20} value={pages || ""} onChange={event => { setPages(Number(event.target.value)); key.current = crypto.randomUUID(); }} required /></label>
          <p role={checkError ? "alert" : "status"} className={checkError ? "extension-error" : "extension-muted"}>{checking ? "正在检查制作环境…" : checkError || capabilities?.reason}</p>
          {!checking && (!capabilities?.available || checkError) ? <button type="button" className="extension-button" onClick={() => setCheckRevision(value => value + 1)}>重新检查</button> : null}
          <button type="submit" className="extension-button primary" disabled={busy || checking || !capabilities?.available || !topic.trim()}>开始制作</button>
          <p className="extension-footnote">当前支持中文 16:9、1–20 页自由设计。页面与讲稿将在设计确认后生成。</p>
          {recent.length ? <label>继续已有任务<select disabled={busy} aria-label="继续已有任务" value="" onChange={event => { const id = event.target.value; if (id) void operate(async () => { if (updateJob(await service.get(id))) { setArtifacts([]); setSelected(0); } }); }}><option value="">选择任务</option>{recent.map(entry => <option key={entry.id} value={entry.id}>{entry.id.slice(0, 8)} · {jobStatusNames[entry.status] ?? entry.status}</option>)}</select></label> : null}
        </form> : <div className="extension-form">
          <h3>{status}</h3>
          {running ? <p role="status" className="extension-muted">{job.confirmation_required ? job.prompt : "正在处理，页面完成后会自动更新。"}</p> : null}
          {!job.generation_available && job.status !== "succeeded" ? <p className="extension-footnote">此环境仅开放需求准备，PPT 导出尚未启用。</p> : null}
          {job.error ? <p role="alert" className="extension-error">{job.error}</p> : null}
          {job.confirmation_required && running && !job.cancel_requested ? <button className="extension-button primary" type="button" disabled={busy} onClick={() => void operate(async () => {
            const url = await service.confirmation(job.id);
            const latest = jobRef.current;
            if (active.current && latest?.id === job.id && latest.stage === job.stage && latest.confirmation_required && !latest.cancel_requested) { setConfirmation(url); setConfirmationOpened(!url); }
          })}>打开{job.stage === "stage1_recommended" ? "需求" : "设计"}确认页</button> : null}
          {confirmationOpened ? <p role="status" className="extension-muted">确认窗口已打开，请在窗口中审核并提交。提交后任务会自动继续。</p> : null}
          {running ? <button className="extension-button" type="button" disabled={busy || job.cancel_requested} onClick={() => void operate(async () => { updateJob(await service.cancel(job.id)); setConfirmation(""); setConfirmationOpened(false); setRefresh(v => v + 1); })}><Square size={15} />{job.cancel_requested ? "正在取消…" : "取消制作"}</button> : null}
          {job.status === "interrupted" ? <button className="extension-button" type="button" disabled={busy} onClick={() => void operate(async () => { updateJob(await service.resume(job.id)); setArtifacts([]); setRefresh(v => v + 1); })}><RotateCcw size={15} />恢复任务</button> : null}
          <button type="button" className="extension-button" disabled={busy} onClick={() => { setError(""); setRefresh(v => v + 1); }}>刷新状态</button>
          {job.status === "succeeded" && pptx ? <button className="extension-button primary" type="button" disabled={busy} onClick={() => void operate(() => service.activity.download(pptx))}><Download size={16} />下载 PPTX</button> : null}
          {artifacts.filter(item => !item.filename.endsWith(".pptx") && !item.filename.endsWith(".png")).map(item => <button type="button" className="extension-button" key={item.id} disabled={busy} onClick={() => void operate(() => service.activity.download(item))}>下载{item.filename}</button>)}
          {!running ? <button className="extension-button" type="button" disabled={busy} onClick={() => { jobRef.current = null; setJob(null); setArtifacts([]); setConfirmation(""); setError(""); setPollError(""); setHistoryRefresh(v => v + 1); key.current = crypto.randomUUID(); }}>新建演示文稿</button> : null}
          <p className="extension-footnote">任务编号：{job.id}</p>
        </div>}
        {error ? <p role="alert" className="extension-error">{error}</p> : null}
        {pollError ? <p role="alert" className="extension-error">{pollError}</p> : null}
      </section>
      <section className="presentation-canvas" aria-label="页面与确认">
        {confirmation ? <iframe className="presentation-confirmation-frame" title={`PPT ${job?.stage === "stage1_recommended" ? "需求" : "设计"}确认`} src={confirmation} referrerPolicy="no-referrer" /> : previews.length ? <>
          <PageImage service={service} artifact={previews[selected] ?? previews[0]} />
          <nav className="presentation-thumbnails" aria-label="选择页面">{previews.map((page, index) => <button key={page.id} type="button" aria-label={`查看第 ${index + 1} 页`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{index + 1}</button>)}</nav>
          <p className="extension-footnote">预览来自 SVG。下载后请在 PowerPoint 或 WPS 中检查字体与版式。</p>
        </> : <div className="presentation-production-empty">{running && !job.confirmation_required ? <LoaderCircle size={28} aria-hidden="true" /> : <FileSliders size={36} aria-hidden="true" />}<h3>{job ? status : "把想法整理成演示文稿"}</h3><p>{job?.confirmation_required ? "打开确认页，审核并提交您的需求。" : "逐页预览会在制作完成后出现在这里。"}</p></div>}
      </section>
    </div>
  </PreviewDialog>;
}
