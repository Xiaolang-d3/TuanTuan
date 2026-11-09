import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function PreviewDialog({ title, children, onClose, wide = false, footer }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = root.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const background = document.getElementById("root");
    const previousInert = background?.inert ?? false;
    if (background && !background.contains(dialog)) background.inert = true;
    document.body.style.overflow = "hidden";
    const keepFocus = () => {
      if (dialog.isConnected && !dialog.contains(document.activeElement)) dialog.focus();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close.current(); return;
      }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], iframe, summary, [tabindex="0"]')].filter((item) => {
        const collapsedDetails = item.closest("details:not([open])");
        return !item.hidden && getComputedStyle(item).display !== "none" && (!collapsedDetails || item.tagName === "SUMMARY");
      });
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      const outside = document.activeElement === dialog || !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus(); }
    };
    // Step changes can remove the active button without firing a focus event.
    const observer = new MutationObserver(keepFocus);
    observer.observe(dialog, { childList: true, subtree: true });
    document.addEventListener("focusin", keepFocus);
    // Capture also covers portal events whose React ancestors stop propagation.
    document.addEventListener("keydown", handleKey, true);
    dialog.focus();
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", handleKey, true);
      if (background) background.inert = previousInert;
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="extension-overlay" onClick={(event) => { if (event.target === event.currentTarget) close.current(); }}>
    <div className={`extension-dialog${wide ? " extension-dialog-wide" : ""}${footer ? " extension-dialog-with-footer" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={root}>
      <header className="extension-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="extension-icon-button" aria-label="关闭窗口" onClick={onClose}><X size={19} /></button></header>
      {footer ? <><div className="extension-dialog-body">{children}</div><footer className="extension-dialog-footer">{footer}</footer></> : children}
    </div>
  </div>, document.body);
}
