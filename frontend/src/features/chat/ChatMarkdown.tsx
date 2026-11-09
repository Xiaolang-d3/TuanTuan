import { Children, createContext, isValidElement, useContext, useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkLocalCitations } from "./remark-local-citations";
import { LocalCitation, LocalCitationActionsContext } from "./LocalCitation";
import type { LocalEvidence } from "./local-evidence";
import { ChatWorkspaceMermaid } from "../../components/ChatWorkspaceMermaid";
import { ChatWorkspaceMindmap } from "../../components/ChatWorkspaceMindmap";
import { isMermaidMindmap } from "../../components/mindmap-source";
import { downloadText, codeFilename } from "./result-files";
import "./markdown-reader.css";
import "./chat-tables.css";

export type WebSource = {
  title: string;
  url: string;
  domain?: string;
  snippet?: string;
  content?: string;
  published_at?: string;
};

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) return childrenToText(children.props.children);
  return "";
}

export function sourceDomain(source: Pick<WebSource, "url" | "domain" | "title">): string {
  return source.domain || source.url.replace(/^https?:\/\//, "").split("/")[0] || source.title;
}

function faviconHost(domain: string): string | null {
  try {
    const host = domain.includes("://") ? new URL(domain).hostname : domain.split("/")[0];
    const normalized = host.replace(/^www\./i, "").toLowerCase();
    return normalized.includes(".") ? normalized : null;
  } catch {
    return null;
  }
}

export function SourceFavicon({ domain, title }: { domain: string; title: string }) {
  const host = faviconHost(domain);
  const letter = (domain || title).slice(0, 1).toUpperCase();
  const [failed, setFailed] = useState(false);
  if (host && !failed) {
    return (
      <span className="web-source-icon" aria-hidden="true">
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          width={16}
          height={16}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return <span className="web-source-icon" aria-hidden="true">{letter}</span>;
}

function canonicalCitationUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function CitationLink({
  href,
  sources,
  children,
  onOpenSource
}: {
  href?: string;
  sources: WebSource[];
  children?: ReactNode;
  onOpenSource?: (index: number) => void;
}) {
  const label = childrenToText(children);
  if (!href || !/^https?:\/\//i.test(href)) {
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  }
  const index = sources.findIndex((source) => canonicalCitationUrl(source.url) === canonicalCitationUrl(href));
  const source = index >= 0 ? sources[index] : undefined;
  const title = source?.title || label || href;
  const domain = sourceDomain(source ?? { title, url: href });
  const letter = (domain || title).slice(0, 1).toUpperCase();
  const citationNo = index >= 0 ? index + 1 : null;
  return (
    <a
      className="md-citation"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={citationNo ? `来源 ${citationNo}：${title}` : `来源：${title}`}
      onClick={citationNo && onOpenSource ? (event) => {
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        onOpenSource(index);
      } : undefined}
    >
      <span className="md-citation-badge">{citationNo ?? letter}</span>
      <span className="md-citation-card" aria-hidden="true">
        <SourceFavicon domain={domain} title={title} />
        <span className="md-citation-card-copy">
          <strong>{title}</strong>
          <small>{domain}</small>
        </span>
      </span>
    </a>
  );
}

export type MarkdownImageLoader = (src: string, signal: AbortSignal) => Promise<Blob>;
const MarkdownRenderContext = createContext<{ sources: WebSource[]; localEvidence: LocalEvidence[]; streaming: boolean; onOpenSource?: (index: number) => void; imageLoader?: MarkdownImageLoader; allowRemoteImages?: boolean }>({
  sources: [],
  localEvidence: [],
  streaming: false
});

function MarkdownLinkRenderer({ children, href }: { children?: ReactNode; href?: string }) {
  const { sources, onOpenSource } = useContext(MarkdownRenderContext);
  return <CitationLink href={href} sources={sources} onOpenSource={onOpenSource}>{children}</CitationLink>;
}

function MarkdownSpanRenderer({ node, children, ...props }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
  const { localEvidence, streaming } = useContext(MarkdownRenderContext);
  const open = useContext(LocalCitationActionsContext);
  const citationId = node?.properties?.["data-local-citation"];
  if (typeof citationId !== "string") return <span {...props}>{children}</span>;
  const evidence = localEvidence.find(item => item.citation_id === citationId);
  if (evidence && open) return <LocalCitation evidence={evidence} onOpen={open} />;
  return <span className="md-local-citation-unverified" title={evidence ? "当前页面暂不支持原文预览" : "没有与此标记对应的已核验证据"}>{evidence ? "本地来源" : streaming ? "核对来源中…" : "引用未核对"}</span>;
}

function MarkdownCodeRenderer({
  children,
  className,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  const { streaming } = useContext(MarkdownRenderContext);
  if (className?.split(/\s+/).includes("language-mermaid")) {
    const source = childrenToText(children);
    return isMermaidMindmap(source)
      ? <ChatWorkspaceMindmap source={source} streaming={streaming} />
      : <ChatWorkspaceMermaid source={source} streaming={streaming} />;
  }
  return <code className={className} {...props}>{children}</code>;
}

function MarkdownPreRenderer({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const renderedChildren = Children.toArray(children);
  const child = renderedChildren.length === 1 && isValidElement<{ className?: string; children?: ReactNode }>(renderedChildren[0])
    ? renderedChildren[0]
    : null;
  const containsMermaid = child?.props.className?.split(/\s+/).includes("language-mermaid");
  const source = childrenToText(child?.props.children ?? children);
  const language = child?.props.className?.match(/language-([\w+-]+)/)?.[1] ?? "代码";
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState("复制");
  useEffect(() => { setCopyState("复制"); }, [source]);
  const { streaming } = useContext(MarkdownRenderContext);
  const long = source.trimEnd().split("\n").length > 24;
  async function copyCode() {
    try { await navigator.clipboard.writeText(source); setCopyState("已复制"); }
    catch { setCopyState("复制失败，请重试"); }
  }
  return containsMermaid ? children : <div className="chat-code-block">
    <div className="chat-code-toolbar"><span>{language}</span><div><button type="button" disabled={streaming} onClick={() => downloadText(source, codeFilename(language), "text/plain")}>下载代码</button><button type="button" onClick={() => void copyCode()}>{copyState}</button></div></div>
    <pre {...props} className={long && !expanded && !streaming ? "is-collapsed" : undefined}>{children}</pre>
    {long && !streaming ? <button className="chat-code-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起代码" : `展开完整代码（${source.trimEnd().split("\n").length} 行）`}</button> : null}
    <span className="sr-only" role="status">{copyState === "复制" ? "" : copyState}</span>
  </div>;
}

const MARKDOWN_COMPONENTS: Components = {
  span: MarkdownSpanRenderer,
  a: MarkdownLinkRenderer,
  code: MarkdownCodeRenderer,
  pre: MarkdownPreRenderer,
  img: MarkdownImage,
  table: ({ node: _node, ...props }) => <div className="chat-table-scroll" role="region" aria-label="表格，支持横向滚动" tabIndex={0}><table {...props} /></div>,
};

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [localUrl, setLocalUrl] = useState("");
  const { imageLoader, allowRemoteImages = true } = useContext(MarkdownRenderContext);
  const local = Boolean(src && /^(?:assets|resources)\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(src));
  useEffect(() => setFailed(false), [src]);
  useEffect(() => {
    setLocalUrl("");
    if (!local || !src || !imageLoader) return;
    const abort = new AbortController();
    let url = "";
    void imageLoader(src, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob); setLocalUrl(url);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [src, local, imageLoader]);
  if (local) return failed ? <span role="alert">图片读取失败</span> : localUrl ? <a className="chat-markdown-image" href={localUrl} target="_blank" rel="noopener noreferrer" title="查看原图"><img src={localUrl} alt={alt || "生成图片"} /></a> : <span role="status">正在读取图片…</span>;
  if (!allowRemoteImages) return <span role="alert">图片不属于文档资源清单</span>;
  if (!src || !/^https?:\/\//i.test(src)) return <span>{alt || "图片地址不可用"}</span>;
  return <a className="chat-markdown-image" href={src} target="_blank" rel="noopener noreferrer" title="打开原图">
    {failed ? <span>图片加载失败，打开原图{alt ? `：${alt}` : ""}</span> : <img src={src} alt={alt || "图片"} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
  </a>;
}

export function MarkdownContent({
  children,
  sources = [],
  localEvidence = [],
  streaming = false,
  onOpenSource,
  imageLoader,
  allowRemoteImages = true
}: {
  children: string;
  sources?: WebSource[];
  localEvidence?: LocalEvidence[];
  streaming?: boolean;
  onOpenSource?: (index: number) => void;
  imageLoader?: MarkdownImageLoader;
  allowRemoteImages?: boolean;
}) {
  return (
    <div className="message-markdown">
      <MarkdownRenderContext.Provider value={{ sources, localEvidence, streaming, onOpenSource, imageLoader, allowRemoteImages }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkLocalCitations]}
          skipHtml
          components={MARKDOWN_COMPONENTS}
        >
          {children}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
    </div>
  );
}
