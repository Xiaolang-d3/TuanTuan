import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySourceDetail } from "../../types";
import { MarkdownContent } from "../chat/ChatMarkdown";
import { isLocalEvidence } from "../chat/local-evidence";

const PdfReader = lazy(() => import("./PdfReader"));

export function FilePreview({
  source,
  mode,
  loadOriginal,
  loadAsset
}: {
  source: LibrarySourceDetail;
  mode: "original" | "text";
  loadOriginal?: (source: LibrarySourceDetail, signal?: AbortSignal) => Promise<Blob>;
  loadAsset?: (sourceId: number, assetId: string, signal?: AbortSignal) => Promise<Blob>;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [originalText, setOriginalText] = useState<string | null>(null),
    [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const loader = useRef(loadOriginal);
  loader.current = loadOriginal;
  const canRender = source.mime_type === "application/pdf" || source.mime_type.startsWith("image/");
  const isPdf = source.mime_type === "application/pdf";
  const isText = source.mime_type.startsWith("text/");
  const isMarkdown = source.mime_type === "text/markdown" || /\.md$/i.test(source.original_filename);
  const archivedSources = (source.metadata?.chat_archive as { sources?: unknown[] } | undefined)?.sources;
  const localEvidence = Array.isArray(archivedSources) ? archivedSources.filter(isLocalEvidence) : [];
  const imageLoader = useCallback(async (src: string, signal: AbortSignal) => {
    const id = src.match(/^assets\/([a-f0-9]{32})\.(png|jpg|webp)$/)?.[1];
    if (!id || !loadAsset) throw new Error("图片读取暂不可用");
    return loadAsset(source.id, id, signal);
  }, [source.id, loadAsset]);
  useEffect(() => {
    setUrl("");
    setError("");
    setOriginalText(null);
    setPdfBytes(null);
    if (mode !== "original" || !source.file_available || (!canRender && !isText) || !loader.current) return;
    const controller = new AbortController();
    let objectUrl = "";
    void loader
      .current(source, controller.signal)
      .then(async (blob) => {
        if (isText) {
          const text = await blob.text();
          if (!controller.signal.aborted) setOriginalText(text);
          return;
        }
        if (isPdf) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!controller.signal.aborted) setPdfBytes(bytes);
          return;
        }
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "原文件读取失败");
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source.id, source.file_available, canRender, isText, isPdf, mode]);
  if (mode === "text")
    return (
      <article className="fl-text-page">
        <small>{source.privacy_mode === "original" ? "模型可读取原文" : "模型读取脱敏文本"}</small>
        <pre>
          {(source.privacy_mode === "original" ? source.content : source.redacted_content) ||
            (source.mime_type.startsWith("image/") || source.mime_type.startsWith("video/") ? "暂无可读取文字，可添加文字说明。" : "暂无可读取文字，可编辑正文补充。")}
        </pre>
      </article>
    );
  if ((canRender || isText) && source.file_available) {
    if (error)
      return (
        <p role="alert" className="fl-empty">
          {error}
        </p>
      );
    if (isText && originalText !== null)
      return (
        <article className="fl-text-page">
          {isMarkdown ? <MarkdownContent localEvidence={localEvidence} imageLoader={imageLoader}>{originalText || "原文件没有文字。"}</MarkdownContent> : <pre>{originalText || "原文件没有文字。"}</pre>}
        </article>
      );
    if (isPdf ? !pdfBytes : !url)
      return (
        <p role="status" className="fl-empty">
          正在加载原文件…
        </p>
      );
    return isPdf ? (
      <Suspense
        fallback={
          <p role="status" className="fl-empty">
            正在加载 PDF 阅读器…
          </p>
        }
      >
        <PdfReader bytes={pdfBytes!} title={source.title} />
      </Suspense>
    ) : (
      <img className="fl-image" src={url} alt={source.title} />
    );
  }
  if (source.mime_type.includes("wordprocessingml"))
    return (
      <div className="fl-empty">
        <h3>下载原文件查看 Word 排版</h3>
        <p>可切换到“AI 读取内容”查看提取文字。</p>
      </div>
    );
  if (source.file_available)
    return (
      <div className="fl-empty">
        <h3>下载原文件查看</h3>
        <p>可切换到“AI 读取内容”查看提取文字。</p>
      </div>
    );
  return (
    <article className="fl-text-page">
      <pre>{source.content || "暂无提取文字，原文件仍可下载。"}</pre>
    </article>
  );
}
