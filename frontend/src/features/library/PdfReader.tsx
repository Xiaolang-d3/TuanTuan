import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import "./pdf-reader.css";

GlobalWorkerOptions.workerSrc = workerUrl;
// Vite emits these files locally with hashed URLs. Documents and supporting
// fonts/CMaps never leave the application's origin for a public PDF CDN.
const assets = {
  ...import.meta.glob<string>("/node_modules/pdfjs-dist/cmaps/*.bcmap", {
    eager: true,
    query: "?url",
    import: "default"
  }),
  ...import.meta.glob<string>("/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", {
    eager: true,
    query: "?url",
    import: "default"
  }),
  ...import.meta.glob<string>("/node_modules/pdfjs-dist/wasm/*.wasm", { eager: true, query: "?url", import: "default" })
};
class LocalBinaryDataFactory {
  async fetch({ filename }: { kind: string; filename: string }) {
    const url = Object.entries(assets).find(([path]) => path.endsWith(`/${filename}`))?.[1];
    if (!url) throw new Error("PDF supporting asset unavailable");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF supporting asset unavailable");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export default function PdfReader({ bytes, title, initialPage = 1 }: { bytes: Uint8Array; title: string; initialPage?: number }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(0);
  const [error, setError] = useState(""),
    [rendering, setRendering] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null),
    frame = useRef<HTMLDivElement>(null);
  const targetPage = useRef(initialPage);
  targetPage.current = initialPage;
  useEffect(() => {
    let active = true;
    setDocument(null);
    setError("");
    setPage(1);
    setZoom(1);
    const task = getDocument({ data: bytes.slice(), useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory });
    void task.promise
      .then((pdf) => {
        if (active) { setDocument(pdf); setPage(Math.max(1, Math.min(pdf.numPages, Math.trunc(targetPage.current) || 1))); }
      })
      .catch(() => {
        if (active) setError("PDF 无法显示，请下载原文件检查，或查看 AI 读取内容。");
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [bytes]);
  useEffect(() => {
    if (document) setPage(Math.max(1, Math.min(document.numPages, Math.trunc(initialPage) || 1)));
  }, [document, initialPage]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setWidth(Math.min(820, Math.max(100, element.clientWidth - 32)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !width || !canvas.current) return;
    let active = true,
      task: RenderTask | undefined;
    setRendering(true);
    setError("");
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (!active || !canvas.current) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: (width / natural.width) * zoom });
        const element = canvas.current,
          density = Math.min(window.devicePixelRatio || 1, 2);
        element.width = Math.floor(viewport.width * density);
        element.height = Math.floor(viewport.height * density);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        task = pdfPage.render({
          canvas: element,
          viewport,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0]
        });
        return task.promise;
      })
      .catch((reason) => {
        if (active && reason?.name !== "RenderingCancelledException") setError("这一页无法显示，可下载原文件查看。");
      })
      .finally(() => {
        if (active) setRendering(false);
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, page, width, zoom]);
  return (
    <div className="fl-pdf-reader">
      <nav className="fl-pdf-controls" aria-label="PDF 阅读控制">
        <button
          type="button"
          aria-label="上一页"
          disabled={!document || page <= 1}
          onClick={() => setPage((current) => current - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span aria-live="polite">
          {page} / {document?.numPages || "—"}
        </span>
        <button
          type="button"
          aria-label="下一页"
          disabled={!document || page >= document.numPages}
          onClick={() => setPage((current) => current + 1)}
        >
          <ChevronRight size={17} />
        </button>
        <button
          type="button"
          aria-label="缩小 PDF"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}
        >
          <Minus size={16} />
        </button>
        <button type="button" aria-label="适应宽度" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大 PDF"
          disabled={zoom >= 3}
          onClick={() => setZoom((current) => Math.min(3, current + 0.25))}
        >
          <Plus size={16} />
        </button>
      </nav>
      <div ref={frame} className="fl-pdf-pages">
        {error && (
          <p role="alert" className="fl-empty">
            {error}
          </p>
        )}
        {!error && (!document || rendering) && (
          <p className="fl-pdf-status" role="status">
            正在显示 PDF…
          </p>
        )}
        <canvas hidden={Boolean(error)} ref={canvas} role="img" aria-label={`${title}，第 ${page} 页`} />
      </div>
    </div>
  );
}
