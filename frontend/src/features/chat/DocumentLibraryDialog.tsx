import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import type { LibraryFolder } from "../../types";
import { DiscardDraftDialog } from "./DiscardDraftDialog";
import { DocumentEditor } from "./DocumentEditor";
import type { DocumentService, DocumentSummary, SavedDocument } from "./document-service";
import "./results.css";

export function DocumentLibraryDialog({ service, initialDocumentId, folders, onContinue, onArchived, onClose }: {
  service: DocumentService; initialDocumentId?: string | null; folders?: LibraryFolder[]; onContinue?: (document: SavedDocument, signal: AbortSignal) => Promise<void>; onArchived?: () => void; onClose: () => void;
}) {
  const [store, setStore] = useState<{ service: DocumentService; documents: DocumentSummary[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(initialDocumentId ?? null), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""), [epoch, setEpoch] = useState(0);
  const [discardAction, setDiscardAction] = useState<"close" | "back" | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  function finishExit(action: "close" | "back") {
    if (action === "close") onClose();
    else {
      setSelected(null);
      setDirty(false);
      setEpoch(value => value + 1);
    }
  }

  function requestExit(action: "close" | "back") {
    if (dirty) setDiscardAction(action);
    else finishExit(action);
  }

  useEffect(() => {
    setSelected(initialDocumentId ?? null);
    setDirty(false);
    setDiscardAction(null);
  }, [service, initialDocumentId]);
  useEffect(() => {
    const abort = new AbortController(); setError(""); setStore(null);
    void service.list(abort.signal).then(result => { if (!abort.signal.aborted) setStore({ service, documents: result.documents }); }).catch(caught => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "文档列表读取失败"); });
    return () => abort.abort();
  }, [service, epoch]);
  const documents = store?.service === service ? store.documents : null;
  return <Dialog open onOpenChange={(open, event) => {
    if (open) return;
    if (dirty) event.cancel();
    requestExit("close");
  }}>
    <DialogContent className="chat-result-dialog" backdropClassName="chat-result-backdrop" aria-modal="true" initialFocus={closeButton}>
      <header>
        <div><DialogTitle>{selected ? "文档编辑" : "文档成果"}</DialogTitle><DialogDescription>保存的文档独立于原对话，可查看历史版本。</DialogDescription></div>
        <DialogClose ref={closeButton} type="button" aria-label="关闭文档成果"><X size={19} aria-hidden="true" /></DialogClose>
      </header>
      {selected && documents ? <><div className="chat-result-tools"><button type="button" onClick={() => requestExit("back")}>返回文档列表</button></div>
        <DocumentEditor key={selected} documentId={selected} service={service} folders={folders} onDirtyChange={setDirty} onArchived={onArchived} onContinue={onContinue ? async (document, signal) => { await onContinue(document, signal); requestExit("close"); } : undefined} /></>
        : <div className="document-editor">{error ? <><p role="alert">{error}</p><button type="button" onClick={() => setEpoch(value => value + 1)}>重新读取</button></> : !documents ? <p role="status">正在读取文档…</p> : documents.length ? <ul className="document-library-list">{documents.map(document => <li key={document.document_id}><button type="button" aria-label={`打开文档：${document.title}`} onClick={() => setSelected(document.document_id)}>{document.title}<span>v{document.latest_version}</span></button></li>)}</ul> : <p>还没有保存的文档。可在聊天回答的成果中选择“编辑文档”。</p>}</div>}
      <DiscardDraftDialog
        open={discardAction !== null}
        description={discardAction === "back" ? "放弃未保存草稿并返回文档列表？" : "文档还有未保存的草稿，确定关闭并放弃草稿吗？"}
        onCancel={() => setDiscardAction(null)}
        onDiscard={() => {
          if (!discardAction) return;
          setDiscardAction(null);
          finishExit(discardAction);
        }}
      />
    </DialogContent>
  </Dialog>;
}
