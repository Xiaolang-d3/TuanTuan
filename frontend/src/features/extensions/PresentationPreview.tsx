import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import type { FileArtifact } from "./activity-service";
import type { PresentationService } from "./presentation-service";
import { PresentationPageImage } from "./PresentationPageImage";
import { PreviewDialog } from "./PreviewDialog";

export function PresentationPreview({ service, previews, busy, error, onDownload, onClose, initialPage, onSelectPage }: {
  service: PresentationService; previews: FileArtifact[]; busy: boolean; error: string;
  onDownload?: () => void; onClose: () => void;
  initialPage?: string; onSelectPage?: (page: string) => void;
}) {
  const [selected, setSelected] = useState(initialPage ?? "");
  const navigation = useRef<HTMLElement>(null);
  const index = Math.max(0, previews.findIndex(page => `${page.id}:${page.version}` === selected));
  const choose = useCallback((position: number) => {
    const page = previews[Math.max(0, Math.min(previews.length - 1, position))];
    if (!page) return;
    const key = `${page.id}:${page.version}`;
    setSelected(key); onSelectPage?.(key);
  }, [previews, onSelectPage]);
  useEffect(() => {
    const reveal = () => navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [index]);
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && previews.length) {
        event.preventDefault();
        choose(event.key === "Home" ? 0 : event.key === "End" ? previews.length - 1 : index + (event.key === "ArrowLeft" ? -1 : 1));
      }
    }
    document.addEventListener("keydown", navigate);
    return () => document.removeEventListener("keydown", navigate);
  }, [previews.length, index, choose]);
  if (!previews[index]) return null;
  return <PreviewDialog title="PPT 逐页预览" wide onClose={onClose} footer={<div className="ppt-preview-tools">
    {error ? <p className="ppt-card-error" role="alert">{error}</p> : null}
    <div className="ppt-preview-controls"><nav aria-label="切换幻灯片">
      <button type="button" className="extension-button" aria-label="上一页" disabled={index <= 0} onClick={() => choose(index - 1)}><ChevronLeft size={16} /></button>
      <select aria-label="选择幻灯片" value={index} onChange={event => choose(Number(event.target.value))}>{previews.map((page, pageIndex) => <option key={`${page.id}:${page.version}`} value={pageIndex}>{pageIndex + 1} / {previews.length}</option>)}</select>
      <button type="button" className="extension-button" aria-label="下一页" disabled={index >= previews.length - 1} onClick={() => choose(index + 1)}><ChevronRight size={16} /></button>
    </nav>{onDownload ? <button type="button" className="extension-button primary" disabled={busy} onClick={onDownload}><Download size={15} />下载 PPTX</button> : null}</div>
    <p className="ppt-preview-hint">可选择页码或用方向键翻页。下载后可在 PowerPoint 或 WPS 中编辑。</p>
  </div>}><div className="ppt-preview-layout"><nav ref={navigation} className="ppt-preview-pages" aria-label="幻灯片缩略图">{previews.map((page, position) => <button key={`${page.id}:${page.version}`} className="ppt-thumbnail" type="button" aria-label={`预览第 ${position + 1} 页`} aria-current={position === index ? "page" : undefined} onClick={() => choose(position)}>
    <PresentationPageImage service={service} artifact={page} page={position + 1} thumbnail /><span>第 {position + 1} 页</span>
  </button>)}</nav><div className="ppt-expanded-preview"><PresentationPageImage key={`${previews[index].id}:${previews[index].version}`} service={service} artifact={previews[index]} page={index + 1} /></div></div></PreviewDialog>;
}
