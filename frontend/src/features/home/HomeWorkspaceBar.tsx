import { Library, ListChecks, MessageCircle, TriangleAlert } from "lucide-react";
import { formatPublished } from "./HomeFeedCards";
import type { HomeJobBrief, HomeLibraryRecentItem, HomeWorkspaceResponse } from "./types";

const LIBRARY_KIND_LABELS: Record<string, string> = { source: "网页资料", note: "笔记", chat: "对话摘要" };

type HomeWorkspaceBarProps = {
  workspace: HomeWorkspaceResponse | null;
  loading: boolean;
  error: string | null;
  now: Date;
  onRefresh: () => void;
  weixinLive?: { connected: boolean; unread_count: number } | null;
};

function WorkspaceSkeleton() {
  return <div className="home-workspace-grid" role="status" aria-label="工作区加载中">{Array.from({ length: 4 }, (_, index) => <div className="home-workspace-card home-skeleton-card" key={index}><div className="home-skeleton home-skeleton-title" /><div className="home-skeleton home-skeleton-line" /><div className="home-skeleton home-skeleton-line short" /></div>)}</div>;
}

function JobRow({ job, now }: { job: HomeJobBrief; now: Date }) {
  return <li><a className="home-workspace-row" href="#/settings/extensions" title={job.display_title}><span className="home-workspace-row-title">{job.display_title}</span>{job.status && <span className="home-workspace-chip">{job.status}</span>}<time dateTime={job.created_at || undefined}>{job.created_at ? formatPublished(job.created_at, now) : ""}</time></a></li>;
}

function LibraryRow({ item, now }: { item: HomeLibraryRecentItem; now: Date }) {
  return <li><a className="home-workspace-row" href="#/chat/library" title={item.title}><span className="home-workspace-row-title">{item.title}</span>{item.kind && <span className="home-workspace-chip">{LIBRARY_KIND_LABELS[item.kind] || item.kind}</span>}<time dateTime={item.created_at || undefined}>{item.created_at ? formatPublished(item.created_at, now) : ""}</time></a></li>;
}

export function HomeWorkspaceBar({ workspace, loading, error, now, onRefresh, weixinLive }: HomeWorkspaceBarProps) {
  if (loading && !workspace) return <WorkspaceSkeleton />;
  if (!workspace) {
    return <div className="home-workspace-error" role="alert"><TriangleAlert size={16} /><span>{error || "工作区信息请求失败，请重试"}</span><button className="home-btn" type="button" onClick={onRefresh}>重试</button></div>;
  }
  const weixin = weixinLive?.connected ? weixinLive : workspace.weixin;
  const conversations = workspace.conversations.items.slice(0, 3);
  const running = workspace.jobs.running.slice(0, 5);
  const pending = workspace.jobs.pending_confirmations.slice(0, 5);
  const libraryItems = workspace.library_recent.items.slice(0, 3);
  return <div className="home-workspace-grid">
    <section className="home-workspace-card" aria-labelledby="home-ws-conversations-title">
      <div className="home-workspace-head"><h2 className="home-workspace-title" id="home-ws-conversations-title"><span className="home-module-icon"><MessageCircle size={15} /></span>最近会话</h2></div>
      {workspace.conversations.error ? <p className="home-workspace-block-error"><TriangleAlert size={14} />{workspace.conversations.error}</p> : conversations.length === 0 ? <div className="home-workspace-empty"><p>还没有会话记录，从一个问题或一句“你好”开始。</p><a className="home-btn home-btn-primary" href="#/chat">开始一个新会话</a></div> : <ul className="home-workspace-list">{conversations.map((item) => <li key={item.id}><a className="home-workspace-row" href={`#/chat/${item.id}`} title={item.title}><span className="home-workspace-row-title">{item.title}</span>{item.task_status && <span className="home-workspace-chip">{item.task_status}</span>}<time dateTime={item.last_message_at || undefined}>{item.last_message_at ? formatPublished(item.last_message_at, now) : ""}</time></a></li>)}</ul>}
    </section>
    <section className="home-workspace-card" aria-labelledby="home-ws-jobs-title">
      <div className="home-workspace-head"><h2 className="home-workspace-title" id="home-ws-jobs-title"><span className="home-module-icon"><ListChecks size={15} /></span>进行中任务</h2>{running.length > 0 && <span className="home-count">{running.length} 个进行中</span>}</div>
      {running.length === 0 && pending.length === 0 ? <div className="home-workspace-empty"><p>暂时没有进行中的任务，任务进度会实时同步到这里。</p><a className="home-btn" href="#/settings/extensions">打开任务中心</a></div> : <ul className="home-workspace-list">{running.map((job) => <JobRow key={job.id} job={job} now={now} />)}{pending.length > 0 && <li className="home-workspace-group">待确认</li>}{pending.map((job) => <JobRow key={job.id} job={job} now={now} />)}</ul>}
    </section>
    <section className="home-workspace-card" aria-labelledby="home-ws-weixin-title">
      <div className="home-workspace-head"><h2 className="home-workspace-title" id="home-ws-weixin-title"><span className="home-module-icon"><MessageCircle size={15} /></span>微信</h2>{weixin.connected && weixin.unread_count > 0 && <span className="home-workspace-badge">{weixin.unread_count}</span>}</div>
      {!weixin.connected ? <div className="home-workspace-empty"><p>还没有绑定微信，绑定后未读消息会汇总到这里。</p><a className="home-btn home-btn-primary" href="#/settings/channels">绑定微信</a></div> : weixin.unread_count > 0 ? <div className="home-weixin-unread"><p>有 <b>{weixin.unread_count}</b> 条未读消息。</p><a className="home-link-btn" href="#/settings/channels">去查看</a></div> : <div className="home-workspace-empty"><p>暂无未读消息。</p><a className="home-link-btn" href="#/settings/channels">微信设置</a></div>}
    </section>
    <section className="home-workspace-card" aria-labelledby="home-ws-library-title">
      <div className="home-workspace-head"><h2 className="home-workspace-title" id="home-ws-library-title"><span className="home-module-icon"><Library size={15} /></span>资料库最近</h2></div>
      {workspace.library_recent.error ? <p className="home-workspace-block-error"><TriangleAlert size={14} />{workspace.library_recent.error}</p> : libraryItems.length === 0 ? <div className="home-workspace-empty"><p>资料库里还没有内容，收藏的资讯和笔记会出现在这里。</p><a className="home-btn" href="#/chat/library">打开资料库</a></div> : <ul className="home-workspace-list">{libraryItems.map((item) => <LibraryRow key={item.id} item={item} now={now} />)}</ul>}
    </section>
  </div>;
}
