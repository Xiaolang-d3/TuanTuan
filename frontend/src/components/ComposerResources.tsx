import { useEffect, useId, useState } from "react";
import { ArrowUpRight, ChevronDown, FolderOpen, LoaderCircle, Paperclip, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent } from "./ui/DropdownMenu";

export function ComposerResources({ busy, documentsOnly, onUpload, onOpenLibrary, creation }: {
  busy: boolean;
  documentsOnly: boolean;
  onUpload: () => void;
  onOpenLibrary?: () => void;
  creation?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  return (
    <div className="composer-resources">
      <DropdownMenu.Root modal={false} open={open && !busy} onOpenChange={setOpen}>
        <DropdownMenu.Trigger
          className={creation ? "creation-file-button" : "composer-tool composer-attachment-tool"}
          aria-label={busy ? "附件处理中" : "添加资料"}
          disabled={busy}
        >
          {busy ? <LoaderCircle className="spinning" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
          <span className="composer-tool-label">添加资料</span>
          {!creation && <ChevronDown className="composer-resources-chevron" size={12} aria-hidden="true" />}
        </DropdownMenu.Trigger>
        <DropdownMenuContent className="composer-resources-panel" aria-label="资料选项" side="top" sideOffset={8}>
          <DropdownMenu.Item className="composer-resource-option" aria-labelledby={`${panelId}-upload`} aria-describedby={`${panelId}-upload-hint`} onClick={onUpload}>
            <span className="composer-resource-icon" aria-hidden="true"><Paperclip size={17} /></span>
            <span className="composer-resource-copy"><strong id={`${panelId}-upload`}>上传文件</strong><small id={`${panelId}-upload-hint`}>{documentsOnly ? "Word、文字版 PDF 或文本" : "从设备选择图片或文档"}</small></span>
          </DropdownMenu.Item>
          {onOpenLibrary ? (
            <DropdownMenu.Item className="composer-resource-option" aria-labelledby={`${panelId}-library`} aria-describedby={`${panelId}-library-hint`} onClick={onOpenLibrary}>
              <span className="composer-resource-icon" aria-hidden="true"><FolderOpen size={17} /></span>
              <span className="composer-resource-copy"><strong id={`${panelId}-library`}>打开文件库</strong><small id={`${panelId}-library-hint`}>浏览已保存的资料</small></span>
              <ArrowUpRight className="composer-resource-trailing" size={14} aria-hidden="true" />
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu.Root>
    </div>
  );
}
