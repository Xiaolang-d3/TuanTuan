import { useState } from "react";
import { ChevronDown, Package, Sparkles, TriangleAlert } from "lucide-react";
import type { HomeChangelogItem, HomeWorkspaceResponse } from "./types";

function ChangelogEntry({ item }: { item: HomeChangelogItem }) {
  const [open, setOpen] = useState(false);
  return <div className="home-changelog-item">
    <div className="home-changelog-head"><span className="home-changelog-category">{item.category}</span><span className="home-changelog-version">{item.version}</span><button className="home-more-link" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "收起" : "展开"}<ChevronDown size={14} className={open ? "home-chevron-open" : undefined} /></button></div>
    <p className={`home-changelog-text${open ? "" : " home-changelog-text--clamped"}`}>{item.text}</p>
  </div>;
}

type HomeProductUpdatesProps = {
  workspace: HomeWorkspaceResponse | null;
  loading: boolean;
};

export function HomeProductUpdates({ workspace, loading }: HomeProductUpdatesProps) {
  if (loading && !workspace) {
    return <div className="home-product-updates" role="status" aria-label="团团动态加载中">{Array.from({ length: 2 }, (_, index) => <div className="home-updates-card home-skeleton-card" key={index}><div className="home-skeleton home-skeleton-title" /><div className="home-skeleton home-skeleton-line" /><div className="home-skeleton home-skeleton-line short" /></div>)}</div>;
  }
  if (!workspace) return null;
  const changelog = workspace.changelog.items.slice(0, 6);
  const skills = workspace.skills.items.slice(0, 3);
  return <div className="home-product-updates">
    <section className="home-updates-card" aria-labelledby="home-updates-changelog-title">
      <div className="home-updates-head"><h2 className="home-updates-title" id="home-updates-changelog-title"><span className="home-module-icon"><Package size={15} /></span>更新日志精选</h2></div>
      {workspace.changelog.error ? <p className="home-workspace-block-error"><TriangleAlert size={14} />{workspace.changelog.error}</p> : changelog.length === 0 ? <p className="home-workspace-empty"><span>暂时没有更新日志，新版本发布后会第一时间同步到这里。</span></p> : <div className="home-changelog-list">{changelog.map((item) => <ChangelogEntry key={`${item.version}:${item.category}:${item.text}`} item={item} />)}</div>}
    </section>
    <section className="home-updates-card" aria-labelledby="home-updates-skills-title">
      <div className="home-updates-head"><h2 className="home-updates-title" id="home-updates-skills-title"><span className="home-module-icon"><Sparkles size={15} /></span>新技能推荐</h2></div>
      {workspace.skills.error ? <p className="home-workspace-block-error"><TriangleAlert size={14} />{workspace.skills.error}</p> : skills.length === 0 ? <div className="home-workspace-empty"><p>技能中心会持续上新，先看看已安装的技能。</p><a className="home-link-btn" href="#/settings/extensions">打开技能中心</a></div> : <div className="home-skill-list">{skills.map((skill) => <a className="home-skill-card" key={`${skill.name}:${skill.source}`} href="#/settings/extensions" title={skill.name}><span className="home-skill-name">{skill.name}</span><span className="home-skill-summary">{skill.summary}</span><span className="home-skill-source">{skill.source}</span></a>)}</div>}
    </section>
  </div>;
}
