import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowRight, Download, Image as ImageIcon, LoaderCircle, Maximize2, MessageCircle, RotateCcw, Settings2, Sparkles, X } from "lucide-react";
import { downloadBlob } from "../chat/result-files";
import type { ChatAttachment } from "../chat/types";
import "./ImageWorkspace.css";

export type ImageWorkspaceProps = {
  ready: boolean;
  busy: boolean;
  error: string | null;
  images: ChatAttachment[];
  resultPrompt?: string | null;
  hasConversation: boolean;
  onGenerate: (prompt: string) => Promise<void>;
  onOpenConversation: () => void;
  onOpenSettings: () => void;
  onLoadImage: (asset: ChatAttachment, signal?: AbortSignal) => Promise<Blob>;
};

const examples = [
  { label: "旅行海报", prompt: "一张安静的海边旅行海报，远处是灯塔和起伏的海岸线，清晨的柔和光线，留白构图。" },
  { label: "产品静物", prompt: "一只陶瓷咖啡杯放在木桌上，旁边有一本翻开的书，窗边自然光，温暖而简洁的静物摄影。" },
  { label: "童话插画", prompt: "一只小狐狸在雨后的森林里散步，蘑菇和蕨叶上挂着水珠，温柔细腻的绘本插画。" },
];

type ImageData = { blob: Blob; url: string };

function ResultImage({ asset, onLoadImage }: { asset: ChatAttachment; onLoadImage: ImageWorkspaceProps["onLoadImage"] }) {
  const loaderRef = useRef(onLoadImage);
  loaderRef.current = onLoadImage;
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<ImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setLoading(true);
    setLoadError("");
    setImage(null);
    setPreviewOpen(false);
    async function load() {
      try {
        const blob = await loaderRef.current(assetRef.current, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ blob, url: objectUrl });
      } catch (reason) {
        if (!controller.signal.aborted) setLoadError(reason instanceof Error && reason.message ? reason.message : "图片加载失败，请重试");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id, attempt]);

  useEffect(() => {
    if (!previewOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [previewOpen]);

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setPreviewOpen(false);
    } else if (event.key === "Tab" && dialogRef.current) {
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  function download() {
    if (image) downloadBlob(image.blob, asset.original_filename);
  }

  const dimensions = asset.width && asset.height && asset.width > 0 && asset.height > 0
    ? `${asset.width} × ${asset.height}` : null;
  return <figure className="image-workspace-result">
    <div className="image-workspace-result-media">
      {loading ? <div className="image-workspace-image-state" role="status"><LoaderCircle className="image-workspace-spin" size={20} aria-hidden="true" /><span>正在加载图片…</span></div>
        : loadError ? <div className="image-workspace-image-state"><p role="alert">{loadError}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} aria-hidden="true" />重新加载</button></div>
        : image ? <button className="image-workspace-image-button" type="button" onClick={() => setPreviewOpen(true)} aria-label={`查看原图 ${asset.original_filename}`}>
          <img src={image.url} alt={asset.original_filename} onError={() => setLoadError("图片无法显示，请重新加载或下载原图")}/>
          <span className="image-workspace-expand" aria-hidden="true"><Maximize2 size={15} /></span>
        </button> : null}
    </div>
    <figcaption className="image-workspace-result-caption">
      <div className="image-workspace-file-info"><span title={asset.original_filename}>{asset.original_filename}</span>{dimensions ? <small>{dimensions}</small> : null}</div>
      <div className="image-workspace-result-actions">
        <button type="button" onClick={() => setPreviewOpen(true)} disabled={!image || !!loadError} aria-label={`查看原图 ${asset.original_filename}`}><Maximize2 size={15} aria-hidden="true" /><span>查看原图</span></button>
        <button type="button" onClick={download} disabled={!image} aria-label={`下载原图 ${asset.original_filename}`}><Download size={15} aria-hidden="true" /><span>下载原图</span></button>
      </div>
    </figcaption>
    {previewOpen && image ? <div className="image-workspace-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
      <div ref={dialogRef} className="image-workspace-dialog" role="dialog" aria-modal="true" aria-label={`${asset.original_filename} 原图预览`} onKeyDown={handleDialogKeys}>
        <div className="image-workspace-dialog-bar"><span title={asset.original_filename}>{asset.original_filename}</span><div>
          <button type="button" onClick={download}><Download size={16} aria-hidden="true" />下载原图</button>
          <button ref={closeRef} type="button" onClick={() => setPreviewOpen(false)} aria-label="关闭原图预览"><X size={19} aria-hidden="true" /></button>
        </div></div>
        <div className="image-workspace-dialog-image"><img src={image.url} alt={asset.original_filename} /></div>
      </div>
    </div> : null}
  </figure>;
}

