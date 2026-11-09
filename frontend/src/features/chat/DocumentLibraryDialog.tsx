import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { LibraryFolder } from "../../types";
import { DocumentEditor } from "./DocumentEditor";
import type { DocumentService, DocumentSummary, SavedDocument } from "./document-service";
import "./results.css";

export function DocumentLibraryDialog({ service, initialDocumentId, folders, onContinue, onArchived, onClose }: {
  service: DocumentService; initialDocumentId?: string | null; folders?: LibraryFolder[]; onContinue?: (document: SavedDocument, signal: AbortSignal) => Promise<void>; onArchived?: () => void; onClose: () => void;
}) {
  const [store, setStore] = useState<{ service: DocumentService; documents: DocumentSummary[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(initialDocumentId ?? null), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""), [epoch, setEpoch] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const close = () => { if (!dirty || window.confirm("文档还有未保存的草稿，确定关闭并放弃草稿吗？")) onClose(); };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setSelected(initialDocumentId ?? null); setDirty(false); }, [service, initialDocumentId]);
  useEffect(() => {
    const abort = new AbortController(); setError(""); setStore(null);
    void service.list(abort.signal).then(result => { if (!abort.signal.aborted) setStore({ service, documents: result.documents }); }).catch(caught => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "文档列表读取失败"); });
    return () => abort.abort();
  }, [service, epoch]);
  const documents = store?.service === service ? store.documents : null;
  return createPortal(<div className="chat-result-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="chat-result-dialog" role="dialog" aria-modal="true" aria-label="文档成果" ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key !== "Tab") return;
      const fields = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href]")].filter(element => {
        const closed = element.closest("details:not([open])");
        return !element.closest("[hidden],[inert]") && (!closed || element.tagName === "SUMMARY" && element.parentElement === closed);
      });
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
    }}>
      <header><div><h2>{selected ? "文档编辑" : "文档成果"}</h2><p>保存的文档独立于原对话，可查看历史版本。</p></div><button type="button" aria-label="关闭文档成果" onClick={close}><X size={19} /></button></header>
      {selected && documents ? <><div className="chat-result-tools"><button type="button" onClick={() => { if (!dirty || window.confirm("放弃未保存草稿并返回文档列表？")) { setSelected(null); setDirty(false); setEpoch(value => value + 1); } }}>返回文档列表</button></div>
        <DocumentEditor key={selected} documentId={selected} service={service} folders={folders} onDirtyChange={setDirty} onArchived={onArchived} onContinue={onContinue ? async (document, signal) => { await onContinue(document, signal); close(); } : undefined} /></>
        : <div className="document-editor">{error ? <><p role="alert">{error}</p><button type="button" onClick={() => setEpoch(value => value + 1)}>重新读取</button></> : !documents ? <p role="status">正在读取文档…</p> : documents.length ? <ul className="document-library-list">{documents.map(document => <li key={document.document_id}><button type="button" aria-label={`打开文档：${document.title}`} onClick={() => setSelected(document.document_id)}>{document.title}<span>v{document.latest_version}</span></button></li>)}</ul> : <p>还没有保存的文档。可在聊天回答的成果中选择“编辑文档”。</p>}</div>}
    </section>
  </div>, document.body);
}
