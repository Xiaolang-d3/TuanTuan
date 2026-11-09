import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryFolder } from "../../types";
import { MarkdownContent } from "./ChatMarkdown";
import { isLocalEvidence } from "./local-evidence";
import { downloadText, markdownToText } from "./result-files";
import type { DocumentService, DocumentVersionSummary, SavedDocument } from "./document-service";
import "./document-editor.css";

type Props = { documentId: string; service: DocumentService; folders?: LibraryFolder[];
  onContinue?: (document: SavedDocument, signal: AbortSignal) => Promise<void>; onArchived?: () => void; onDirtyChange?: (dirty: boolean) => void };
type Draft = { base: string; text: string };

export function DocumentEditor({ documentId, service, folders = [], onContinue, onArchived, onDirtyChange }: Props) {
  const scope = useMemo(() => ({ service, documentId }), [service, documentId]);
  const latestScope = useRef(scope); latestScope.current = scope;
  const [store, setStore] = useState<{ scope: typeof scope; document: SavedDocument | null; versions: DocumentVersionSummary[]; drafts: Record<number, Draft> }>({ scope, document: null, versions: [], drafts: {} });
  const [error, setError] = useState<{ scope: typeof scope; text: string } | null>(null);
  const [reading, setReading] = useState<typeof scope | null>(scope);
  const [working, setWorking] = useState<typeof scope | null>(null);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [folder, setFolder] = useState("");
  const [enabled, setEnabled] = useState(false);
  const alive = useRef(true), readSerial = useRef(0);
  const readAbort = useRef<AbortController | null>(null), actionAbort = useRef<AbortController | null>(null);
  const inFlight = useRef<symbol | null>(null);
  const receipts = useRef<Record<string, { fingerprint: string; key: string }>>({});
  const current = store.scope === scope ? store : null;
  const document = current?.document;
  const markdown = document ? current?.drafts[document.version]?.text ?? document.markdown : "";
  const dirty = !!document && markdown !== document.markdown;
  const hasDrafts = Object.values(current?.drafts ?? {}).some(draft => draft.text !== draft.base);
  const busy = reading === scope || working === scope;
  const valid = () => alive.current && latestScope.current === scope;
  const receipt = (kind: string, fingerprint: string) => {
    if (receipts.current[kind]?.fingerprint !== fingerprint) receipts.current[kind] = { fingerprint, key: crypto.randomUUID() };
    return receipts.current[kind].key;
  };

  const load = useCallback(async (version?: number) => {
    readAbort.current?.abort();
    const abort = new AbortController(), serial = ++readSerial.current;
    readAbort.current = abort; setReading(scope); setError(null); setNotice("");
    try {
      const [document, history] = await Promise.all([version === undefined ? service.latest(documentId, abort.signal) : service.get(documentId, version, abort.signal), service.versions(documentId, abort.signal)]);
      if (abort.signal.aborted || latestScope.current !== scope || serial !== readSerial.current) return;
      setStore(previous => ({ scope, document, versions: history.versions, drafts: previous.scope === scope ? previous.drafts : {} }));
      setFilename(previous => previous || `${document.title}.md`);
    } catch (caught) {
      if (!abort.signal.aborted && latestScope.current === scope) setError({ scope, text: caught instanceof Error ? caught.message : "文档读取失败，请重试" });
    } finally {
      if (!abort.signal.aborted && latestScope.current === scope && serial === readSerial.current) setReading(null);
    }
  }, [scope, documentId, service]);
  useEffect(() => {
    alive.current = true; inFlight.current = null; receipts.current = {}; setWorking(null); setFilename(""); setFolder(""); setEnabled(false); setArchiveOpen(false); setPreview(false);
    void load();
    return () => { alive.current = false; readAbort.current?.abort(); actionAbort.current?.abort(); };
  }, [load]);
  useEffect(() => { onDirtyChange?.(hasDrafts); }, [hasDrafts, onDirtyChange]);
  useEffect(() => {
    if (!hasDrafts) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasDrafts]);

  async function operate(action: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current || busy) return;
    const token = Symbol(), abort = new AbortController();
    inFlight.current = token; actionAbort.current = abort; setWorking(scope); setError(null);
    try { await action(abort.signal); }
    catch (caught) { if (valid() && !abort.signal.aborted) setError({ scope, text: caught instanceof Error ? caught.message : "操作未完成，请重试" }); }
    finally { if (inFlight.current === token) { inFlight.current = null; if (valid()) setWorking(null); } }
  }
  async function save(signal: AbortSignal) {
    if (!document || !dirty) return;
    const saved = await service.save(documentId, { base_version: document.version, markdown,
      idempotency_key: receipt("save", JSON.stringify([document.version, markdown])) }, signal);
    if (!valid() || signal.aborted) return;
    if (saved.document_id !== documentId || saved.version <= document.version) throw new Error("保存版本不匹配，请刷新后核对");
    setStore(previous => {
      if (previous.scope !== scope) return previous;
      const drafts = { ...previous.drafts }; delete drafts[document.version];
      return { ...previous, document: saved, drafts, versions: [{ version: saved.version, parent_document_version: saved.parent_document_version, created_at: saved.created_at }, ...previous.versions.filter(item => item.version !== saved.version)] };
    });
    setNotice(`已保存 v${saved.version}`);
  }
  const imageLoader = useCallback(async (uri: string, signal: AbortSignal) => {
    const resource = document?.resources.find(item => item.uri === uri);
    if (!resource) throw new Error("图片不属于此保存版本的资源清单");
    return service.resource(documentId, resource.id, signal);
  }, [document, documentId, service]);

  if (!document) return <section className="document-editor" aria-label="文档编辑器">{error?.scope === scope ? <><p role="alert">{error.text}</p><button type="button" onClick={() => void load()}>重新读取</button></> : <p role="status">正在读取文档…</p>}</section>;
  return <section className="document-editor" aria-label="文档编辑器">
    <div className="document-editor-tools">
      <label>文档版本<select aria-label="文档版本" disabled={busy} value={document.version} onChange={event => void load(Number(event.target.value))}>{current?.versions.map(item => <option key={item.version} value={item.version}>v{item.version}{item.version === document.latest_version ? " · 最新" : ""}</option>)}</select></label>
      <button type="button" disabled={busy || !dirty || document.version !== document.latest_version} onClick={() => void operate(save)}>保存新版本</button>
      <button type="button" disabled={busy} onClick={() => void load()}>读取最新版本</button>
      <button type="button" onClick={() => downloadText(document.markdown, `${document.title}-v${document.version}.md`, "text/markdown")}>Markdown</button>
      <button type="button" onClick={() => downloadText(markdownToText(document.markdown), `${document.title}-v${document.version}.txt`)}>TXT</button>
      <button type="button" disabled={busy || dirty} aria-expanded={archiveOpen} onClick={() => setArchiveOpen(value => !value)}>归档此保存版本</button>
      {onContinue ? <button type="button" disabled={busy || dirty} onClick={() => void operate(signal => onContinue(document, signal))}>用 v{document.version} 继续对话</button> : null}
    </div>
    <p className="document-editor-state" role="status">{notice || (dirty ? "有未保存修改；归档、下载和继续对话均使用保存版本。" : document.version === document.latest_version ? `已保存版本 v${document.version}` : `历史版本 v${document.version} · 可复制、下载或用于对话`)}</p>
    {onContinue ? <p className="document-editor-state">继续对话会将所选保存版本加入新对话，输入修改要求后发送。</p> : null}
    {service.exports ? <DocumentExportActions service={service.exports} documentId={documentId} version={document.version} disabled={busy || dirty} /> : null}
    {document.incomplete ? <p>此文档来自尚未完整完成的回答。</p> : null}
    {error?.scope === scope ? <p role="alert">{error.text}</p> : null}
    {archiveOpen ? <form className="document-editor-archive" onSubmit={event => { event.preventDefault(); void operate(async signal => {
      const input = { filename: filename.trim(), folder_id: folder ? Number(folder) : null, enabled };
      await service.archive(documentId, document.version, { ...input, idempotency_key: receipt("archive", JSON.stringify([document.version, input])) }, signal);
      if (valid() && !signal.aborted) { setNotice(`已将 v${document.version} 归档到文件库`); onArchived?.(); }
    }); }}>
      <label>文件名<input required maxLength={200} value={filename} disabled={busy} onChange={event => setFilename(event.target.value)} /></label>
      <label>文件夹<select value={folder} disabled={busy} onChange={event => setFolder(event.target.value)}><option value="">全部文件</option>{folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="document-editor-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />作为知识依据使用</label>
      <button type="submit" disabled={busy || dirty || !filename.trim()}>确认归档 v{document.version}</button>
    </form> : null}
    <nav className="document-editor-tools" aria-label="文档视图"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button></nav>
    {preview ? <div className="chat-result-body document-editor-preview"><MarkdownContent allowRemoteImages={false} imageLoader={imageLoader} localEvidence={document.evidence.filter(isLocalEvidence)}>{markdown}</MarkdownContent></div>
      : <label className="document-editor-body">文档正文<textarea aria-label="文档正文" maxLength={200000} value={markdown} readOnly={busy || document.version !== document.latest_version} onChange={event => {
        const text = event.target.value; setNotice(""); setStore(previous => previous.scope !== scope ? previous : { ...previous, drafts: { ...previous.drafts, [document.version]: { base: document.markdown, text } } });
      }} /></label>}
    {document.citations.some(item => item.status !== "verified") ? <p>部分引用尚未核对，请打开来源对照。</p> : null}
    {Object.entries(current?.drafts ?? {}).filter(([version, draft]) => Number(version) !== document.version && draft.text !== draft.base).map(([version, draft]) => <details key={version} className="document-editor-draft"><summary>保留的草稿 v{version}</summary><textarea aria-label={`保留的草稿 v${version}`} readOnly value={draft.text} /></details>)}
  </section>;
}
import { DocumentExportActions } from "./DocumentExportActions";
