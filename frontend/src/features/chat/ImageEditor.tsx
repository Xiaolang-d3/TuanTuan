import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Eraser, MessageSquarePlus, PenLine, Scissors, Scaling, Undo2, WandSparkles, RotateCw, FlipHorizontal, LoaderCircle, Download, X } from "lucide-react";
import type { ChatAttachment } from "./types";
import "./image-editor.css";

export type ImageEditPoint = { x: number; y: number };
export type ImageEditStroke = { points: ImageEditPoint[]; width: number };
export type ImageEditComment = ImageEditPoint & { text: string };
export type ImageEditRequest = {
  operation_id: string; mode: "edit" | "erase" | "background" | "resize"; prompt: string;
  strokes: ImageEditStroke[]; comments: ImageEditComment[]; width: number; height: number;
  rotation: number; flip: boolean;
};
export type ImageEditResult = { assets: ChatAttachment[]; message_id: number; conversation_id: number };
export type EditGeneratedImage = (asset: ChatAttachment, request: ImageEditRequest) => Promise<ImageEditResult>;
type Tool = "mark" | "comment" | "background" | "erase" | "resize";
const tools = [
  { id: "mark", name: "标注", Icon: PenLine }, { id: "comment", name: "添加评论", Icon: MessageSquarePlus },
  { id: "background", name: "移除背景", Icon: Scissors }, { id: "erase", name: "擦除", Icon: Eraser },
  { id: "resize", name: "调整大小", Icon: Scaling },
] as const;

