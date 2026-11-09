import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentExport, DocumentExportService, ExportCapabilities, ExportFormat } from "./document-export-service";

export function DocumentExportActions({ service, documentId, version, disabled }: { service: DocumentExportService; documentId: string; version: number; disabled: boolean }) {
  const scope = useMemo(() => ({ service, documentId, version }), [service, documentId, version]);
  const latest = useRef(scope); latest.current = scope;
  const [state, setState] = useState<{ scope: typeof scope; records: DocumentExport[]; capabilities?: ExportCapabilities; error?: string; busy?: boolean }>({ scope, records: [] });
  const current: typeof state = state.scope === scope ? state : { scope, records: [] };
  const controller = useRef<AbortController | null>(null), lock = useRef(false);
  const valid = (signal: AbortSignal) => !signal.aborted && latest.current === scope;
  const read = async (signal: AbortSignal) => {
    const result = await service.list(documentId, version, signal);
    if (valid(signal)) setState(previous => ({ ...previous, records: result.exports, error: undefined }));
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; lock.current = false;
    setState({ scope, records: [] });
    void Promise.all([service.capabilities(abort.signal), service.list(documentId, version, abort.signal)]).then(([capabilities, results]) => {
      if (valid(abort.signal)) setState({ scope, capabilities, records: results.exports });
    }).catch(error => { if (valid(abort.signal)) setState({ scope, records: [], error: String(error) }); });
    return () => { abort.abort(); };
  }, [scope]);
  useEffect(() => {
    if (!current.records.some(record => ["queued", "running"].includes(record.job.status))) return;
    const abort = new AbortController();
    const timer = setTimeout(() => { void read(abort.signal).catch(error => {
      if (valid(abort.signal)) setState(previous => ({ ...previous, error: String(error) }));
    }); }, 1000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [scope, current.records]);
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || lock.current) return;
    lock.current = true; setState(previous => ({ ...previous, busy: true, error: undefined }));
    try { await operation(signal); }
    catch (error) { if (valid(signal)) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : "导出操作失败，请重试" })); }
    finally { if (valid(signal)) { lock.current = false; setState(previous => ({ ...previous, busy: false })); } }
  };
  return <div aria-label="保存版本导出">
    {(["docx", "pdf"] as ExportFormat[]).map(format => {
      const label = format.toUpperCase(), record = current.records.find(item => item.format === format);
      const pending = !!record && ["queued", "running"].includes(record.job.status);
      const capability = current.capabilities?.formats[format];
      return <div className="document-editor-tools" key={format}>
        <button type="button" disabled={disabled || current.busy || pending || !capability?.available} onClick={() => void act(async signal => {
          const result = await service.start(documentId, version, format, signal);
          if (valid(signal)) setState(previous => ({ ...previous, records: [...previous.records.filter(item => item.format !== format), result] }));
        })}>导出 {label} v{version}</button>
        {pending ? <><span role="status">{record.job.status === "queued" ? "等待导出" : "正在导出"} {label}</span><button type="button" disabled={current.busy} onClick={() => void act(async signal => { await service.cancel(record.job.id, signal); await read(signal); })}>取消 {label} 导出</button></> : null}
        {record?.job.status === "interrupted" ? <button type="button" disabled={disabled || current.busy} onClick={() => void act(async signal => { await service.resume(record.job.id, signal); await read(signal); })}>恢复 {label} 导出</button> : null}
        {record?.artifact ? <button type="button" disabled={disabled || current.busy} onClick={() => void act(async signal => {
          const artifact = record.artifact!, data = await service.file(artifact.id, artifact.version, signal);
          if (!valid(signal)) return;
          const url = URL.createObjectURL(data), link = window.document.createElement("a");
          link.href = url; link.download = artifact.filename; window.document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
        })}>下载 {label} v{version}</button> : null}
        {record && ["failed", "cancelled"].includes(record.job.status) ? <span role="status">{record.job.status === "cancelled" ? `${label} 导出已取消` : record.job.error || `${label} 导出失败，请重新导出`}</span> : null}
        {capability && !capability.available ? <span>{capability.reason}</span> : null}
      </div>;
    })}
    {current.error ? <p role="alert">{current.error}<button type="button" disabled={current.busy} onClick={() => void act(async signal => {
      const [capabilities, result] = await Promise.all([service.capabilities(signal), service.list(documentId, version, signal)]);
      if (valid(signal)) setState(previous => ({ ...previous, capabilities, records: result.exports, error: undefined }));
    })}>刷新导出状态</button></p> : null}
  </div>;
}
