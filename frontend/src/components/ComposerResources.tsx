import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, FolderOpen, LoaderCircle, Paperclip, Plus } from "lucide-react";

export function ComposerResources({ busy, documentsOnly, onUpload, onOpenLibrary }: {
  busy: boolean;
  documentsOnly: boolean;
  onUpload: () => void;
  onOpenLibrary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const upload = useRef<HTMLButtonElement>(null);
  const library = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (busy) setOpen(false);
    else if (open) upload.current?.focus({ preventScroll: true });
  }, [busy, open]);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  function closeAndRestoreFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      ref={root}
      className="composer-resources"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeAndRestoreFocus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const moveToLibrary = event.target === upload.current || (event.target === trigger.current && event.key === "ArrowUp");
          (moveToLibrary ? library.current ?? upload.current : upload.current)?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className={`composer-tool composer-attachment-tool${open ? " is-open" : ""}`}
        type="button"
        aria-label={busy ? "附件处理中" : "添加资料"}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={busy}
        onClick={() => setOpen(value => !value)}
      >
        {busy ? <LoaderCircle className="spinning" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
        <span>添加资料</span>
        <ChevronDown className="composer-resources-chevron" size={12} aria-hidden="true" />
      </button>
      <div id={panelId} className="composer-resources-panel" role="group" aria-label="资料选项" hidden={!open}>
        <button ref={upload} className="composer-resource-option" type="button" aria-labelledby={`${panelId}-upload`} aria-describedby={`${panelId}-upload-hint`} disabled={busy} onClick={() => { closeAndRestoreFocus(); onUpload(); }}>
          <span className="composer-resource-icon" aria-hidden="true"><Paperclip size={17} /></span>
          <span className="composer-resource-copy"><strong id={`${panelId}-upload`}>上传文件</strong><small id={`${panelId}-upload-hint`}>{documentsOnly ? "Word、文字版 PDF 或文本" : "从设备选择图片或文档"}</small></span>
        </button>
        {onOpenLibrary ? (
          <button ref={library} className="composer-resource-option" type="button" aria-labelledby={`${panelId}-library`} aria-describedby={`${panelId}-library-hint`} onClick={() => { closeAndRestoreFocus(); onOpenLibrary(); }}>
            <span className="composer-resource-icon" aria-hidden="true"><FolderOpen size={17} /></span>
            <span className="composer-resource-copy"><strong id={`${panelId}-library`}>打开文件库</strong><small id={`${panelId}-library-hint`}>浏览已保存的资料</small></span>
            <ArrowUpRight className="composer-resource-trailing" size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
