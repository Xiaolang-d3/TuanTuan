import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Download, FileSliders, LoaderCircle, Pencil, RotateCcw, Square } from "lucide-react";
import { PreviewDialog } from "./PreviewDialog";
import { buildSlidePreviews, previewPresentation } from "./preview-service";
import type { PresentationBrief, PresentationStage, SlidePreview } from "./types";
import { useExtensionPreview } from "./ExtensionPreviewContext";
import { PresentationProduction } from "./PresentationProduction";

const steps = ["整理大纲", "编排页面", "检查版式", "准备成果"];
const initialBrief: PresentationBrief = { topic: "", audience: "团队成员", pages: 6, style: "清新" };
function Slide({ slide, index, total, style }: { slide: SlidePreview; index: number; total: number; style: PresentationBrief["style"] }) {
  return <div className={`presentation-slide ${style === "商务" ? "business" : "fresh"} ${index === 0 ? "cover" : ""}`}>
    <div className="presentation-slide-label">{index === 0 ? "PRESENTATION" : slide.subtitle}</div>
    <h3>{slide.title}</h3>
    {index === 0 ? <p className="presentation-slide-subtitle">{slide.subtitle}</p> : <ol>{slide.points.map((point, i) => <li key={i}><span>{String(i + 1).padStart(2, "0")}</span>{point}</li>)}</ol>}
    <div className="presentation-slide-footer"><span>团团 · 版式示例</span><span>{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span></div>
    {index === 0 ? <div className="presentation-cover-art" aria-hidden="true"><i /><i /><i /></div> : null}
  </div>;
}

export function PresentationWorkbench({ onClose }: { onClose: () => void }) {
  const { presentationService } = useExtensionPreview();
  return presentationService ? <PresentationProduction service={presentationService} onClose={onClose} /> : <PresentationDemo onClose={onClose} />;
}

function PresentationDemo({ onClose }: { onClose: () => void }) {
  const [brief, setBrief] = useState(initialBrief);
  const [stage, setStage] = useState<PresentationStage>("brief");
  const [slides, setSlides] = useState<SlidePreview[]>([]);
  const [selected, setSelected] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [failExport, setFailExport] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSubtitle, setEditSubtitle] = useState("");
  const [editPoints, setEditPoints] = useState("");
  const [feedback, setFeedback] = useState("");
  const activeRun = useRef<AbortController | null>(null);
  useEffect(() => () => activeRun.current?.abort(), []);
  const visibleSlides = slides.length ? slides : buildSlidePreviews({ ...brief, topic: brief.topic.trim() || "把想法讲清楚" });
  const slide = visibleSlides[selected] ?? visibleSlides[0];
  function outline(event: FormEvent) {
    event.preventDefault();
    if (!brief.topic.trim()) { setError("请填写演示主题。"); return; }
    setSlides(buildSlidePreviews({ ...brief, topic: brief.topic.trim() })); setSelected(0); setError(""); setStage("outline");
  }
  async function generate(simulateFailure = failExport) {
    activeRun.current?.abort();
    const controller = new AbortController(); activeRun.current = controller;
    setStage("running"); setProgress(0); setError(""); setFeedback("");
    try {
      await previewPresentation(setProgress, controller.signal, simulateFailure);
      if (activeRun.current === controller && !controller.signal.aborted) setStage("completed");
    } catch (caught) {
      if (activeRun.current !== controller || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "预览失败，请重试。"); setStage("failed");
    }
  }
  function cancel() { activeRun.current?.abort(); activeRun.current = null; setStage("cancelled"); }
  function reset() { cancel(); setStage("brief"); setSlides([]); setSelected(0); setEditing(false); setFeedback(""); setError(""); }
  return <PreviewDialog title="PPT 制作预览" wide onClose={onClose}>
    <div className="presentation-preview-banner"><FileSliders size={16} /><span>PPT Master 工作流界面示例 · 内容与版式均为本地示例，尚未运行真实制作流程。</span></div>
    <div className="presentation-workbench">
      <section className="presentation-controls" aria-label="制作设置" aria-busy={stage === "running"}>
        {stage === "brief" ? <form className="extension-form" onSubmit={outline}>
          <div><h3>这次想讲些什么？</h3><p className="extension-muted">先确定方向，再一起打磨每一页。</p></div>
          <label>演示主题<input autoComplete="off" maxLength={100} value={brief.topic} onChange={(event) => setBrief({ ...brief, topic: event.target.value })} placeholder="例如：第三季度产品复盘" required /></label>
          <label>面向谁讲<input maxLength={80} value={brief.audience} onChange={(event) => setBrief({ ...brief, audience: event.target.value })} placeholder="例如：项目团队、客户" /></label>
          <div className="presentation-form-pair"><label>页数<select value={brief.pages} onChange={(event) => setBrief({ ...brief, pages: Number(event.target.value) })}>{[4, 6, 8].map((pages) => <option key={pages} value={pages}>{pages} 页</option>)}</select></label><label>风格<select value={brief.style} onChange={(event) => setBrief({ ...brief, style: event.target.value as PresentationBrief["style"] })}><option>清新</option><option>商务</option></select></label></div>
          {error ? <p role="alert" className="extension-error">{error}</p> : null}
          <button type="submit" className="extension-button primary">预览大纲<ArrowRight size={16} /></button>
          <p className="extension-footnote">此阶段展示占位内容。真实资料读取、模型生成与 PPTX 导出将在后端接入后提供。</p>
        </form> : null}
        {stage === "outline" ? <div className="presentation-outline"><h3>先确认大纲</h3><p className="extension-muted">调整页面标题，让内容顺着你的思路展开。</p><ol>{slides.map((entry, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span><input aria-label={`第 ${index + 1} 页标题`} maxLength={100} value={entry.title} onFocus={() => setSelected(index)} onChange={(event) => setSlides((current) => current.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} /></li>)}</ol><details className="presentation-demo-options"><summary>预览选项</summary><label><input type="checkbox" checked={failExport} onChange={(event) => setFailExport(event.target.checked)} />模拟导出失败</label></details><button className="extension-button primary" type="button" disabled={slides.some((entry) => !entry.title.trim())} onClick={() => void generate()}>确认大纲，开始预览<ArrowRight size={15} /></button><button className="extension-text-button" type="button" onClick={() => { setStage("brief"); setSlides([]); setSelected(0); }}><ArrowLeft size={14} />返回修改需求</button></div> : null}
        {stage === "running" ? <div className="presentation-progress"><LoaderCircle className="extension-spinning" size={27} /><h3>正在演示制作流程</h3><p className="extension-muted">{brief.topic}</p><ol>{steps.map((step, i) => <li key={step} className={i < progress ? "done" : i === progress ? "current" : ""}>{i < progress ? <Check size={15} /> : <span>{i + 1}</span>}{step}{i === progress ? <span className="extension-progress-label">进行中</span> : null}</li>)}</ol><div role="progressbar" aria-label="制作进度" aria-valuemin={0} aria-valuemax={4} aria-valuenow={progress} className="presentation-progress-track"><span style={{ transform: `scaleX(${progress / 4})` }} /></div><button className="extension-button" type="button" onClick={cancel}><Square size={13} />取消预览</button></div> : null}
        {stage === "cancelled" || stage === "failed" ? <div className="presentation-outcome"><h3>{stage === "cancelled" ? "预览已取消" : "这次预览未完成"}</h3><p className={stage === "failed" ? "extension-error" : "extension-muted"} role={stage === "failed" ? "alert" : "status"}>{error || "大纲仍然保留，可以随时继续。"}</p><button type="button" className="extension-button primary" onClick={() => { setFailExport(false); void generate(false); }}><RotateCcw size={15} />重试预览</button><button type="button" className="extension-text-button" onClick={() => setStage("outline")}>返回大纲</button></div> : null}
        {stage === "completed" ? <div className="presentation-outcome"><CheckCircle2 size={27} className="extension-success" /><h3>预览完成</h3><p className="extension-muted">{slides.length} 页版式示例已就绪。切换页面查看，或直接修改当前页。</p><dl className="presentation-result-meta"><div><dt>主题</dt><dd>{brief.topic}</dd></div><div><dt>风格</dt><dd>{brief.style} · 16:9</dd></div><div><dt>成果</dt><dd>本地界面预览</dd></div></dl><button type="button" className="extension-button primary" onClick={() => { setEditing(true); setEditTitle(slide.title); setEditSubtitle(slide.subtitle); setEditPoints(slide.points.join("\n")); setFeedback(""); }}><Pencil size={15} />修改当前页</button><button type="button" className="extension-button" disabled aria-describedby="presentation-download-hint"><Download size={15} />下载 PPTX</button><p className="extension-footnote" id="presentation-download-hint">接入导出服务后可下载；当前未生成 PPTX 文件。</p><button className="extension-text-button" type="button" onClick={reset}><RotateCcw size={14} />重新制作</button></div> : null}
      </section>
      <section className="presentation-preview" aria-label="页面预览"><div className="presentation-preview-toolbar"><span>{stage === "brief" ? "版式参考" : `第 ${selected + 1} 页 · 共 ${visibleSlides.length} 页`}</span><span>16:9</span></div><Slide slide={slide} index={selected} total={visibleSlides.length} style={brief.style} />
        {stage === "brief" ? <p className="presentation-canvas-caption">先从清晰的结构开始。</p> : <div className="presentation-thumbnails" aria-label="选择页面">{visibleSlides.map((entry, index) => <button type="button" key={index} aria-label={`查看第 ${index + 1} 页：${entry.title}`} aria-pressed={selected === index} onClick={() => { setSelected(index); setEditing(false); setFeedback(""); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{entry.title}</strong></button>)}</div>}
        {editing ? <form className="extension-form presentation-edit" onSubmit={(event) => { event.preventDefault(); setSlides((current) => current.map((entry, index) => index === selected ? { ...entry, title: editTitle.trim(), ...(selected === 0 ? { subtitle: editSubtitle.trim() } : { points: editPoints.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3) }) } : entry)); setEditing(false); setFeedback("修改已应用到本地预览。"); }}><label>页面标题<input required maxLength={100} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>{selected === 0 ? <label>封面副标题<input maxLength={160} value={editSubtitle} onChange={(event) => setEditSubtitle(event.target.value)} /></label> : <label>要点（每行一项，最多三项）<textarea rows={3} maxLength={600} value={editPoints} onChange={(event) => setEditPoints(event.target.value)} /></label>}<div className="extension-actions"><button className="extension-button" type="button" onClick={() => setEditing(false)}>取消</button><button className="extension-button primary" type="submit" disabled={!editTitle.trim()}>应用修改</button></div></form> : null}
        <p role="status" className="extension-footnote">{feedback || (stage === "running" ? `预览进度：已完成 ${progress} / 4 个步骤` : "示例内容仅用于确认界面与流程，不代表实际制作结果。")}</p>
      </section>
    </div>
  </PreviewDialog>;
}
