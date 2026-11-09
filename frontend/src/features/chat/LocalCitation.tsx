import { createContext, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import { createApiClient, fetchWithTimeout, localCitationPath } from "../../api/client";
import { locatorLabel, type LocalEvidence, type LocalSourceOriginal, type LocalSourcePreview } from "./local-evidence";
import "./results.css";
import "./local-citation.css";

const PdfReader = lazy(() => import("../library/PdfReader"));
export const LocalCitationActionsContext = createContext<((evidence: LocalEvidence) => void) | null>(null);

export function LocalCitation({ evidence, onOpen }: { evidence: LocalEvidence; onOpen: (evidence: LocalEvidence) => void }) {
  const location = locatorLabel(evidence.locator);
  return <button type="button" className="md-local-citation" aria-label={`核对来源：${evidence.title}，${location}`} title={`${evidence.title} · ${location}`} onClick={() => onOpen(evidence)}>
    <FileText size={12} aria-hidden="true" /><span>{location}</span>
  </button>;
}

type PreviewLoader = (evidence: LocalEvidence, signal: AbortSignal) => Promise<LocalSourcePreview>;
type OriginalLoader = (original: LocalSourceOriginal, signal: AbortSignal) => Promise<Blob>;

export function LocalCitationDialog({ evidence, loadPreview, loadOriginal, onClose }: {
  evidence: LocalEvidence; loadPreview: PreviewLoader; loadOriginal: OriginalLoader; onClose: () => void;
}) {
  const [preview, setPreview] = useState<LocalSourcePreview | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState("");
  const [originalError, setOriginalError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
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
  return createPortal(<div className="chat-result-backdrop local-source-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="chat-result-dialog local-source-dialog" role="dialog" aria-modal="true" aria-label="核对本地来源" ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const fields = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],[tabindex='0']")];
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
    }}>
      <header><div><h2>{evidence.title}</h2><p>{locatorLabel(evidence.locator)}</p></div><button type="button" aria-label="关闭来源" onClick={onClose}><X size={19} aria-hidden="true" /></button></header>
      <div className="local-source-body">
        {error ? <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></> : !preview ? <p role="status">正在读取引用版本…</p> : <>
          {!preview.is_current ? <p className="local-source-notice">来源已有更新，当前展示引用时的版本。</p> : null}
          <p className="local-source-caption">回答采用的片段</p><blockquote>{evidence.excerpt}</blockquote>
          {bytes ? <><p className="local-source-caption">已定位到原文件{locatorLabel(preview.locator)}，可对照摘录核对。</p><Suspense fallback={<p role="status">正在加载阅读器…</p>}><PdfReader bytes={bytes} title={evidence.title} initialPage={preview.locator.page} /></Suspense></> : <>
            <p className="local-source-caption">引用版本中的提取文字</p><pre className="local-source-text"><mark>{preview.text}</mark></pre>
            {!preview.original.available ? <p className="local-source-notice">{preview.original.reason}</p> : preview.locator.kind === "pdf_page" && !originalError ? <p role="status">正在加载原文件…</p> : null}
          </>}
          {originalError ? <p role="alert">原文件加载失败，仍可核对提取文字。{originalError}<button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></p> : null}
        </>}
      </div>
    </section>
  </div>, document.body);
}

export function LocalCitationProvider({ apiBase, accessToken, children }: { apiBase: string; accessToken: string; children: ReactNode }) {
  const [selected, setSelected] = useState<LocalEvidence | null>(null);
  const api = useMemo(() => createApiClient(apiBase, accessToken), [apiBase, accessToken]);
  const loadPreview = useCallback<PreviewLoader>((evidence, signal) => api(localCitationPath(evidence), { signal, cache: "no-store" }), [api]);
  const loadOriginal = useCallback<OriginalLoader>(async (original, signal) => {
    const path = original.source_kind === "library" ? `library/sources/${original.source_id}` : `attachments/${encodeURIComponent(original.attachment_id || "")}`;
    const response = await fetchWithTimeout(`${apiBase}/${path}/file`, { signal, cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error("原文件不可读取，请检查来源是否仍可访问");
    return response.blob();
  }, [apiBase, accessToken]);
  return <LocalCitationActionsContext.Provider value={setSelected}>{children}{selected ? <LocalCitationDialog key={selected.citation_id} evidence={selected} loadPreview={loadPreview} loadOriginal={loadOriginal} onClose={() => setSelected(null)} /> : null}</LocalCitationActionsContext.Provider>;
}
