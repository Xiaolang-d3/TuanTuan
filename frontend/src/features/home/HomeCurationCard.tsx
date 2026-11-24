import type { MouseEventHandler } from "react";
import { Newspaper } from "lucide-react";
import { validWebUrl } from "./HomeFeedCards";
import type { HomeCuration } from "./types";

type HomeCurationCardProps = {
  curation?: HomeCuration;
  loading: boolean;
  now: Date;
  onRegenerate: () => void;
  onOpenInterest: MouseEventHandler<HTMLButtonElement>;
};

export function HomeCurationCard({ curation, loading, now, onRegenerate, onOpenInterest }: HomeCurationCardProps) {
  if (!curation) return loading ? <section className="home-module home-curation" aria-label="今日值得看"><div className="home-skeleton-list" role="status" aria-label="资讯精选加载中"><div className="home-skeleton-card"><div className="home-skeleton home-skeleton-line" /><div className="home-skeleton home-skeleton-line short" /></div></div></section> : null;
  const needsSettings = curation.status === "disabled" || curation.status === "unconfigured";
  const generating = curation.status === "generating";
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const windowHours = (generating ? curation.requested_window_hours : curation.window_hours) ?? curation.window_hours ?? 24;
  const windowLabel = windowHours === 72 ? "近3天" : `过去${windowHours}小时`;
  const previous = curation.items.length > 0 && curation.date !== today;
  const emptyMessage = curation.empty_reason === "no_recent_candidates" ? "本次未找到时间范围内可核实的候选资讯"
    : curation.empty_reason === "editorial_filter" ? "本次候选未达到推荐标准"
    : curation.empty_reason === "validation_filter" ? "本次候选未通过日期、去重或依据检查"
    : "本次筛选未选出推荐内容";
  return <section className="home-module home-curation" aria-labelledby="home-curation-title" data-status={curation.status}>
    <div className="home-module-head"><h2 className="home-module-title" id="home-curation-title"><span className="home-module-icon"><Newspaper size={15} /></span>今日值得看<span className="home-count">{windowLabel}</span>{curation.date && <span className="home-count">{curation.date}</span>}</h2></div>
    <p className="home-digest-status">新模型发布 · 能力评测 · 价格与使用成本</p>
    {needsSettings && <div className="home-curation-message"><p>{curation.status === "disabled" ? "还没有启用每日资讯精选" : "请选择资讯精选使用的文本模型"}</p><button className="home-btn" type="button" onClick={onOpenInterest}>兴趣设置</button></div>}
    {curation.status === "empty" && <p className="home-digest-status">{emptyMessage}</p>}
    {curation.diagnostics && (curation.status === "ready" || curation.status === "empty") && <p className="home-digest-status">已核实 {curation.diagnostics.verified_candidates} 条候选 · 入选 {curation.diagnostics.selected_items} 条</p>}
    {curation.status === "error" && <p className="home-digest-warning" role="alert">{curation.error || "资讯筛选失败，请重试"}</p>}
    {generating && <p className="home-digest-status" role="status">{curation.items.length ? "正在筛选今日资讯，保留上次内容供阅读" : "正在搜索、去重并筛选今日资讯…"}</p>}
    {previous && <p className="home-digest-warning">上次精选：{curation.date || "日期未提供"}（非今日结果）</p>}
    {curation.status === "stale" && <p className="home-digest-status">筛选方向、范围或兴趣有更新，可重新筛选模型相关资讯。</p>}
    {(!generating || curation.items.length > 0) && curation.warnings.map((warning, index) => <p className="home-digest-warning" key={`${index}:${warning}`}>{warning}</p>)}
    {!needsSettings && <div className="home-curation-message"><button className="home-btn" type="button" disabled={generating} onClick={onRegenerate}>重新筛选</button><span>重新筛选会产生新的搜索和模型请求。</span></div>}
    <div className="home-curation-items">{curation.items.map((item) => <article className="home-curation-item" key={item.id}>
      <h3>{validWebUrl(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</h3>
      <p>{item.summary}</p>
      <p className="home-curation-why"><b>为什么值得看</b><span>{item.why_it_matters}</span></p>
      <div className="home-curation-meta"><span>{item.source}</span><span>发布：<time dateTime={item.published_at || undefined}>{item.published_at || "时间未提供"}</time></span><span>事件：<time dateTime={item.event_date || undefined}>{item.event_date || "时间未提供"}</time></span></div>
      <details><summary>可信度与依据</summary><p>可信度：{item.confidence === "high" ? "高" : "中"}</p><p>{item.evidence}</p></details>
    </article>)}</div>
    {(!generating || curation.items.length > 0) && (curation.model_name || curation.generated_at) && <div className="home-digest-foot"><span>{curation.model_name ? `由 ${curation.model_name} 筛选` : "候选检查"}</span>{curation.generated_at && <span>{curation.model_name ? "筛选于 " : "检查于 "}<time dateTime={curation.generated_at}>{curation.generated_at}</time></span>}</div>}
  </section>;
}