export function ImageEditor({ attachment, url, onImageLoad, onEdit, onNavigate, onDownload, loadError, onReload, navigation, onSubmitted }: {
  attachment: ChatAttachment; url: string; onEdit: EditGeneratedImage;
  onImageLoad?: (image: HTMLImageElement) => void;
  onNavigate: (asset: ChatAttachment) => void; onDownload?: () => void; loadError?: string; onReload?: () => void; navigation?: ReactNode; onSubmitted?: () => void;
}) {
  const [tool, setTool] = useState<Tool | null>(null);
  const [strokes, setStrokes] = useState<ImageEditStroke[]>([]);
  const [comments, setComments] = useState<ImageEditComment[]>([]);
  const [prompt, setPrompt] = useState("");
  const [brush, setBrush] = useState(5);
  const [width, setWidth] = useState(attachment.width || 1024);
  const [height, setHeight] = useState(attachment.height || 1024);
  const [locked, setLocked] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [flip, setFlip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [versions, setVersions] = useState<ChatAttachment[]>([attachment]);
  const drawing = useRef<number | null>(null);
  const mounted = useRef(true);
  const operation = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setStrokes([]); setComments([]); setWidth(attachment.width || 1024); setHeight(attachment.height || 1024);
    setRotation(0); setFlip(false); setError(""); operation.current = null;
  }, [attachment.id, attachment.width, attachment.height]);
  const naturalWidth = attachment.width || 1024, naturalHeight = attachment.height || 1024;
  const ratio = rotation % 180 ? naturalHeight / naturalWidth : naturalWidth / naturalHeight;
  function point(event: PointerEvent<SVGSVGElement>): ImageEditPoint {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  }
  function begin(event: PointerEvent<SVGSVGElement>) {
    if (!tool || !url || busy || event.button !== 0 || tool === "resize" || tool === "background") return;
    const p = point(event);
    if (tool === "comment") {
      if (comments.length < 20) setComments(items => [...items, { ...p, text: "" }]);
      return;
    }
    if (strokes.length >= 100) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = event.pointerId;
    setStrokes(items => [...items, { points: [p], width: brush / 100 }]);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (drawing.current !== event.pointerId) return;
    const p = point(event);
    setStrokes(items => items.map((stroke, index) => index === items.length - 1 && stroke.points.length < 2000 ? { ...stroke, points: [...stroke.points, p] } : stroke));
  }
  function dimension(value: number, axis: "width" | "height") {
    if (axis === "width") { setWidth(value); if (locked) setHeight(Math.round(value / ratio)); }
    else { setHeight(value); if (locked) setWidth(Math.round(value * ratio)); }
  }
  const mode: ImageEditRequest["mode"] = !tool || tool === "mark" || tool === "comment" ? "edit" : tool;
  const validSize = Number.isInteger(width) && Number.isInteger(height) && width >= 16 && height >= 16 && width <= 8192 && height <= 8192 && width * height <= 40000000;
  const canSubmit = mode === "resize" ? validSize : mode === "erase" ? strokes.length > 0 : mode === "background" || !!prompt.trim() || comments.some(item => item.text.trim());
  async function submit() {
    if (busy || !canSubmit) return;
    const values = { mode, prompt, strokes: mode === "background" || mode === "resize" ? [] : strokes,
      comments: mode === "resize" || mode === "background" ? [] : comments.filter(item => item.text.trim()), width, height, rotation, flip };
    const signature = JSON.stringify({ asset: attachment.id, ...values });
    // A timeout retry retains the receipt; it must not silently bill a second edit.
    if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError(""); setNotice("");
    try {
      const pending = onEdit(attachment, { ...values, operation_id: operation.current!.id });
      onSubmitted?.();
      const result = await pending;
      if (!mounted.current) return;
      const next = result.assets[0];
      if (!next) throw new Error("编辑服务未返回图片");
      setVersions(items => [...items.filter(item => item.id !== next.id), next]);
      onNavigate(next); setNotice("新版本已保存到当前对话，可继续编辑或下载。");
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "编辑失败，请检查模型是否支持图片编辑"); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="image-editor" aria-label="图片编辑器" onKeyDown={event => { if (event.key !== "Tab" && event.key !== "Escape") event.stopPropagation(); }}>

      <div className="image-editor-stage">
        <div className="image-editor-canvas" style={{ aspectRatio: `${naturalWidth} / ${naturalHeight}`, maxWidth: `min(1200px, calc(max(120px, 100dvh - ${tool ? 340 : 112}px) * ${naturalWidth / naturalHeight}))` }}>
          {url ? <img src={url} alt="正在编辑的图片" draggable={false} onLoad={event => onImageLoad?.(event.currentTarget)} /> : <div className="image-editor-load">{loadError ? <><p role="alert">{loadError}</p><button type="button" onClick={onReload}>重新加载</button></> : <p role="status">正在加载图片…</p>}</div>}
          <svg role="img" aria-label="涂抹选区或点击添加位置评论" style={{ pointerEvents: tool ? "auto" : "none" }} viewBox={`0 0 ${naturalWidth} ${naturalHeight}`} onPointerDown={begin} onPointerMove={move} onPointerUp={() => { drawing.current = null; }} onPointerCancel={() => { drawing.current = null; }}>
            {tool && tool !== "resize" && tool !== "background" ? strokes.map((stroke, index) => <polyline key={index} points={stroke.points.map(p => `${p.x * naturalWidth},${p.y * naturalHeight}`).join(" ")} fill="none" stroke="#a78bfa" strokeOpacity=".6" strokeWidth={stroke.width * naturalWidth} strokeLinecap="round" strokeLinejoin="round" />) : null}
            {tool && tool !== "resize" && tool !== "background" ? strokes.filter(stroke => stroke.points.length === 1).map((stroke, index) => <circle key={`dot-${index}`} cx={stroke.points[0].x * naturalWidth} cy={stroke.points[0].y * naturalHeight} r={stroke.width * naturalWidth / 2} fill="#a78bfa" fillOpacity=".6" />) : null}
            {tool && tool !== "resize" && tool !== "background" ? comments.map((comment, index) => <g key={index} transform={`translate(${comment.x * naturalWidth},${comment.y * naturalHeight})`}><circle r={naturalWidth * .018} fill="#7c3aed" stroke="white" strokeWidth={naturalWidth * .002} /><text fill="white" textAnchor="middle" dominantBaseline="central" fontSize={naturalWidth * .023}>{index + 1}</text></g>) : null}
          </svg>
        </div>
        {versions.length > 1 ? <nav className="image-editor-versions" aria-label="图片版本">{versions.map((asset, index) => <button type="button" key={asset.id} disabled={busy} aria-current={asset.id === attachment.id ? "true" : undefined} onClick={() => onNavigate(asset)}>{index === 0 ? "原图" : `版本 ${index}`}</button>)}</nav> : null}
      </div>
      {tool ? <div className={`image-editor-options is-${tool}`} aria-label={`${tools.find(item => item.id === tool)?.name}选项`}>
        <button className="image-editor-collapse" type="button" disabled={busy} aria-label="收起编辑选项" onClick={() => setTool(null)}><X size={16} /></button>
        {tool === "mark" || tool === "erase" ? <><label className="image-editor-brush">画笔<input aria-label="画笔大小" type="range" min="1" max="25" value={brush} disabled={busy} onChange={e => setBrush(Number(e.target.value))} /></label><div className="image-editor-row"><button type="button" disabled={busy || !strokes.length} onClick={() => setStrokes(items => items.slice(0, -1))}><Undo2 size={14} />撤销笔画</button><button type="button" disabled={busy || !strokes.length} onClick={() => setStrokes([])}>清空选区</button></div></> : null}
        {tool === "resize" ? <>
          <label>宽度（像素）<input type="number" min="16" max="8192" value={width} disabled={busy} onChange={e => dimension(Number(e.target.value), "width")} /></label>
          <label>高度（像素）<input type="number" min="16" max="8192" value={height} disabled={busy} onChange={e => dimension(Number(e.target.value), "height")} /></label>
          <label className="image-editor-check"><input type="checkbox" checked={locked} disabled={busy} onChange={e => setLocked(e.target.checked)} />锁定原图比例</label>
          <div className="image-editor-row">{[["方图", 1024, 1024], ["横版", 1536, 1024], ["竖版", 1024, 1536]].map(([label, w, h]) => <button type="button" key={label} disabled={busy} onClick={() => { setLocked(false); setWidth(Number(w)); setHeight(Number(h)); }}>{label}</button>)}</div>
          <div className="image-editor-row"><button type="button" disabled={busy} aria-label="顺时针旋转90度" onClick={() => { setRotation(value => (value + 90) % 360); setWidth(height); setHeight(width); }}><RotateCw size={14} />{rotation}°</button><button type="button" disabled={busy} aria-pressed={flip} onClick={() => setFlip(value => !value)}><FlipHorizontal size={14} />水平翻转</button></div>
          <p>预设会按目标尺寸缩放；更换比例可能使画面拉伸。</p>
          {!validSize ? <p role="alert">尺寸需在 16–8192 像素内，且总像素不超过 4000 万。</p> : null}
        </> : tool !== "background" ? <>
          <label className="image-editor-prompt"><span className="sr-only">修改要求</span><textarea value={prompt} disabled={busy} maxLength={4000} placeholder={tool === "erase" ? "可选：补全背景时需要注意什么？" : "例如：把主体改为暖橙色，保留造型和光影"} onChange={e => setPrompt(e.target.value)} /></label>
          {comments.map((comment, index) => <div className="image-editor-comment" key={index}><label>位置 {index + 1}<textarea aria-label={`位置 ${index + 1} 的评论`} value={comment.text} disabled={busy} maxLength={500} placeholder="描述这里需要怎样修改" onChange={e => setComments(items => items.map((item, i) => i === index ? { ...item, text: e.target.value } : item))} /></label><button type="button" disabled={busy} onClick={() => setComments(items => items.filter((_, i) => i !== index))}>删除评论 {index + 1}</button></div>)}
        </> : <p>移除背景，保留主体并生成透明 PNG。</p>}
        <button className="image-editor-submit" type="button" disabled={busy || !canSubmit || !url} onClick={() => void submit()}>{busy ? <LoaderCircle size={16} className="image-editor-spin" /> : <WandSparkles size={16} />}{busy ? "正在保存新版本…" : mode === "resize" ? "保存尺寸调整" : "生成编辑版本"}</button>
        {busy ? <p role="status">正在提交编辑，进度和结果将在对话中显示。</p> : null}
        {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      </div> : null}
    <div className="image-editor-tools" role="toolbar" aria-label="图片设计工具">
      {navigation}
      {tools.map(({ id, name, Icon }) => <button key={id} type="button" disabled={busy || !url || !!loadError} aria-pressed={tool === id} onClick={() => { setTool(current => current === id ? null : id); setError(""); setNotice(""); }}><Icon size={16} /><span>{name}</span></button>)}
      {onDownload ? <button type="button" disabled={!url || !!loadError} aria-label="下载原文件" title="下载图片" onClick={onDownload}><Download size={16} /><span className="image-editor-download-label">下载</span></button> : null}
    </div>
  </div>;
}
