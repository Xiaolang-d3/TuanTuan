import { createContext, lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { ArrowUpRight, FileText, Library, Paperclip, X } from "lucide-react";
import { createApiClient, fetchWithTimeout, localCitationPath } from "../../api/client";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/Dialog";
import { locatorLabel, type LocalEvidence, type LocalSourceOriginal, type LocalSourcePreview } from "./local-evidence";
import "./results.css";
import "./local-citation.css";

const PdfReader = lazy(() => import("../library/PdfReader"));
type CitationLoaders = {
  loadPreview: (evidence: LocalEvidence, signal: AbortSignal) => Promise<LocalSourcePreview>;
  loadOriginal: (original: LocalSourceOriginal, signal: AbortSignal) => Promise<Blob>;
};

export const LocalCitationContext = createContext<CitationLoaders | null>(null);

function LocalSourceIdentity({ evidence }: { evidence: LocalEvidence }) {
  const inLibrary = evidence.source_kind === "library";
  return <span className="local-source-identity">
    {inLibrary ? <Library size={13} aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />}
    <span>{inLibrary ? "资料库" : "会话附件"} · {locatorLabel(evidence.locator)}</span>
  </span>;
}

export function LocalCitation({ evidence, loaders }: { evidence: LocalEvidence; loaders: CitationLoaders }) {
  const location = locatorLabel(evidence.locator);
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = useId();

  return <Dialog open={open} onOpenChange={setOpen}>
    <Tooltip.Root disabled={open} onOpenChange={setPreviewOpen}>
      <Tooltip.Trigger
        render={<DialogTrigger />}
        delay={0}
        closeDelay={150}
        type="button"
        className="md-local-citation"
        aria-label={`核对来源：${evidence.title}，${location}`}
        aria-describedby={previewOpen && !open ? previewId : undefined}
      >
        <FileText size={12} aria-hidden="true" /><span>{location}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner
          className="local-context-positioner"
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        >
          <Tooltip.Popup render={<span />} className="local-context-popover" id={previewId} role="tooltip">
            <LocalSourceIdentity evidence={evidence} />
            <strong className="local-context-title">{evidence.title}</strong>
            {evidence.excerpt ? <span className="local-context-excerpt">{evidence.excerpt}</span> : null}
            <span className="local-context-footer"><ArrowUpRight size={14} aria-hidden="true" />打开来源核对</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
    {open ? <LocalCitationDialog evidence={evidence} {...loaders} /> : null}
  </Dialog>;
}

function LocalCitationDialog({ evidence, loadPreview, loadOriginal }: { evidence: LocalEvidence } & CitationLoaders) {
  const [preview, setPreview] = useState<LocalSourcePreview | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState("");
  const [originalError, setOriginalError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(null); setBytes(null); setError(""); setOriginalError("");
    void (async () => {
      try {
        const data = await loadPreview(evidence, abort.signal);
        if (abort.signal.aborted) return;
        setPreview(data);
        if (data.locator.kind === "pdf_page" && data.original.available && data.original.mime_type === "application/pdf") {
          try {
            const file = await loadOriginal(data.original, abort.signal);
            const buffer = await file.arrayBuffer();
            if (!abort.signal.aborted) setBytes(new Uint8Array(buffer));
          } catch (reason) {
            if (!abort.signal.aborted) setOriginalError(reason instanceof Error ? reason.message : "原文件加载失败");
          }
        }
      } catch (reason) {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "来源读取失败");
      }
    })();
    return () => abort.abort();
  }, [evidence, loadPreview, loadOriginal, attempt]);
  return <DialogContent
    className="chat-result-dialog local-source-dialog"
    backdropClassName="chat-result-backdrop local-source-backdrop"
    forceBackdrop
    aria-modal="true"
    initialFocus={closeButton}
  >
      <header>
        <div><DialogTitle>{evidence.title}</DialogTitle><DialogDescription><LocalSourceIdentity evidence={evidence} /></DialogDescription></div>
        <DialogClose ref={closeButton} type="button" aria-label="关闭来源"><X size={19} aria-hidden="true" /></DialogClose>
      </header>
      <div className="local-source-body">
        {error ? <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></> : !preview ? <p role="status">正在读取引用版本…</p> : <>
          <div className="local-context-detail">
            <p className="local-source-caption"><FileText size={14} aria-hidden="true" />回答采用的片段</p>
            <blockquote>{evidence.excerpt}</blockquote>
            {!preview.is_current ? <p className="local-source-notice">来源已有更新，当前展示引用时的版本。</p> : null}
          </div>
          {bytes ? <><p className="local-source-caption">已定位到原文件{locatorLabel(preview.locator)}，可对照摘录核对。</p><Suspense fallback={<p role="status">正在加载阅读器…</p>}><PdfReader bytes={bytes} title={evidence.title} initialPage={preview.locator.page} /></Suspense></> : <>
            <p className="local-source-caption">引用版本中的提取文字</p><pre className="local-source-text"><mark>{preview.text}</mark></pre>
            {!preview.original.available ? <p className="local-source-notice">{preview.original.reason}</p> : preview.locator.kind === "pdf_page" && !originalError ? <p role="status">正在加载原文件…</p> : null}
          </>}
          {originalError ? <p role="alert">原文件加载失败，仍可核对提取文字。{originalError}<button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></p> : null}
        </>}
      </div>
  </DialogContent>;
}

export function LocalCitationProvider({ apiBase, accessToken, children }: { apiBase: string; accessToken: string; children: ReactNode }) {
  const loaders = useMemo<CitationLoaders>(() => {
    const api = createApiClient(apiBase, accessToken);
    return {
      loadPreview: (evidence, signal) => api(localCitationPath(evidence), { signal, cache: "no-store" }),
      async loadOriginal(original, signal) {
        const path = original.source_kind === "library" ? `library/sources/${original.source_id}` : `attachments/${encodeURIComponent(original.attachment_id || "")}`;
        const response = await fetchWithTimeout(`${apiBase}/${path}/file`, { signal, cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error("原文件不可读取，请检查来源是否仍可访问");
        return response.blob();
      }
    };
  }, [apiBase, accessToken]);
  return <LocalCitationContext.Provider value={loaders}>{children}</LocalCitationContext.Provider>;
}
