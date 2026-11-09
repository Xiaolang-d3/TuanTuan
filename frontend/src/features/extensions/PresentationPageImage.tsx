import { useEffect, useRef, useState } from "react";
import type { FileArtifact } from "./activity-service";
import type { PresentationService } from "./presentation-service";

export function PresentationPageImage({ service, artifact, page, thumbnail = false, onOpen }: { service: PresentationService; artifact: FileArtifact; page: number; thumbnail?: boolean; onOpen?: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => !thumbnail || typeof IntersectionObserver === "undefined");
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (visible || !frame.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let current = "";
    setUrl(""); setFailed(false);
    void service.preview(artifact, controller.signal).then(value => {
      if (controller.signal.aborted) { URL.revokeObjectURL(value); return; }
      current = value; setUrl(value);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (current) URL.revokeObjectURL(current); };
  }, [service, artifact.id, artifact.version, attempt, visible]);
  const image = url ? <img className="ppt-page-image" src={url} alt={thumbnail ? "" : `第 ${page} 页预览`} onError={() => setFailed(true)} /> : null;
  return <div ref={frame} className="ppt-page-frame" aria-hidden={thumbnail || undefined}>{failed ? <div className="ppt-preview-placeholder"><p>{thumbnail ? "预览未载入" : "页面预览暂时无法读取"}</p>{!thumbnail ? <button type="button" className="extension-button" onClick={() => setAttempt(value => value + 1)}>重新读取预览</button> : null}</div>
    : image ? onOpen && !thumbnail ? <button type="button" className="ppt-cover-open" aria-label={`打开第 ${page} 页预览`} onClick={onOpen}>{image}<span className="ppt-cover-caption">打开预览</span></button> : image : <div className="ppt-preview-placeholder" role={thumbnail ? undefined : "status"}>{thumbnail ? "" : "正在读取页面预览…"}</div>}</div>;
}
