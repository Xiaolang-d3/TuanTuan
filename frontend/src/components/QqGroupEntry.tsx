import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Users, X } from "lucide-react";
import qqGroupQr from "./qq-group-qr.png";
import "./qq-group-entry.css";

export const qqGroupNumber = "1129343230";
export const qqGroupLink = "https://qm.qq.com/q/s8FpW2CnHa";

export function QqGroupEntry() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(qqGroupNumber);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="qq-group-entry" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="qq-group-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={16} aria-hidden="true" />
        交流群
      </button>
      {open && (
        <section className="qq-group-panel" id={panelId} role="dialog" aria-label="团团交流群">
          <header className="qq-group-panel-header">
            <img src="/tuantuan-logo.png" alt="" />
            <div>
              <h2>
                <a className="qq-group-join" href={qqGroupLink} target="_blank" rel="noopener noreferrer"
                  title="点击加入群聊">团团交流群</a>
              </h2>
              <p className="qq-group-number">
                QQ 群号：{qqGroupNumber}
                <button type="button" className="qq-group-copy" onClick={copyNumber}
                  aria-label={copied ? "已复制群号" : "复制群号"} title={copied ? "已复制" : "复制群号"}>
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                </button>
              </p>
            </div>
            <button type="button" className="qq-group-close" aria-label="关闭" onClick={() => setOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <img className="qq-group-qr" src={qqGroupQr} alt="团团交流群 QQ 二维码" width={200} height={200} />
          <p className="qq-group-hint">用 QQ 扫一扫二维码，加入群聊</p>
        </section>
      )}
    </div>
  );
}
