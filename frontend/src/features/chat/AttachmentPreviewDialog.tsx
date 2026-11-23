import { createContext, lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, Minus, Plus, RotateCcw, Scan, X } from "lucide-react";
import { MarkdownContent } from "./ChatMarkdown";
import type { ChatAttachment, ChatWorkspaceProps } from "./types";
import "./attachment-preview.css";
import { ImageEditor, type EditGeneratedImage } from "./ImageEditor";

const PdfReader = lazy(() => import("../library/PdfReader"));
export const AttachmentPreviewContext = createContext<((attachment: ChatAttachment) => void) | null>(null);

export function attachmentFormat(attachment: ChatAttachment) {
  const extension = attachment.original_filename.split(".").at(-1)?.toLowerCase();
  if (attachment.kind === "image") return "image";
  if (extension === "pdf") return "pdf";
  if (extension === "md") return "markdown";
  if (extension === "txt") return "text";
  if (extension === "docx") return "word";
  return "file";
}

function fileSize(bytes?: number) {
  if (bytes === undefined) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AttachmentPreviewDialog({ attachment, localFile, loadOriginal, gallery = [], onNavigate, onClose, onEditGeneratedImage }: {
  attachment: ChatAttachment;
  localFile?: File;
  loadOriginal?: ChatWorkspaceProps["onLoadAttachment"];
  onEditGeneratedImage?: EditGeneratedImage;
  onClose: () => void;
  gallery?: ChatAttachment[];
  onNavigate?: (attachment: ChatAttachment) => void;
}) {
  const format = attachmentFormat(attachment);
  const editorEnabled = format === "image" && attachment.origin === "generated" && !!onEditGeneratedImage;
  const galleryIndex = gallery.findIndex(item => item.id === attachment.id);
  const loaderRef = useRef(loadOriginal);
  loaderRef.current = loadOriginal;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const imageHintId = useId();
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const imageScale = zoom ?? fitScale;
  const minScale = Math.min(.1, fitScale);
  const canPan = imageScale > fitScale + .001;

  function fitImage(image: HTMLImageElement) {
    if (!image.naturalWidth || !image.naturalHeight) return;
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    const viewport = bodyRef.current;
    if (!viewport?.clientWidth || !viewport.clientHeight) return;
    const compact = viewport.clientWidth <= 600;
    setFitScale(Math.min(1, Math.max(1, viewport.clientWidth - (compact ? 32 : 64)) / image.naturalWidth, Math.max(1, viewport.clientHeight - 112) / image.naturalHeight));
  }

  function changeZoom(direction: number) {
    setZoom(Math.min(4, Math.max(minScale, Number((imageScale + direction * .25).toFixed(4)))));
  }

  // Keep the same part of the image in view when zooming; return to center when fitting.
  const previousScale = useRef(imageScale);
  useLayoutEffect(() => {
    const viewport = bodyRef.current;
    if (viewport && imageSize) {
      const ratio = imageScale / previousScale.current;
      const paddingX = viewport.clientWidth <= 600 ? 32 : 64;
      const oldWidth = Math.max(viewport.clientWidth, imageSize.width * previousScale.current + paddingX);
      const newWidth = Math.max(viewport.clientWidth, imageSize.width * imageScale + paddingX);
      const oldHeight = Math.max(viewport.clientHeight, imageSize.height * previousScale.current + 112);
      const newHeight = Math.max(viewport.clientHeight, imageSize.height * imageScale + 112);
      viewport.scrollLeft = zoom === null ? 0 : (viewport.scrollLeft + viewport.clientWidth / 2 - oldWidth / 2) * ratio + newWidth / 2 - viewport.clientWidth / 2;
      viewport.scrollTop = zoom === null ? 0 : (viewport.scrollTop + viewport.clientHeight / 2 - oldHeight / 2 + 32) * ratio + newHeight / 2 - 32 - viewport.clientHeight / 2;
    }
    previousScale.current = imageScale;
  }, [imageScale, imageSize, zoom]);

  useEffect(() => {
    if (!url || !bodyRef.current) return;
    const observer = new ResizeObserver(() => { if (imageRef.current) fitImage(imageRef.current); });
    observer.observe(bodyRef.current);
    return () => observer.disconnect();
  }, [url]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setLoading(true);
    setError("");
    dragRef.current = null;
    setDragging(false);
    setBlob(null);
    setUrl("");
    setBytes(null);
    setText("");
    setZoom(null);
    setImageSize(null);
    async function load() {
      try {
        if (!localFile && !loaderRef.current) throw new Error("暂时无法读取原文件，请重新添加附件");
        const result = localFile ? { file: localFile, parsedText: attachment.parsed_text } : await loaderRef.current!(attachment, controller.signal);
        const original = result.file;
        if (controller.signal.aborted) return;
        if (format === "pdf") {
          const pdfBytes = new Uint8Array(await original.arrayBuffer());
          if (controller.signal.aborted) return;
          setBytes(pdfBytes);
        } else if (format === "image") {
          objectUrl = URL.createObjectURL(original);
          setUrl(objectUrl);
        } else if (format === "text" || format === "markdown") {
          const textBytes = await original.arrayBuffer();
          let originalText: string;
          try { originalText = new TextDecoder("utf-8", { fatal: true }).decode(textBytes); }
          catch { originalText = new TextDecoder("gb18030").decode(textBytes); }
          if (controller.signal.aborted) return;
          setText(originalText);
        } else if (format === "word") {
          setText(result.parsedText || "");
        }
        setBlob(original);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "附件读取失败，请重试");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.parsed_text, format, localFile, attempt]);

  function download() {
    if (!blob) return;
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = attachment.original_filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    const revoke = URL.revokeObjectURL.bind(URL);
    window.setTimeout(() => revoke(downloadUrl), 1_000);
  }

  const formatLabel = { image: "图片", pdf: "PDF", markdown: "Markdown", text: "文本", word: "Word", file: "附件" }[format];
  const width = imageSize?.width ?? attachment.width;
  const height = imageSize?.height ?? attachment.height;
  return createPortal(
    <div className={`chat-attachment-backdrop${format === "image" ? " is-image-backdrop" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`chat-attachment-dialog${format === "image" ? " is-image-preview" : ""}`} role="dialog" aria-modal="true" aria-label={`${attachment.original_filename} 预览`}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
          if (format === "image" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && !event.altKey && !event.ctrlKey && !event.metaKey) {
            if (event.key === "ArrowLeft" && galleryIndex > 0) { event.preventDefault(); onNavigate?.(gallery[galleryIndex - 1]); }
            if (event.key === "ArrowRight" && galleryIndex >= 0 && galleryIndex < gallery.length - 1) { event.preventDefault(); onNavigate?.(gallery[galleryIndex + 1]); }
          }
          if (format === "image" && !editorEnabled && imageSize && !event.altKey && !event.ctrlKey && !event.metaKey) {
            if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(1); }
            if (event.key === "-") { event.preventDefault(); changeZoom(-1); }
            if (event.key === "0") { event.preventDefault(); setZoom(null); }
          }
          if (event.key !== "Tab") return;
          const fields = [...dialogRef.current!.querySelectorAll<HTMLElement>(":is(button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex='0'])")].filter(field => !field.closest("[hidden]"));
          const first = fields[0], last = fields.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        {format === "image" ? <button ref={closeRef} type="button" className="chat-image-close" onClick={onClose} aria-label="关闭附件预览"><X size={20} /></button> : <header className="chat-attachment-heading">
          <div className="chat-attachment-title"><FileText size={20} aria-hidden="true" /><div><h2 title={attachment.original_filename}>{attachment.original_filename}</h2><p>{formatLabel}{fileSize(blob?.size ?? attachment.size_bytes) ? ` · ${fileSize(blob?.size ?? attachment.size_bytes)}` : ""}</p></div></div>
          <div className="chat-attachment-actions">
            <button type="button" onClick={download} disabled={!blob} aria-label="下载原文件"><Download size={16} /> <span>下载</span></button>
            <button ref={closeRef} type="button" className="chat-attachment-close" onClick={onClose} aria-label="关闭附件预览"><X size={19} /></button>
          </div>
        </header>}
        {format === "image" && attachment.origin === "generated" && width && height && width > 0 && height > 0 ? <span className="chat-image-dimensions">{width} × {height}</span> : null}
        {format === "word" ? <p className="chat-attachment-note">当前显示提取的文字内容，完整排版请下载原文件查看。</p> : null}
        {editorEnabled ? <ImageEditor attachment={attachment} url={url} onImageLoad={fitImage} onEdit={onEditGeneratedImage!} onSubmitted={onClose} onNavigate={item => onNavigate?.(item)} onDownload={download} loadError={error} onReload={() => setAttempt(current => current + 1)} navigation={gallery.length > 1 ? <><button type="button" aria-label="上一张图片" disabled={galleryIndex <= 0} onClick={() => onNavigate?.(gallery[galleryIndex - 1])}><ChevronLeft size={17} /></button><span className="chat-image-counter">{galleryIndex + 1} / {gallery.length}</span><button type="button" aria-label="下一张图片" disabled={galleryIndex < 0 || galleryIndex >= gallery.length - 1} onClick={() => onNavigate?.(gallery[galleryIndex + 1])}><ChevronRight size={17} /></button></> : null} /> : <>
        <div className={`chat-attachment-content${format === "image" ? " is-image" : ""}`}>
        <div ref={bodyRef} className={`chat-attachment-body is-${format}${canPan ? " can-pan" : ""}${dragging ? " is-dragging" : ""}`} aria-busy={loading} tabIndex={format === "image" ? 0 : undefined} aria-label={format === "image" ? "图片画布" : undefined}
          onDoubleClick={() => { if (format === "image" && imageSize) setZoom(current => current === 1 ? null : 1); }}
          onPointerDown={(event) => {
            if (format === "image") event.currentTarget.focus({ preventScroll: true });
            if (format !== "image" || !canPan || event.button !== 0 || event.pointerType === "touch") return;
            const viewport = event.currentTarget;
            dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
            viewport.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.id !== event.pointerId) return;
            event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
            event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            dragRef.current = null; setDragging(false);
          }}
          onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
          onPointerCancel={() => { dragRef.current = null; setDragging(false); }}>
          {loading ? <div className="chat-attachment-empty" role="status"><LoaderCircle size={20} className="spinning" /><p>正在打开附件…</p></div>
            : error ? <div className="chat-attachment-empty"><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(current => current + 1)}><RotateCcw size={15} />重新加载</button></div>
            : format === "pdf" && bytes ? <Suspense fallback={<p className="chat-attachment-empty" role="status">正在加载 PDF 阅读器…</p>}><PdfReader bytes={bytes} title={attachment.original_filename} /></Suspense>
            : format === "image" && url ? <div className="chat-image-frame" style={imageSize ? { width: `max(100%, ${imageSize.width * imageScale + (bodyRef.current && bodyRef.current.clientWidth <= 600 ? 32 : 64)}px)`, height: `max(100%, ${imageSize.height * imageScale + 112}px)` } : undefined}><img ref={imageRef} src={url} alt={attachment.original_filename} aria-describedby={imageHintId} draggable={false} style={imageSize ? { width: imageSize.width * imageScale, maxWidth: "none" } : undefined} onLoad={(event) => fitImage(event.currentTarget)} onError={() => setError("图片无法显示，请重新加载或下载原文件查看")} /></div>
            : format === "markdown" ? <article className="chat-attachment-markdown"><MarkdownContent>{text || "文件没有文字内容。"}</MarkdownContent></article>
            : format === "text" || format === "word" ? <pre className="chat-attachment-text">{text || (format === "word" ? "暂无提取文字，可下载原文件查看。" : "文件没有文字内容。")}</pre>
            : <div className="chat-attachment-empty"><FileText size={28} /><p>此格式暂不支持在线预览，可下载原文件查看。</p></div>}
        </div>
        {format === "image" && url && !error ? <div className="chat-image-toolbar">
          <nav className="chat-image-controls" aria-label="图片缩放">
            {gallery.length > 1 ? <><button type="button" title="上一张（←）" aria-label="上一张图片" disabled={galleryIndex <= 0} onClick={() => onNavigate?.(gallery[galleryIndex - 1])}><ChevronLeft size={17} /></button><span className="chat-image-counter">{galleryIndex + 1} / {gallery.length}</span><button type="button" title="下一张（→）" aria-label="下一张图片" disabled={galleryIndex < 0 || galleryIndex >= gallery.length - 1} onClick={() => onNavigate?.(gallery[galleryIndex + 1])}><ChevronRight size={17} /></button><span className="chat-image-control-divider" aria-hidden="true" /></> : null}
            <button type="button" title="缩小（−）" aria-label="缩小图片" disabled={!imageSize || imageScale <= minScale} onClick={() => changeZoom(-1)}><Minus size={17} /></button>
            <button type="button" className="chat-image-scale" title="查看原始尺寸（100%）" aria-label="查看原始尺寸" disabled={!imageSize} onClick={() => setZoom(1)}>{Math.round(imageScale * 100)}%</button>
            <button type="button" title="放大（+）" aria-label="放大图片" disabled={!imageSize || imageScale >= 4} onClick={() => changeZoom(1)}><Plus size={17} /></button>
            <span className="chat-image-control-divider" aria-hidden="true" />
            <button type="button" className="chat-image-fit" title="适应窗口（0）" aria-label="适应窗口" aria-pressed={zoom === null} disabled={!imageSize} onClick={() => setZoom(null)}><Scan size={16} /><span>适应窗口</span></button>
            <button type="button" onClick={download} disabled={!blob} aria-label="下载原文件"><Download size={16} /></button>
          </nav>
          <span id={imageHintId} className="sr-only">双击查看原图，放大后可拖动</span>
        </div> : null}
        </div>
        </>}
      </section>
    </div>, document.body
  );
}
