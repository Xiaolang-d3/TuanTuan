import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FolderPlus, X } from "lucide-react";
import { MarkdownContent } from "./ChatMarkdown";
import { isLocalEvidence } from "./local-evidence";
import { downloadBlob, downloadText, markdownToText } from "./result-files";
import { PngExportButton } from "./PngExportButton";
import { DocumentEditor } from "./DocumentEditor";
import type { ArtifactManifest, ResultServices } from "./result-types";
import "./results.css";

export function ResultDialog({ messageId, conversationId, selector = "answer", saving = false, editing = false, services, onClose }: {
  messageId: number; conversationId?: number; selector?: string; saving?: boolean; editing?: boolean; services: ResultServices; onClose: () => void;
}) {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null);
  const [selected, setSelected] = useState(selector);
  const [filename, setFilename] = useState("");
  const [folder, setFolder] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saveOpen, setSaveOpen] = useState(saving);
  const [saved, setSaved] = useState<{ id: number; reused: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentDirty, setDocumentDirty] = useState(false);
  const creatingDocument = useRef(false);
  const attemptedEditing = useRef("");
  const dialog = useRef<HTMLElement>(null);
  const controller = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const serviceRef = useRef(services);
  serviceRef.current = services;
  const close = () => { if (!documentDirty || window.confirm("文档还有未保存的草稿，确定关闭并放弃草稿吗？")) onClose(); };
  async function editDocument() {
    const documents = services.documentService, signal = controller.current?.signal;
    if (!documents || !manifest || !conversationId || creatingDocument.current || busy || signal?.aborted) return;
    creatingDocument.current = true; setBusy(true); setError("");
    try {
      const doc = await documents.create({ conversation_id: conversationId, message_id: messageId, snapshot: manifest.snapshot, idempotency_key: `document:${conversationId}:${messageId}:${manifest.snapshot}` }, signal);
      if (!signal?.aborted && serviceRef.current.documentService === documents) setDocumentId(doc.document_id);
    } catch (reason) { if (!signal?.aborted && serviceRef.current.documentService === documents) setError(reason instanceof Error ? reason.message : "文档创建失败，请重试"); }
    finally { creatingDocument.current = false; if (!signal?.aborted) setBusy(false); }
  }
  const artifact = manifest?.artifacts.find(item => item.selector === selected);
  const imageLoader = useCallback(async (src: string, signal: AbortSignal) => {
    const id = src.match(/^assets\/([a-f0-9]{32})\.(png|jpg|webp)$/)?.[1];
    const asset = artifact?.assets?.find(item => item.id === id) ?? artifact?.asset;
    if (!asset || !serviceRef.current.onLoadAttachment) throw new Error("图片读取暂不可用");
    return (await serviceRef.current.onLoadAttachment(asset, signal)).file;
  }, [artifact]);
  async function downloadImage() {
    if (!artifact?.asset || !services.onLoadAttachment || busy) return;
    const signal = controller.current?.signal;
    setBusy(true); setError("");
    try {
      const { file } = await services.onLoadAttachment(artifact.asset, signal);
      if (!signal?.aborted) downloadBlob(file, artifact.filename);
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "图片下载失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setManifest(null);
    setError("");
    void (async () => {
      try {
        if (!serviceRef.current.onLoadResults) throw new Error("成果读取暂不可用");
        const data = await serviceRef.current.onLoadResults(messageId, abort.signal);
        if (abort.signal.aborted) return;
        setManifest(data);
        const first = data.artifacts.find(item => item.selector === selector) ?? data.artifacts[0];
        setSelected(first?.selector ?? "");
        setFilename(first?.filename ?? "");
      } catch (reason) {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "成果读取失败");
      }
    })();
    return () => abort.abort();
  }, [messageId, selector, attempt]);

  useEffect(() => {
    if (editing && manifest && services.documentService && conversationId && !documentId && attemptedEditing.current !== manifest.snapshot) {
      attemptedEditing.current = manifest.snapshot;
      void editDocument();
    }
  }, [editing, manifest, services.documentService, conversationId, documentId]);

  async function save() {
    const signal = controller.current?.signal;
    if (!artifact || !manifest || !services.onSaveResult || savingRef.current || signal?.aborted) return;
    savingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await services.onSaveResult(messageId, { selector: artifact.selector, snapshot: manifest.snapshot, filename: filename.trim(), folder_id: folder ? Number(folder) : null, enabled }, signal);
      if (!signal?.aborted) setSaved({ id: result.source.id, reused: result.reused });
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "保存失败，请重试");
    } finally { savingRef.current = false; if (!signal?.aborted) setBusy(false); }
  }

  return createPortal(<div className="chat-result-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="chat-result-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="聊天成果" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key !== "Tab") return;
      const fields = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex='0']")].filter(element => {
        const closed = element.closest("details:not([open])");
        return !element.closest("[hidden],[inert]") && (!closed || element.tagName === "SUMMARY" && element.parentElement === closed);
      });
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
    }}>
      <header><div><h2>{documentId ? "文档编辑" : "聊天成果"}</h2><p>{manifest?.incomplete ? "未完成的执行 · 已保留现有内容" : "阅读、下载或保存到文件库"}</p></div><button type="button" aria-label="关闭成果" onClick={close}><X size={19} /></button></header>
      {documentId && services.documentService ? <><div className="chat-result-tools"><button type="button" onClick={() => { if (!documentDirty || window.confirm("放弃未保存的文档草稿，返回聊天成果？")) { setDocumentId(null); setDocumentDirty(false); } }}>返回聊天成果</button></div><DocumentEditor key={documentId} documentId={documentId} service={services.documentService} folders={services.resultFolders} onDirtyChange={setDocumentDirty} onArchived={services.onDocumentArchived} onContinue={services.onContinueDocument ? async (document, signal) => { await services.onContinueDocument!(document, signal); close(); } : undefined} /></>
        : !manifest ? <div className="chat-result-empty">{error ? <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></> : <p role="status">正在读取成果…</p>}</div> : !artifact ? <p className="chat-result-empty">暂无可保存的成果。</p> : <>
        <div className="chat-result-tools"><label>成果<select aria-label="选择成果" value={selected} disabled={busy} onChange={event => {
          const next = manifest.artifacts.find(item => item.selector === event.target.value)!;
          setSelected(next.selector); setFilename(next.filename); setEnabled(false); setSaved(null); setError("");
        }}>{manifest.artifacts.map(item => <option key={item.selector} value={item.selector}>{item.filename}</option>)}</select></label>
          {artifact.content !== undefined ? <><button type="button" onClick={() => downloadText(artifact.content!, artifact.filename, artifact.mime_type)}><Download size={15} />{artifact.kind === "answer" ? "Markdown" : "下载源文件"}</button>{artifact.kind === "answer" ? <button type="button" onClick={() => downloadText(markdownToText(artifact.content!), artifact.filename.replace(/\.md$/, ".txt"))}>TXT</button> : null}</> : null}
          {services.onSaveResult ? <button type="button" aria-expanded={saveOpen} onClick={() => setSaveOpen(value => !value)}><FolderPlus size={15} />保存到文件库</button> : null}
          {artifact.kind === "answer" && services.documentService && conversationId ? <button type="button" disabled={busy} onClick={() => void editDocument()}>编辑文档</button> : null}
          {artifact.asset && services.onLoadAttachment && artifact.mime_type !== "image/png" ? <PngExportButton key={artifact.asset.id} filename={artifact.filename} disabled={busy} load={async signal => (await services.onLoadAttachment!(artifact.asset!, signal)).file} /> : null}
          {artifact.asset && services.onLoadAttachment ? <button type="button" disabled={busy} onClick={() => void downloadImage()}><Download size={15} />下载原图</button> : null}
        </div>
        {artifact.assets?.length ? <p className="chat-result-notice">Markdown 下载保留图片引用；图片可分别下载。保存到文件库会同时保存文字与图片副本。</p> : null}
        {error && !saveOpen ? <p role="alert">{error}</p> : null}
        {saveOpen ? <form className="chat-result-save" onSubmit={event => { event.preventDefault(); void save(); }}>
          {saved ? <div className="chat-result-saved" role="status"><span>{saved.reused ? "已保存，返回已有文件" : "已保存到文件库"}</span>{services.onOpenSavedResult ? <button type="button" onClick={() => { services.onOpenSavedResult?.(saved.id); onClose(); }}>打开文件</button> : null}</div> : <>
            <label>文件名<input aria-label="文件名" required maxLength={200} value={filename} disabled={busy} onChange={event => setFilename(event.target.value)} /></label>
            <label>文件夹<select aria-label="文件夹" value={folder} disabled={busy} onChange={event => setFolder(event.target.value)}><option value="">全部文件</option>{(manifest.folders ?? services.resultFolders)?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="chat-result-knowledge"><input type="checkbox" checked={enabled} disabled={busy || !artifact.can_index} onChange={event => setEnabled(event.target.checked)} />作为知识依据使用</label>
            <p>{artifact.can_index ? "默认只存档；勾选后，模型可检索脱敏文本。" : "该成果没有可检索文字，将完整保存原文件。"}</p>
            <button type="submit" disabled={busy || !filename.trim()}>{busy ? "正在保存…" : "确认保存"}</button>
          </>}
          {error ? <p role="alert">{error}</p> : null}
        </form> : null}
        <div className="chat-result-body">{artifact.kind === "answer" ? <MarkdownContent localEvidence={manifest.sources?.filter(isLocalEvidence)} imageLoader={imageLoader}>{artifact.content ?? ""}</MarkdownContent> : artifact.asset ? <MarkdownContent imageLoader={imageLoader}>{`![生成图片](assets/${artifact.asset.id}.${artifact.mime_type === "image/jpeg" ? "jpg" : artifact.mime_type.split("/")[1]})`}</MarkdownContent> : artifact.content !== undefined ? <pre><code>{artifact.content}</code></pre> : <p>保存原附件的独立副本；原文件可在聊天附件预览中查看和下载。</p>}</div>
      </>}
    </section>
  </div>, document.body);
}
