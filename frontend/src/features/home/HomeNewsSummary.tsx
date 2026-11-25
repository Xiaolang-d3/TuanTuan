import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, Newspaper } from "lucide-react";
import { FeedActions, articleReadable, formatPublished, validWebUrl } from "./HomeFeedCards";
import type { HomeArticle } from "./types";

type HomeNewsSummaryProps = {
  articles: HomeArticle[];
  loading: boolean;
  unavailable: boolean;
  now: Date;
  controls: ReactNode;
  status: ReactNode;
  cardActions: (id: string) => Omit<ComponentProps<typeof FeedActions>, "item">;
  children: ReactNode;
};

export function HomeNewsSummary({ articles, loading, unavailable, now, controls, status, cardActions, children }: HomeNewsSummaryProps) {
  const titleId = useId();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  function toggleDetails() {
    setExpanded(!expanded);
    if (!expanded) setHasOpened(true);
  }

  return <section className="home-news-summary" aria-labelledby={titleId}>
    <div className="home-module">
      <div className="home-module-head home-news-summary-head">
        <h2 id={titleId} className="home-module-title"><span className="home-module-icon"><Newspaper size={15} aria-hidden="true" /></span>最新资讯</h2>
        {controls}
      </div>
      {status}
      {articles.length > 0 ? <ul className="home-news-summary-list">
        {articles.map((article) => <li key={article.id} className="home-news-summary-item">
          <div className="home-news-summary-copy">
            <h3 className="home-news-summary-title">{validWebUrl(article.url) ? <a href={article.url} target="_blank" rel="noreferrer">{article.title}</a> : article.title}</h3>
            {article.summary && <p className="home-news-summary-description">{article.summary}</p>}
            <div className="home-meta"><span className="home-source" title={article.source}>{article.source}</span><span aria-hidden="true">·</span><time dateTime={article.published_at || undefined}>{formatPublished(article.published_at, now)}</time></div>
          </div>
          <FeedActions item={articleReadable(article)} {...cardActions(article.id)} />
        </li>)}
      </ul> : loading ? <p className="home-news-summary-message" role="status">正在加载资讯…</p> : !unavailable && <p className="home-news-summary-message">暂时没有符合当前兴趣的资讯。</p>}
      <div className="home-news-summary-foot">
        <button className="home-btn" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={toggleDetails}>
          {expanded ? "收起完整资讯" : "查看完整资讯"}<ChevronDown size={14} className={expanded ? "home-chevron-open" : undefined} aria-hidden="true" />
        </button>
      </div>
    </div>
    <div id={detailsId} hidden={!expanded}>{hasOpened && children}</div>
  </section>;
}
