import { useEffect, useState } from "react";
import { ArrowUpRight, Blocks, BookOpen, ChevronRight, Plus, Search, Server, Trash2 } from "lucide-react";
import { Switch } from "../../components/ui/Switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { ExtensionImport, McpImport } from "./ExtensionImport";
import { useExtensionPreview } from "./ExtensionPreviewContext";
import { ExecutionActivity } from "./ExecutionActivity";
import { SkillDiscovery } from "./SkillDiscovery";
import { PreviewDialog } from "./PreviewDialog";
import type { ExtensionKind } from "./types";
import "./extensions.css";

const tabs = [{ id: "skill", name: "技能", icon: BookOpen }, { id: "plugin", name: "插件", icon: Blocks }, { id: "mcp", name: "MCP", icon: Server }] as const;

export function ExtensionsPage() {
  const preview = useExtensionPreview();
  const refresh = preview.refresh;
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);
  const [tab, setTab] = useState<ExtensionKind | "mcp">("skill");
  const [query, setQuery] = useState("");
  const [skillView, setSkillView] = useState<"installed" | "discover">("installed");
  const discovering = tab === "skill" && skillView === "discover";
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const detail = preview.items.find((item) => item.id === detailId);
  const items = preview.items.filter((item) => item.kind === tab && `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const connections = tab === "mcp" ? preview.connections.filter((item) => `${item.name} ${item.endpoint}`.toLowerCase().includes(query.toLowerCase())) : [];
  const count = tab === "mcp" ? connections.length : items.length;
  const addLabel = tab === "mcp" ? "添加 MCP" : tab === "skill" ? "添加技能" : "添加插件";
  const openDetail = (id: string) => { setDetailId(id); void preview.loadDetail(id); };
  function resetCatalogFilters() {
    setQuery("");
    setDetailId(null);
  }
  return <div className="extensions-page">
    <header className="extensions-heading"><div><h1>扩展中心</h1><p>发现好用的技能，拓展团团的工作方式。</p></div><button type="button" className="extension-button" onClick={() => setAdding(true)}><Plus size={16} />{addLabel}</button></header>
    {preview.isPreview ? <div className="extension-preview-notice"><span className="extension-preview-dot" /><div><strong>界面预览 · 尚未连接执行服务</strong><p>可体验管理和制作流程。配置仅在当前会话保留，刷新后清空；不会安装扩展或执行任务。</p></div></div> : null}
    {preview.error ? <div className="extension-error" role="alert">{preview.error}<button className="extension-text-button" type="button" onClick={() => void preview.refresh().catch(() => undefined)}>重试读取</button></div> : null}
    {preview.loading ? <p role="status" className="extension-muted">正在读取扩展目录…</p> : null}
    <Tabs className="extension-catalog" value={tab} onValueChange={(value) => {
      const next = tabs.find((entry) => entry.id === value);
      if (next) { setTab(next.id); resetCatalogFilters(); }
    }}>
    <div className="extension-tab-bar">
      <TabsList aria-label="扩展类型" className="extension-tabs" activateOnFocus loopFocus>
        {tabs.map(({ id, name, icon: Icon }) => <TabsTrigger key={id} value={id} onClick={() => { if (id === tab) resetCatalogFilters(); }}>
          <Icon size={16} />{name}<span>{id === "mcp" ? preview.connections.length : preview.items.filter((item) => item.kind === id).length}</span>
        </TabsTrigger>)}
      </TabsList>
      <span className="extension-storage-label">{preview.isPreview ? "当前会话" : "按账号保存"}</span>
    </div>
    {tabs.map(({ id }) => <TabsContent key={id} value={id} render={<section />} keepMounted>{id === tab ? <>
      {tab !== "skill" ? <p className="extension-section-description">{tab === "plugin" ? "插件将技能、工具与模板组合为能力包。目前支持导入和管理清单，执行暂未开放。" : "准备外部工具和数据源的连接信息。目前仅保存配置草稿，尚未建立实际连接。"}</p> : null}
      <div className="extension-catalog-toolbar">{tab === "skill" ? <div className="skill-view-switch" role="group" aria-label="技能目录"><button type="button" aria-pressed={skillView === "installed"} onClick={() => setSkillView("installed")}>已安装</button><button type="button" aria-pressed={skillView === "discover"} onClick={() => { setSkillView("discover"); setDetailId(null); }}><Search size={14} aria-hidden="true" />发现技能</button></div> : null}{!discovering ? <label className="extension-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索扩展" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或说明" /></label> : null}</div>
      {discovering ? preview.discoveryService ? <SkillDiscovery service={preview.discoveryService} onInstalled={async () => { await preview.refresh(); }} onManageInstalled={(id) => { setSkillView("installed"); setQuery(""); openDetail(id); }} /> : <div className="extension-empty"><Search size={28} /><h2>登录后发现在线技能</h2><p>连接后端并登录，即可搜索、预览和安装公开技能。</p></div> : <>
      {!count && !preview.loading && !preview.error ? <div className="extension-empty"><span className="extension-empty-icon">{tab === "skill" ? <BookOpen size={28} /> : tab === "plugin" ? <Blocks size={28} /> : <Server size={28} />}</span><h2>{query ? "没有匹配的扩展" : tab === "mcp" ? "还没有 MCP 连接" : tab === "skill" ? "让团团学会你的工作方法" : "还没有插件清单"}</h2><p>{query ? "试试其他关键词，或清空搜索查看全部。" : tab === "mcp" ? "添加服务地址或本地命令，先准备一份连接草稿。" : tab === "skill" ? "从社区发现一个技能，或导入自己的说明文件。启用后，即可在聊天中选择使用。" : "导入插件清单，集中管理技能、工具与模板的声明。"}</p>{query ? <button className="extension-button" type="button" onClick={() => setQuery("")}>清空搜索</button> : tab === "skill" ? <div className="extension-empty-actions"><button className="extension-button primary" type="button" onClick={() => setSkillView("discover")}><Search size={16} />搜索在线技能</button><button className="extension-text-button" type="button" onClick={() => setAdding(true)}>导入本地文件<ChevronRight size={14} /></button></div> : <button className="extension-button" type="button" onClick={() => setAdding(true)}>{addLabel}</button>}</div> : null}
      {count > 0 ? <div className="extension-list-caption"><span>{query ? `找到 ${count} 项` : `共 ${count} 项`}</span><span>{tab === "skill" ? "打开开关后，可在聊天中选择技能" : tab === "mcp" ? "配置草稿" : "清单管理"}</span></div> : null}
      <div className="extension-list">{items.map((item) => <article className="extension-row" key={item.id}>
        <span className="extension-row-icon">{item.kind === "plugin" ? <Blocks size={22} /> : <BookOpen size={22} />}</span>
        <button className="extension-row-content" type="button" aria-label={`查看 ${item.name}`} onClick={() => detailId === item.id ? setDetailId(null) : openDetail(item.id)}><span className="extension-row-title"><strong>{item.name}</strong><span className="extension-tag">{item.source === "example" ? "示例" : item.source === "github" ? "GitHub" : item.source === "builtin" ? "内置" : preview.isPreview ? "本地预览" : "用户导入"}</span></span><span className="extension-row-description">{item.description}</span><span className="extension-row-meta">{item.kind === "plugin" && item.version ? `${item.version} · ` : ""}{item.unavailableReason || (preview.isPreview ? (item.enabled ? "已在预览中启用" : "已在预览中停用") : (item.enabled ? "已启用" : "已停用"))}</span></button>
        <div className="extension-row-actions"><Switch.Root className="extension-switch" checked={item.enabled} aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`} disabled={preview.busy || Boolean(item.unavailableReason)} title={item.unavailableReason || (preview.isPreview ? "仅影响当前预览" : "影响新发起的任务")} onCheckedChange={() => void preview.toggle(item.id).catch(() => undefined)}><Switch.Thumb /></Switch.Root><button className="extension-icon-button extension-detail-trigger" type="button" aria-label={`${item.name} 详情`} onClick={() => openDetail(item.id)}><ChevronRight size={17} /></button></div>
      </article>)}{connections.map((item) => <article key={item.id} className="extension-row"><span className="extension-row-icon"><Server size={22} /></span><div className="extension-row-content"><strong>{item.name}</strong><span className="extension-row-description">{item.endpoint}</span><span className="extension-row-meta">{item.transport === "http" ? "远程 HTTP" : "本地 stdio"} · 配置草稿 · 未连接</span></div><button className="extension-icon-button" type="button" aria-label={`删除 ${item.name}`} onClick={() => void preview.removeConnection(item.id).catch(() => undefined)}><Trash2 size={17} /></button></article>)}</div>
      {tab === "skill" ? <p className="extension-footnote">{preview.isPreview ? "支持 SKILL.md 元数据预览。" : "支持 SKILL.md 与技能 ZIP，启用后可在聊天中使用。"}</p> : null}
      </>}
    </> : null}</TabsContent>)}
    </Tabs>
    {detail && !adding ? <PreviewDialog title={detail.name} onClose={() => setDetailId(null)} wide><aside className="extension-detail" aria-label={`${detail.name} 详细信息`}><header><div><h2>{detail.name}</h2><p className="extension-detail-status">{detail.enabled ? "已启用" : "已停用"}</p></div></header><p>{detail.description}</p>{detail.kind === "skill" ? <><h3>在聊天中使用</h3><ol className="extension-usage"><li><b>1</b><span>先在这里启用技能，状态变为“已启用”。</span></li><li><b>2</b><span>回到聊天，点输入框旁的“技能”，选择 {detail.name}。</span></li><li><b>3</b><span>发送任务；技能只影响新发起的任务。</span></li></ol>{!detail.enabled ? <button className="extension-button primary" type="button" disabled={preview.busy || Boolean(detail.unavailableReason)} onClick={() => void preview.toggle(detail.id).catch(() => undefined)}>启用技能</button> : null}</> : null}<h3>来源</h3>{detail.origin ? <p className="skill-preview-origin"><a href={`https://github.com/${detail.origin.repository}/tree/${detail.origin.commit}/${detail.origin.path}`} target="_blank" rel="noreferrer">{detail.origin.repository}<ArrowUpRight size={13} /></a><span>{detail.origin.path || "仓库根目录"} · 版本 {detail.origin.commit.slice(0, 12)}</span></p> : <p className="extension-muted">{detail.source === "example" ? "内置示例" : detail.source === "builtin" ? "内置技能" : "本地导入"}</p>}<h3>权限声明</h3><p className="extension-muted">{detail.permissions.length ? detail.permissions.join(" · ") : "未声明权限"}。此处仅展示声明，尚未授予执行权限。</p><h3>{detail.kind === "skill" ? "技能指令" : "插件清单"}</h3><pre>{detail.instructions || "没有附加说明。"}</pre>{detail.source !== "example" && detail.source !== "builtin" ? <button className="extension-button danger" type="button" onClick={() => { void preview.remove(detail.id).then(() => setDetailId(null)).catch(() => undefined); }}><Trash2 size={15} />{preview.isPreview ? "移除预览" : "移除扩展"}</button> : null}</aside></PreviewDialog> : null}
    {adding && tab !== "mcp" ? <ExtensionImport kind={tab} live={!preview.isPreview} onAdd={(content) => preview.importContent(tab, content)} onImportFile={preview.importFile} onImported={(id) => { setSkillView("installed"); setQuery(""); if (id) setDetailId(id); }} onClose={() => setAdding(false)} /> : null}
    {adding && tab === "mcp" ? <McpImport live={!preview.isPreview} onAdd={preview.addConnection} onClose={() => setAdding(false)} /> : null}
    {preview.activityService ? <details className="extension-activity-disclosure" onToggle={event => setActivityOpen(event.currentTarget.open)}><summary>执行环境与后台任务</summary>{activityOpen ? <><p className="extension-muted">{preview.executionReason || "正在检查执行环境…"}</p><ExecutionActivity service={preview.activityService} /></> : null}</details> : null}
  </div>;
}