export function ImageWorkspace({ ready, busy, error, images, resultPrompt, hasConversation, onGenerate, onOpenConversation, onOpenSettings, onLoadImage }: ImageWorkspaceProps) {
  const promptId = useId();
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const submissionRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!ready || busy || submissionRef.current || !prompt) return;
    submissionRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onGenerate(prompt);
    } catch (reason) {
      if (mountedRef.current) setSubmitError(reason instanceof Error && reason.message ? reason.message : "图片生成失败，请重试");
    } finally {
      submissionRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  const generating = busy || submitting;
  const shownError = error || submitError;
  return <section className="image-workspace" aria-label="图片创作工作台">
    <div className="image-workspace-inner">
      <header className="image-workspace-header">
        <div><div className="image-workspace-eyebrow"><Sparkles size={15} aria-hidden="true" />图片创作</div><h1>让想法成为画面</h1><p>用文字描述你想看到的，开始一次新的创作。</p></div>
        <button className="image-workspace-settings" type="button" onClick={onOpenSettings}><Settings2 size={16} aria-hidden="true" />设置图片模型<ArrowRight size={14} aria-hidden="true" /></button>
      </header>
      <div className="image-workspace-layout">
        <form className="image-workspace-compose" onSubmit={handleSubmit}>
          <div className="image-workspace-section-heading"><div><span className="image-workspace-index">01 / 描述</span><h2>你想创作什么？</h2></div><div className="image-workspace-heading-icon" aria-hidden="true"><Sparkles size={18} /></div></div>
          <label className="image-workspace-label" htmlFor={promptId}>画面描述</label>
          <textarea id={promptId} value={draft} onChange={event => setDraft(event.target.value)} placeholder="描述主体、场景和你喜欢的氛围…" rows={7} />
          <div className="image-workspace-examples"><p>从一个灵感开始</p><div>{examples.map(example => <button key={example.label} type="button" onClick={() => setDraft(example.prompt)}>{example.label}<ArrowRight size={13} aria-hidden="true" /></button>)}</div></div>
          {shownError ? <p className="image-workspace-error" role="alert">{shownError}</p> : null}
          <div className="image-workspace-compose-footer">
            <p><span className="image-workspace-model-dot" aria-hidden="true" />优先使用默认图片模型</p>
            <button className="image-workspace-generate" type="submit" disabled={!ready || generating || !draft.trim()}>{!ready ? <><LoaderCircle className="image-workspace-spin" size={17} aria-hidden="true" />正在准备…</> : generating ? <><LoaderCircle className="image-workspace-spin" size={17} aria-hidden="true" />正在生成…</> : <><Sparkles size={17} aria-hidden="true" />生成图片<ArrowRight size={16} aria-hidden="true" /></>}</button>
          </div>
        </form>
        <section className="image-workspace-output" aria-label="生成结果" aria-busy={generating}>
          <header className="image-workspace-output-header"><div><span className="image-workspace-index">02 / 画面</span><h2>最新生成</h2></div>{hasConversation ? <button type="button" className="image-workspace-conversation" onClick={onOpenConversation} disabled={generating}><MessageCircle size={15} aria-hidden="true" />查看所属对话<ArrowRight size={14} aria-hidden="true" /></button> : null}</header>
          {generating ? <div className="image-workspace-progress" role="status"><LoaderCircle className="image-workspace-spin" size={16} aria-hidden="true" />正在生成图片，请稍候…</div> : null}
          {images.length > 0 ? <>
            <div className="image-workspace-grid">{images.map(asset => <ResultImage key={asset.id} asset={asset} onLoadImage={onLoadImage} />)}</div>
            {resultPrompt?.trim() ? <details className="image-workspace-prompt"><summary>查看生成描述</summary><p>{resultPrompt}</p></details> : null}
          </> : !generating ? <div className="image-workspace-empty"><div className="image-workspace-empty-icon" aria-hidden="true"><ImageIcon size={25} /><Sparkles size={14} /></div><h3>{shownError ? "这次没有生成图片" : "从一个想法开始"}</h3><p>{shownError ? "请根据提示检查后再试。" : "写下你的画面描述，生成的图片会出现在这里。"}</p></div> : null}
        </section>
      </div>
    </div>
  </section>;
}
