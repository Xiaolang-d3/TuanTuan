import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Download, FolderPlus } from "lucide-react";
import { HistoryAttachment } from "./HistoryAttachment";
import { AttachmentPreviewContext } from "./AttachmentPreviewDialog";
import { ResultActionsContext } from "./result-types";
import { downloadBlob } from "./result-files";
import { PngExportButton } from "./PngExportButton";
import type { ChatAttachment, ChatWorkspaceProps } from "./types";

export const LatestGeneratedImageContext = createContext<string | undefined>(undefined);

export const AssetOriginalContext = createContext<ChatWorkspaceProps["onLoadAttachment"]>(undefined);

export function GeneratedImage({ asset, messageId, prompt }: { asset: ChatAttachment; messageId: number; prompt?: string | null }) {
  const latestImageId = useContext(LatestGeneratedImageContext);
  const preview = useContext(AttachmentPreviewContext);
  const save = useContext(ResultActionsContext);
  const load = useContext(AssetOriginalContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");
  const imageWidth = asset.width && asset.height && asset.width > 0 && asset.height > 0
    ? Math.min(400, 320 * asset.width / asset.height) : undefined;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    if (!load || controller.current && !controller.current.signal.aborted) return;
    const abort = new AbortController();
    controller.current = abort; setBusy(true); setError("");
    try {
      const { file } = await load(asset, abort.signal);
      if (!abort.signal.aborted) downloadBlob(file, asset.original_filename);
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "图片下载失败"); }
    finally { if (!abort.signal.aborted) { setBusy(false); controller.current = null; } }
  }
  async function copyPrompt() {
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); setCopyState("已复制提示词"); }
    catch { setCopyState("复制失败，请选择提示词后手动复制"); }
  }
  return <figure className="chat-generated-image" data-actions={latestImageId === undefined || latestImageId === asset.id || busy ? "always" : "hover"} aria-label="模型生成图片" style={imageWidth ? { maxWidth: imageWidth } : undefined}>
    <HistoryAttachment variant="generated" attachment={asset} onPreview={() => preview?.(asset)} />
    <figcaption>
      {asset.width && asset.height ? <span className="generated-image-dimensions">{asset.width} × {asset.height}</span> : null}
      <div className="generated-image-actions" role="group" aria-label="图片操作">
        {save && messageId > 0 ? <button type="button" aria-label={`保存 ${asset.original_filename} 到文件库`} onClick={() => save(messageId, `asset:${asset.id}`, true)}><FolderPlus size={14} aria-hidden="true" />保存到文件库</button> : null}
        {load ? <PngExportButton key={asset.id} filename={asset.original_filename} load={async signal => (await load(asset, signal)).file} /> : null}
        {load ? <button type="button" disabled={busy} onClick={() => void download()}><Download size={14} aria-hidden="true" />{busy ? "正在下载…" : "下载原图"}</button> : null}
      </div>
    </figcaption>
    {prompt?.trim() ? <details className="generated-image-prompt" onToggle={() => setCopyState("")}>
      <summary><ChevronRight size={13} aria-hidden="true" />生成提示词</summary>
      <div className="generated-image-prompt-body">
        <p>{prompt}</p>
        <button type="button" onClick={() => void copyPrompt()}><Copy size={13} aria-hidden="true" />复制提示词</button>
        {copyState ? <span role="status">{copyState}</span> : null}
      </div>
    </details> : null}
    {error ? <p role="alert">{error}</p> : null}
  </figure>;
}
