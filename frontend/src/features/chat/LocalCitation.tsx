import { createContext, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, FileText, Library, Paperclip, X } from "lucide-react";
import { createApiClient, fetchWithTimeout, localCitationPath } from "../../api/client";
import { locatorLabel, type LocalEvidence, type LocalSourceOriginal, type LocalSourcePreview } from "./local-evidence";
import "./results.css";
import "./local-citation.css";

const PdfReader = lazy(() => import("../library/PdfReader"));
export const LocalCitationActionsContext = createContext<((evidence: LocalEvidence) => void) | null>(null);

function LocalSourceIdentity({ evidence }: { evidence: LocalEvidence }) {
  const inLibrary = evidence.source_kind === "library";
  return <span className="local-source-identity">
    {inLibrary ? <Library size={13} aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />}
    <span>{inLibrary ? "资料库" : "会话附件"} · {locatorLabel(evidence.locator)}</span>
  </span>;
}

export function LocalCitation({ evidence, onOpen }: { evidence: LocalEvidence; onOpen: (evidence: LocalEvidence) => void }) {
  const location = locatorLabel(evidence.locator);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const restoreFocus = useRef(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const [visible, setVisible] = useState(false);
  const cardId = useId();
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!visible) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") setVisible(false);
    }
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    function placeCard() {
      const anchor = trigger.current?.getBoundingClientRect();
      const node = card.current;
      if (!anchor || !node) return;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const gutter = 8;
      const edge = document.documentElement.clientWidth || window.innerWidth;
      const left = Math.max(gutter, Math.min(anchor.left, edge - width - gutter));
      const below = anchor.bottom + gutter;
      const above = anchor.top - height - gutter;
      node.style.left = `${left}px`;
      const top = below + height <= window.innerHeight - gutter ? below : above;
      node.style.top = `${Math.max(gutter, top)}px`;
    }
    placeCard();
    window.addEventListener("resize", placeCard);
    window.addEventListener("scroll", placeCard, true);
    return () => { window.removeEventListener("resize", placeCard); window.removeEventListener("scroll", placeCard, true); };
  }, [visible, evidence]);

  function enter(event: React.PointerEvent) {
    if (event.pointerType === "touch") return;
    hovered.current = true;
    window.clearTimeout(closeTimer.current);
    setVisible(true);
  }
  function leave(event: React.PointerEvent) {
    if (event.pointerType === "touch") return;
    hovered.current = false;
    window.clearTimeout(closeTimer.current);
    // Keep the preview open long enough to move the mouse over the excerpt.
    closeTimer.current = window.setTimeout(() => {
      if (!focused.current && !hovered.current) setVisible(false);
    }, 150);
  }
  return <>
    <button ref={trigger} type="button" className="md-local-citation" aria-label={`核对来源：${evidence.title}，${location}`} aria-haspopup="dialog" aria-describedby={visible ? cardId : undefined} onPointerEnter={enter} onPointerLeave={leave} onFocus={() => {
      focused.current = true;
      if (restoreFocus.current) { restoreFocus.current = false; return; }
      setVisible(true);
    }} onBlur={() => {
      focused.current = false;
      if (!hovered.current) setVisible(false);
    }} onClick={() => {
      trigger.current?.focus({ preventScroll: true });
      restoreFocus.current = true;
      hovered.current = false;
      setVisible(false);
      onOpen(evidence);
    }}>
      <FileText size={12} aria-hidden="true" /><span>{location}</span>
    </button>
    {visible ? createPortal(<span className="local-context-popover" ref={card} id={cardId} role="tooltip" onPointerEnter={enter} onPointerLeave={leave}>
      <LocalSourceIdentity evidence={evidence} />
      <strong className="local-context-title">{evidence.title}</strong>
      {evidence.excerpt ? <span className="local-context-excerpt">{evidence.excerpt}</span> : null}
      <span className="local-context-footer"><ArrowUpRight size={14} aria-hidden="true" />打开来源核对</span>
    </span>, document.body) : null}
  </>;
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
      <header><div><h2>{evidence.title}</h2><p><LocalSourceIdentity evidence={evidence} /></p></div><button type="button" aria-label="关闭来源" onClick={onClose}><X size={19} aria-hidden="true" /></button></header>
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
