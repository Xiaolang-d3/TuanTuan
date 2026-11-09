import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, Check, Download, LoaderCircle, Search } from "lucide-react";
import { PreviewDialog } from "./PreviewDialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OnlineSkill, SkillPreview } from "./types";

type DiscoveryService = {
  searchSkills(query: string, signal?: AbortSignal): Promise<{ skills: OnlineSkill[] }>;
  previewSkills(source: string, ref?: string, name?: string, signal?: AbortSignal): Promise<SkillPreview>;
  installSkill(previewId: string, path: string): Promise<{ id: string; enabled: boolean }>;
};
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const suggestions = [{ label: "前端开发", query: "react" }, { label: "写作", query: "writing" }, { label: "设计", query: "design" }, { label: "自动化测试", query: "testing" }];

export function SkillDiscovery({ service, onInstalled, onManageInstalled }: { service: DiscoveryService; onInstalled: (id: string) => void | Promise<void>; onManageInstalled?: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("");
  const [results, setResults] = useState<OnlineSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<SkillPreview | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");
  const [installed, setInstalled] = useState<{ id: string; enabled: boolean } | null>(null);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(12);
  const [previewTarget, setPreviewTarget] = useState("");
  const [showSource, setShowSource] = useState(false);
  const searchRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; searchRequest.current?.abort(); previewRequest.current?.abort(); };
  }, [service]);
  function cancelPreview() {
    previewRequest.current?.abort();
    setPreviewing(false); setError("");
  }
  async function search(term: string) {
    searchRequest.current?.abort();
    cancelPreview();
    const controller = new AbortController(); searchRequest.current = controller;
    setSearching(true); setError(""); setResults(null); setVisibleCount(12);
    try {
      const response = await service.searchSkills(term.trim(), controller.signal);
      if (!controller.signal.aborted) setResults(response.skills);
    } catch (caught) { if (!controller.signal.aborted) setError(message(caught)); }
    finally { if (!controller.signal.aborted) setSearching(false); }
  }
  async function preview(source: string, branch?: string, name?: string) {
    previewRequest.current?.abort();
    const controller = new AbortController(); previewRequest.current = controller;
    setPreviewTarget(`${source}/${name ?? ""}`);
    setPreviewing(true); setError(""); setInstalled(null); setInstallError("");
    try {
      const response = await service.previewSkills(source, branch, name, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(response); setSelectedPath(response.skills[0]?.path ?? ""); setShowSource(false);
    } catch (caught) { if (!controller.signal.aborted) setError(message(caught)); }
    finally { if (!controller.signal.aborted) setPreviewing(false); }
  }
  const selected = snapshot?.skills.find(item => item.path === selectedPath);
  async function install() {
    if (!snapshot || !selected || installing || installed) return;
    setInstalling(true); setInstallError("");
    try {
      const item = await service.installSkill(snapshot.preview_id, selected.path);
      if (!alive.current) return;
      setInstalled(item);
      setInstalledKeys(current => new Set([...current, `${snapshot.repository}/${selected.name}`.toLowerCase(), previewTarget.toLowerCase()]));
      await onInstalled(item.id);
    } catch (caught) { if (alive.current) setInstallError(message(caught)); }
    finally { if (alive.current) setInstalling(false); }
  }
  return <div className="skill-discovery">
    <div className="skill-discovery-intro"><h2>为下一件事，找一个好方法。</h2><p>发现社区共享的技能，把成熟的工作方法带进团团。</p></div>
    <form className="skill-search-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void search(query); }}>
      <label className="skill-search-field"><Search size={17} aria-hidden="true" /><input aria-label="搜索在线技能" placeholder="搜索工作方法，如 react、写作、测试" value={query} minLength={2} maxLength={100} required onChange={event => { searchRequest.current?.abort(); setSearching(false); setResults(null); cancelPreview(); setQuery(event.target.value); }} /></label>
      <button className="extension-button primary" type="submit" disabled={query.trim().length < 2 || searching}>{searching ? <LoaderCircle size={16} className="extension-spinning" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}搜索</button>
    </form>
    <div className="skill-search-suggestions"><span>试试这些方向</span>{suggestions.map(item => <button type="button" key={item.query} onClick={() => { setQuery(item.query); void search(item.query); }}>{item.label}<ArrowUpRight size={12} aria-hidden="true" /></button>)}</div>
    <details className="skill-repository"><summary>从 GitHub 仓库查找</summary><form onSubmit={event => { event.preventDefault(); void preview(repository.trim(), ref.trim() || undefined); }}>
      <label>GitHub 仓库<input value={repository} placeholder="owner/repo 或 GitHub 仓库地址" required maxLength={300} onChange={event => { cancelPreview(); setRepository(event.target.value); }} /></label>
      <label>分支或标签（选填）<input value={ref} placeholder="默认分支" maxLength={200} onChange={event => { cancelPreview(); setRef(event.target.value); }} /></label>
      <button className="extension-button" type="submit" disabled={previewing || !repository.trim()}>查找仓库技能</button>
    </form></details>
    {error ? <p className="extension-error" role="alert">{error}</p> : null}
    {searching || previewing ? <p className="skill-discovery-status extension-muted" role="status"><LoaderCircle size={16} className="extension-spinning" aria-hidden="true" />{previewing ? "正在读取仓库和技能内容…" : "正在搜索在线技能…"}</p> : null}
    {results?.length === 0 ? <div className="extension-empty"><Search size={26} /><h2>没有找到匹配的在线技能</h2><p>试试英文关键词，或通过 GitHub 仓库地址查找。</p></div> : null}
    {results?.length ? <><div className="skill-results-heading"><h3>搜索结果 <span>{results.length}</span></h3><span>来自 skills.sh · 安装前可预览</span></div><div className="extension-list skill-results" aria-label="在线搜索结果">{results.slice(0, visibleCount).map(item => {
      const present = item.installed || installedKeys.has(`${item.source}/${item.name}`.toLowerCase());
      const pending = previewing && previewTarget === `${item.source}/${item.name}`;
      return <article className="extension-row" key={`${item.source}/${item.name}`}><span className="extension-row-icon"><BookOpen size={19} /></span><div className="extension-row-content"><strong>{item.name}</strong><span className="extension-row-description">{item.source}</span></div><span className="skill-install-count"><Download size={13} aria-hidden="true" />{item.installs.toLocaleString()}<span className="sr-only"> 次安装</span></span><button className="extension-button compact" type="button" disabled={present || previewing} aria-label={`${present ? "已安装" : "预览"} ${item.name}`} onClick={() => void preview(item.source, undefined, item.name)}>{present ? <Check size={14} aria-hidden="true" /> : pending ? <LoaderCircle size={14} className="extension-spinning" aria-hidden="true" /> : null}{present ? "已安装" : pending ? "读取中" : "预览"}{!present && !pending ? <ArrowRight size={14} aria-hidden="true" /> : null}</button></article>;
    })}</div>{visibleCount < results.length ? <div className="skill-load-more"><span>已显示 {Math.min(visibleCount, results.length)} / {results.length} 个技能</span><button className="extension-button" type="button" onClick={() => setVisibleCount(count => count + 12)}>加载更多</button></div> : null}</> : null}
    {!results && !searching && !error && !previewing ? <div className="skill-discovery-guide"><BookOpen size={24} aria-hidden="true" /><h3>从你要完成的事开始</h3><p>输入关键词，或展开上方入口查找指定 GitHub 仓库。<br />先阅读技能内容，安装后启用，就能在聊天中使用。</p><span>公开目录由 skills.sh 提供</span></div> : null}
    {snapshot && selected ? <PreviewDialog title="预览并安装技能" wide onClose={() => { if (!installing) setSnapshot(null); }} footer={<>
      <div className="skill-install-note">{installed ? <p className="extension-success" role="status"><Check size={16} aria-hidden="true" />{installed.enabled ? "该技能已安装并启用。" : "安装完成，当前为停用状态。"}</p> : <p>安装后默认停用，启用后可在聊天中使用。</p>}{installError ? <p className="extension-error" role="alert">{installError}</p> : null}</div>
      <div className="extension-actions"><button className="extension-button" type="button" disabled={installing} onClick={() => setSnapshot(null)}>{installed ? "完成" : "取消"}</button>{installed ? onManageInstalled ? <button className="extension-button primary" type="button" disabled={installing} onClick={() => { setSnapshot(null); onManageInstalled(installed.id); }}>去启用<ArrowRight size={15} /></button> : null : <button className="extension-button primary" type="button" disabled={installing} onClick={() => void install()}>{installing ? <LoaderCircle size={15} className="extension-spinning" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{installing ? "正在安装…" : "安装技能"}</button>}</div>
    </>}><div className="extension-form skill-preview">
      <div className="skill-preview-heading"><span className="extension-row-icon"><BookOpen size={24} /></span><div><h3>{selected.name}</h3><p className="extension-muted">{selected.description}</p></div></div>
      <div className="skill-preview-origin"><a href={`https://github.com/${snapshot.repository}/tree/${snapshot.commit}/${selected.path}`} target="_blank" rel="noreferrer">{snapshot.repository}<ArrowUpRight size={14} /></a><span>版本 {snapshot.commit.slice(0, 12)} · {selected.path || "仓库根目录"}</span></div>
      {snapshot.skills.length > 1 ? <label>选择技能<select value={selectedPath} disabled={installing || Boolean(installed)} onChange={event => { setSelectedPath(event.target.value); setInstallError(""); }}>{snapshot.skills.map(item => <option key={item.path} value={item.path}>{item.name} · {item.path || "根目录"}</option>)}</select></label> : null}
      <div><div className="skill-content-heading"><h4>技能正文 · SKILL.md</h4><div role="group" aria-label="内容视图"><button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>阅读</button><button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>源码</button></div></div>{showSource ? <pre className="skill-preview-content">{selected.content}</pre> : <div className="skill-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a href={props.href} target="_blank" rel="noreferrer">{props.children}</a>, img: props => <span className="extension-muted">[图片：{props.alt || "未命名"}]</span> }}>{selected.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}</ReactMarkdown></div>}</div>
      <div><h4>附带资源（{selected.files.length}）</h4>{selected.files.length ? <ul className="skill-preview-files">{selected.files.map(path => <li key={path}>{path}</li>)}</ul> : <p className="extension-muted">只有技能说明文件。</p>}</div>
      {snapshot.skipped ? <p className="extension-muted">已跳过 {snapshot.skipped} 个格式无效或超过大小限制的技能。</p> : null}
      <p className="extension-footnote">安装内容与本次预览一致，预览保留 30 分钟。</p>
    </div></PreviewDialog> : null}
  </div>;
}
