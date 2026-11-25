import { useState, type MouseEventHandler } from "react";
import { ChevronDown, ChevronUp, Newspaper, RefreshCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { formatPublished } from "./HomeFeedCards";
import type { HomeDigest } from "./types";

type HomeDigestCardProps = {
  digest?: HomeDigest;
  loading: boolean;
  now: Date;
  onRegenerate: () => void;
  onOpenInterest: MouseEventHandler<HTMLButtonElement>;
};

function DigestSkeleton({ lines = 3 }: { lines?: number }) {
  return <div className="home-skeleton-list" role="status" aria-label="日报生成中">{Array.from({ length: lines }, (_, index) => <div className="home-skeleton-card" key={index}><div className="home-skeleton home-skeleton-line" /><div className="home-skeleton home-skeleton-line short" /></div>)}</div>;
}

export function HomeDigestCard({ digest, loading, now, onRegenerate, onOpenInterest }: HomeDigestCardProps) {
  const [open, setOpen] = useState(true);
  if (loading && !digest) return <section className="home-module home-digest" aria-label="今日 AI 日报"><DigestSkeleton /></section>;
  if (!digest) return null;
  const value = digest;
  const generating = value.status === "generating";
  const hasContent = Boolean(value.overview);
  const statusOnly = !hasContent;

  function body() {
    if (generating) return <><DigestSkeleton lines={2} /><p className="home-digest-status" role="status">{hasContent ? "内容有更新，正在重新生成今日日报…" : "正在生成今日日报，已有内容可继续阅读。"}</p></>;
    if (statusOnly && value.status === "unconfigured") return <div className="home-empty"><span className="home-empty-icon"><SlidersHorizontal size={24} /></span><h3>还没有启用 AI 日报</h3><p>在兴趣设置中选择一个文本模型档案，每天首次打开首页时会用公开资讯生成一份中文日报。</p><div className="home-empty-actions"><button className="home-btn home-btn-primary" type="button" onClick={onOpenInterest}>兴趣设置</button></div></div>;
    if (statusOnly && value.status === "empty") return <div className="home-empty"><span className="home-empty-icon"><Newspaper size={24} /></span><h3>暂无可总结的内容</h3><p>资讯同步成功后会生成今日日报。</p></div>;
    if (statusOnly && value.status === "error") return <div className="home-digest-error" role="alert"><TriangleAlert size={16} /><span>{value.error || "日报生成失败，请重试"}</span><button className="home-btn" type="button" onClick={onRegenerate}>重新生成</button></div>;
    if (statusOnly) return <p className="home-digest-status" role="status">正在生成今日日报…</p>;
    return <>
      <p className="home-digest-overview">{value.overview}</p>
      {open && <div className="home-digest-sections">{value.sections.map((section) => <section className="home-digest-section" key={section.key} aria-label={section.label}><h3>{section.label}</h3><ul>{section.points.map((point, index) => <li key={`${section.key}:${index}`}>{point.url ? <a href={point.url} target="_blank" rel="noreferrer">{point.text}</a> : <span>{point.text}</span>}</li>)}</ul></section>)}</div>}
      {value.status === "error" && <p className="home-digest-warning" role="alert"><TriangleAlert size={14} />{value.error}</p>}
      {value.status === "stale" && <p className="home-digest-warning">公开来源有更新，可重新生成日报。</p>}
    </>;
  }

  return <section className="home-module home-digest" aria-labelledby="home-digest-title" data-status={value.status}>
    <div className="home-module-head">
      <h2 className="home-module-title" id="home-digest-title"><span className="home-module-icon"><Newspaper size={15} /></span>今日 AI 日报{value.date && <span className="home-count">{value.date}</span>}</h2>
      <div className="home-digest-tools">
        {hasContent && <button className="home-more-link" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "收起要点" : "展开要点"}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>}
        {value.status !== "unconfigured" && <button className="home-btn" type="button" disabled={generating} onClick={onRegenerate}><RefreshCw size={14} className={generating ? "home-spin" : undefined} />{generating ? "生成中…" : "重新生成"}</button>}
      </div>
    </div>
    {body()}
    {hasContent && <div className="home-digest-foot"><span>{value.model_name ? `由 ${value.model_name} 生成` : "AI 生成"}</span><span>{value.generated_at ? `生成于 ${formatPublished(value.generated_at, now)}` : ""}</span></div>}
  </section>;
}
