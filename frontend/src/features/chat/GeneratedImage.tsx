import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Download, FolderPlus, Images, LoaderCircle, Save } from "lucide-react";
import { HistoryAttachment } from "./HistoryAttachment";
import { AttachmentPreviewContext } from "./AttachmentPreviewDialog";
import { ResultActionsContext } from "./result-types";
import { downloadBlob } from "./result-files";
import type { ChatAttachment, ChatWorkspaceProps } from "./types";

export const LatestGeneratedImageContext = createContext<string | undefined>(undefined);

export const AssetOriginalContext = createContext<ChatWorkspaceProps["onLoadAttachment"]>(undefined);

export function GeneratedImage({ asset, prompt }: { asset: ChatAttachment; prompt?: string | null }) {
  const latestImageId = useContext(LatestGeneratedImageContext);
  const preview = useContext(AttachmentPreviewContext);
  const [copyState, setCopyState] = useState("");
  const imageWidth = asset.width && asset.height && asset.width > 0 && asset.height > 0
    ? Math.min(400, 320 * asset.width / asset.height) : undefined;
  async function copyPrompt() {
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); setCopyState("已复制提示词"); }
    catch { setCopyState("复制失败，请选择提示词后手动复制"); }
  }
  return <figure className="chat-generated-image" data-actions={latestImageId === undefined || latestImageId === asset.id ? "always" : "hover"} aria-label="模型生成图片" style={imageWidth ? { maxWidth: imageWidth } : undefined}>
    <HistoryAttachment variant="generated" attachment={asset} onPreview={() => preview?.(asset)} />
    {prompt?.trim() ? <details className="generated-image-prompt" onToggle={() => setCopyState("")}>
      <summary><ChevronRight size={13} aria-hidden="true" />生成提示词</summary>
      <div className="generated-image-prompt-body">
        <p>{prompt}</p>
        <button type="button" onClick={() => void copyPrompt()}><Copy size={13} aria-hidden="true" />复制提示词</button>
        {copyState ? <span role="status">{copyState}</span> : null}
      </div>
    </details> : null}
  </figure>;
}

export function GeneratedImageActions({ assets, messageId }: { assets: ChatAttachment[]; messageId: number }) {
  const openResult = useContext(ResultActionsContext);
  const load = useContext(AssetOriginalContext);
  const save = messageId > 0 ? openResult : null;
  if (!assets.length || (!save && !load)) return null;
  const multiple = assets.length > 1;
  const actions = (asset: ChatAttachment) => <ImageActionButtons key={asset.id} asset={asset} load={load} multiple={multiple}
    onSave={save ? () => save(messageId, `asset:${asset.id}`, true) : undefined} />;
  if (!multiple) return actions(assets[0]);

  return <details className="generated-image-actions-menu" onKeyDown={event => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary className="message-icon-action generated-image-message-action" aria-label="图片操作" title="图片操作"><Images size={14} aria-hidden="true" /></summary>
    <ul className="generated-image-action-list">
      {assets.map(asset => <li key={asset.id}>
        <span title={asset.original_filename}>{asset.original_filename}</span>
        {actions(asset)}
      </li>)}
    </ul>
  </details>;
}

function ImageActionButtons({ asset, load, onSave, multiple }: {
  asset: ChatAttachment; load: ChatWorkspaceProps["onLoadAttachment"]; onSave?: () => void; multiple: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");
  const controller = useRef<AbortController | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  async function copyImage() {
    if (!load || copyState === "正在复制图片") return;
    setCopyState("正在复制图片");
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("unsupported");
      // Start the clipboard write during the click; loading and conversion can finish afterwards.
      const png = load(asset).then(async ({ file }) => {
        if (file.type === "image/png") return file;
        const bitmap = await createImageBitmap(file);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("canvas unavailable");
          context.drawImage(bitmap, 0, 0);
          return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("conversion failed")), "image/png"));
        } finally { bitmap.close(); }
      });
      // A permission rejection may settle before the image finishes loading.
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setCopyState("已复制图片");
    } catch {
      setCopyState("复制图片失败，请检查浏览器权限或下载原图");
    }
  }

  async function download() {
    if (!load || (controller.current && !controller.current.signal.aborted)) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      const { file } = await load(asset, abort.signal);
      if (!abort.signal.aborted) downloadBlob(file, asset.original_filename);
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "图片下载失败");
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        controller.current = null;
      }
    }
  }

  const DownloadIcon = busy ? LoaderCircle : Download;
  const downloadLabel = busy ? "正在下载…" : "下载原图";
  const saveChoices = <>
    {onSave ? <button type="button" className="generated-image-save-choice" aria-label={multiple ? `保存 ${asset.original_filename} 到文件库` : "保存到文件库"} onClick={() => { if (menu.current) menu.current.open = false; onSave(); }}><FolderPlus size={14} aria-hidden="true" />保存到文件库</button> : null}
    {load ? <button type="button" className="generated-image-save-choice" aria-label={multiple ? `${downloadLabel} ${asset.original_filename}` : downloadLabel} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void download()}><DownloadIcon size={14} aria-hidden="true" className={busy ? "spinning" : undefined} />{downloadLabel}</button> : null}
  </>;
  return <>
    {load ? <button type="button" className="message-icon-action generated-image-message-action" title="复制图片" aria-label={multiple ? `复制图片 ${asset.original_filename}` : "复制图片"} aria-disabled={copyState === "正在复制图片" || undefined} onClick={() => void copyImage()}><Copy size={14} aria-hidden="true" /></button> : null}
    {multiple ? saveChoices : <details ref={menu} className="generated-image-save-menu" onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary className="message-icon-action generated-image-message-action" aria-label="保存图片" title="保存图片"><Save size={14} aria-hidden="true" /></summary>
      <div className="generated-image-save-choices">{saveChoices}</div>
    </details>}
    {error ? <span className="generated-image-action-error" role="alert">{error}</span> : null}
    {copyState ? <span className="generated-image-action-error" role="status">{copyState}</span> : null}
  </>;
}
