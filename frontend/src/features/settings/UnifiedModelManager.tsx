import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, Image, MessageSquare, Plus, RefreshCw, Search, Server, SlidersHorizontal, Trash2 } from "lucide-react";
import type { createApiClient } from "../../api/client";
import type { ModelCatalog, ModelCatalogEntry, ModelConnection, ModelProfile } from "../../types";
import { useComposerModelDiscovery } from "../chat/useComposerModelDiscovery";
import { inferredOutputTypes, type ModelCategory } from "../chat/model-categories";
import { ModelUsageRules } from "./ModelUsageRules";
import { UnifiedConnectionEditor } from "./UnifiedConnectionEditor";
import { UnifiedModelInspector } from "./UnifiedModelInspector";
import "./model-connections.css";
import "./unified-model-manager.css";

export type UnifiedModelManagerProps = {
  catalog: ModelCatalog; loading: boolean; busy: boolean; error: string; secretWritable?: boolean;
  fetchJson: ReturnType<typeof createApiClient>;
  onReload: () => Promise<void>;
  onMutate: (path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => Promise<boolean>;
  onEnsureProfile: (connectionId: string, modelName: string, revision: number) => Promise<string | null>;
  onApplied: () => Promise<void>;
  advanced?: ReactNode;
};
type Row = { connection: ModelConnection; name: string; profile?: ModelProfile; entry?: ModelCatalogEntry; types: ModelCategory[] };
const categories = [{ id: "all", label: "全部" }, { id: "chat", label: "文本" }, { id: "image", label: "图片" }, { id: "video", label: "视频" }, { id: "unknown", label: "待确认" }];
const normalizedAddress = (value: string) => value.trim().replace(/\/+$/, "");

export function UnifiedModelManager({ catalog, loading, busy, error, secretWritable, fetchJson, onReload, onMutate, onEnsureProfile, onApplied, advanced }: UnifiedModelManagerProps) {
  const owner = useMemo(() => ({ active: true }), [fetchJson]);
  const active = useRef(owner); active.current = owner;
  const latestCatalog = useRef(catalog); latestCatalog.current = catalog;
  const [tab, setTab] = useState("models");
  const [advancedMode, setAdvancedMode] = useState(false);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [editor, setEditor] = useState<{ owner: object; connection?: ModelConnection } | null>(null);
  const [inspector, setInspector] = useState<{ owner: object; id: string; preview?: Row; capabilities?: boolean; trigger?: HTMLElement } | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ owner: object; ids: string[]; address: string; id?: string; revision?: number } | null>(null);
  const [manual, setManual] = useState(false);
  const [manualService, setManualService] = useState("");
  const [manualName, setManualName] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{ owner: object; connection: ModelConnection } | null>(null);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [inspectorSaving, setInspectorSaving] = useState(false);
  const [pendingInspectorAction, setPendingInspectorAction] = useState<(() => void) | null>(null);
  const running = useRef<object | null>(null);
  const discovery = useComposerModelDiscovery({ fetchJson, scope: owner, connections: catalog.connections });
  const locked = busy || working || inspectorSaving;
  useEffect(() => {
    owner.active = true;
    setServiceId(null); setEditor(null); setInspector(null); setPendingConnection(null); setManual(false); setRemoval(null);
    setInspectorDirty(false); setInspectorSaving(false); setPendingInspectorAction(null); setManualName(""); setManualService(""); setNotice(""); setArchiveId(null); setWorking(false); running.current = null;
    return () => { owner.active = false; };
  }, [owner]);
  useEffect(() => {
    if (!pendingConnection || pendingConnection.owner !== owner) return;
    const added = catalog.connections.filter(item => pendingConnection.id ? item.id === pendingConnection.id && item.revision !== pendingConnection.revision : !pendingConnection.ids.includes(item.id) && normalizedAddress(item.model_base_url) === pendingConnection.address);
    if (added.length !== 1) return;
    setServiceId(added[0].id); setPendingConnection(null);
    void discovery.discover(true, added[0].id);
  }, [catalog.connections, pendingConnection, owner, discovery.discover]);
  useEffect(() => {
    if (serviceId && !catalog.connections.some(item => item.id === serviceId)) setServiceId(null);
  }, [catalog.connections, serviceId]);

  const rows: Row[] = [];
  for (const connection of catalog.connections) {
    const saved = new Map<string, ModelProfile>();
    for (const profile of catalog.profiles.filter(item => item.connection_id === connection.id)) {
      const previous = saved.get(profile.model_name);
      if (!previous || (!previous.enabled && profile.enabled) || profile.id === catalog.purpose_defaults?.chat || profile.id === catalog.purpose_defaults?.image) saved.set(profile.model_name, profile);
    }
    const source = discovery.catalogs.find(item => item.connection_id === connection.id);
    for (const name of new Set([...saved.keys(), ...(source?.models ?? [])])) {
      const profile = saved.get(name);
      const entry = source?.entries?.find(item => item.id === name) ?? profile?.discovery ?? undefined;
      rows.push({ connection, name, profile, entry, types: profile?.output_types ?? entry?.output_types ?? inferredOutputTypes(name, connection.detected_protocol || connection.model_protocol, profile?.capabilities) });
    }
  }
  const visible = rows.filter(row => (!serviceId || row.connection.id === serviceId) && `${row.name} ${row.entry?.display_name ?? ""} ${row.connection.name}`.toLowerCase().includes(query.trim().toLowerCase()) && (category === "all" || (category === "unknown" ? !row.types.length : row.types.includes(category as ModelCategory))) && (availability === "all" || (availability === "enabled" ? row.profile?.enabled && row.connection.enabled : !row.profile?.enabled || !row.connection.enabled)));
  const hasServices = catalog.connections.length > 0;
  const hasFilters = Boolean(query.trim() || category !== "all" || availability !== "all");
  function resetFilters() { setQuery(""); setCategory("all"); setAvailability("all"); }
  const selectedService = catalog.connections.find(item => item.id === serviceId);
  const inspectedProfile = inspector?.owner === owner ? catalog.profiles.find(item => item.id === inspector.id) ?? (inspector.preview ? { id: inspector.id, connection_id: inspector.preview.connection.id, model_name: inspector.preview.name, enabled: false, revision: 0, output_types: inspector.preview.types } : undefined) : undefined;
  const discoveryBusy = discovery.catalogs.some(item => item.busy && (!serviceId || item.connection_id === serviceId));
  function protectInspector(action: () => void) {
    if (inspectorSaving) return;
    if (inspectorDirty) setPendingInspectorAction(() => action);
    else action();
  }
  function closeInspector() {
    protectInspector(() => { const trigger = inspector?.trigger; setInspector(null); setInspectorDirty(false); trigger?.focus(); });
  }
  const defaults = catalog.purpose_defaults;
  const defaultVersion = catalog.purpose_version;
  const ready = defaults !== undefined && defaultVersion !== undefined;
  const removing = removal?.owner === owner ? removal.connection : undefined;
  const removalProfiles = catalog.profiles.filter(item => item.connection_id === removing?.id);
  const removalProtected = removalProfiles.some(item => [catalog.default_profile_id, defaults?.chat, defaults?.image].includes(item.id));
  const removalOutdated = Boolean(removing && catalog.connections.find(item => item.id === removing.id)?.revision !== removing.revision);

  async function run(action: () => Promise<void>) {
    if (locked || running.current === owner) return;
    running.current = owner; setWorking(true); setNotice("");
    try { await action(); }
    catch { if (active.current === owner) setNotice("操作未确认，请重新读取配置并核对后重试。"); }
    finally { if (active.current === owner) { running.current = null; setWorking(false); } }
  }
  async function ensure(row: Row) {
    if (row.profile?.enabled) return row.profile.id;
    if (row.profile) return await onMutate(`/agent/model-profiles/${encodeURIComponent(row.profile.id)}`, "PATCH", { enabled: true, expected_revision: row.profile.revision }) ? row.profile.id : null;
    return onEnsureProfile(row.connection.id, row.name, row.connection.revision);
  }
  function useModel(row: Row, purpose: "chat" | "image") {
    if (!ready) { setNotice("默认用途尚未读取，请重新读取配置后再选择。"); return; }
    const version = defaultVersion;
    void run(async () => {
      const id = await ensure(row);
      if (!id || active.current !== owner || !owner.active) return;
      const latestConnection = latestCatalog.current.connections.find(item => item.id === row.connection.id);
      if (!latestConnection?.enabled || latestConnection.revision !== row.connection.revision) { setNotice("服务配置已更新，请重新获取模型后再选择。"); return; }
      if (await onMutate(`/agent/model-defaults/${purpose}`, "POST", { profile_id: id, expected_version: version })) {
        if (active.current !== owner) return;
        setNotice(`已用于${purpose === "chat" ? "文本对话与工作" : "图片生成"}，从后续新任务生效。`);
        try { await onApplied(); } catch { if (active.current === owner) setNotice("默认模型已保存，摘要未刷新，请重新读取配置核对。"); }
      }
    });
  }
  function toggle(row: Row) {
    void run(async () => {
      if (row.profile?.enabled) {
        if (await onMutate(`/agent/model-profiles/${encodeURIComponent(row.profile.id)}`, "PATCH", { enabled: false, expected_revision: row.profile.revision }) && active.current === owner) setNotice("模型已停用。原有默认用途可能需要重新选择。");
      } else if (await ensure(row) && active.current === owner) setNotice("模型已启用。可继续选择它的默认用途。");
    });
  }
  function inspect(row: Row, capabilities = false, trigger?: HTMLElement) {
    const id = row.profile?.id ?? `preview:${row.connection.id}:${row.name}`;
    if (inspector?.id === id) {
      setInspector(current => current ? { ...current, capabilities: current.capabilities || capabilities } : current);
      document.querySelector<HTMLElement>(".unified-inspector")?.focus();
      return;
    }
    protectInspector(() => { setInspectorDirty(false); setInspector({ owner, id, preview: row.profile ? undefined : row, capabilities, trigger }); });
  }
  function activatePreview() {
    const row = inspector?.preview;
    if (!row) return;
    void run(async () => {
      const id = await ensure(row);
      if (id && active.current === owner) { setInspector({ owner, id, capabilities: inspector.capabilities, trigger: inspector.trigger }); setNotice("模型已启用，可编辑参数；尚未设为默认。"); }
    });
  }
  function addManual() {
    const connection = catalog.connections.find(item => item.id === manualService);
    if (!connection || !manualName.trim()) return;
    protectInspector(() => {
      setInspector(null); setInspectorDirty(false);
      void run(async () => { const id = await onEnsureProfile(connection.id, manualName.trim(), connection.revision); if (id && active.current === owner) { setManual(false); setManualName(""); setInspector({ owner, id, capabilities: true }); setNotice("模型已添加，可在下方确认输出能力后选择默认用途。"); } });
    });
  }

  return <div className="unified-model-manager model-connections-card">
    <header className="unified-heading"><div><h2>模型管理</h2><p>连接服务，获取模型，再选择适合的文本与图片模型。</p></div><button type="button" className="unified-primary" disabled={locked || loading || editor?.owner === owner} onClick={() => setEditor({ owner })}><Plus size={16} />添加服务</button></header>
    <nav className="unified-tabs" aria-label="模型管理内容"><button type="button" aria-pressed={tab === "models"} onClick={() => setTab("models")}>模型与服务</button><button type="button" aria-pressed={tab === "rules"} onClick={() => protectInspector(() => { setInspector(null); setInspectorDirty(false); setTab("rules"); })}>使用规则</button><button type="button" className="unified-advanced-toggle" aria-pressed={advancedMode} onClick={() => setAdvancedMode(value => !value)}><SlidersHorizontal size={14} />{advancedMode ? "收起高级" : "高级设置"}</button></nav>
    {error ? <div role="alert" className="unified-alert">{error}<button type="button" disabled={locked || loading} onClick={() => void onReload()}>重新读取</button></div> : null}
    {notice ? <p className="unified-notice" role="status">{notice}</p> : null}
    {pendingInspectorAction ? <div className="unified-discard" role="alert"><p>参数有未保存的修改。可继续编辑并保存，或放弃后继续。</p><button type="button" onClick={() => { setPendingInspectorAction(null); document.querySelector<HTMLElement>(".unified-inspector")?.focus(); }}>继续编辑</button><button type="button" disabled={locked} onClick={() => { if (locked) return; const action = pendingInspectorAction; setPendingInspectorAction(null); setInspectorDirty(false); action(); }}>放弃参数修改并继续</button></div> : null}
    {removing ? <section className="unified-removal" aria-label="删除服务"><h3>删除“{removing.name || "模型服务"}”？</h3><p>{removing.model_base_url}</p><p>此服务及 {removalProfiles.length} 个已保存模型将从列表中移除，历史对话记录保留。需要再次使用时可重新添加服务。</p>{removalProtected ? <p role="alert">此服务包含当前默认模型，请先切换文本或图片默认模型，再删除服务。</p> : null}{removalOutdated ? <p role="alert">服务配置已更新，请取消后重新选择要删除的服务。</p> : null}<div className="unified-actions"><button type="button" className="unified-danger" disabled={locked || loading || removalProtected || removalOutdated} onClick={() => protectInspector(() => { setInspector(null); setInspectorDirty(false); void run(async () => {
      if (await onMutate(`/agent/model-connections/${encodeURIComponent(removing.id)}?remove=true&expected_revision=${removing.revision}`, "DELETE") && active.current === owner) {
        setRemoval(null); setArchiveId(null); setServiceId(value => value === removing.id ? null : value);
        setManual(false); setInspector(null); setNotice("服务已删除，历史对话记录已保留。");
        try { await onApplied(); } catch { if (active.current === owner) setNotice("服务已删除，请重新读取配置以刷新摘要。"); }
      }
    }); })}>确认删除</button><button type="button" disabled={locked} onClick={() => setRemoval(null)}>取消删除</button></div></section> : null}
    {editor?.owner === owner ? <UnifiedConnectionEditor key={editor.connection?.id ?? "new"} connection={editor.connection} currentConnection={catalog.connections.find(item => item.id === editor.connection?.id)} connections={catalog.connections} busy={locked} secretWritable={secretWritable} onCancel={() => setEditor(null)} onSave={async body => {
      const ids = catalog.connections.map(item => item.id);
      const success = await onMutate(editor.connection ? `/agent/model-connections/${encodeURIComponent(editor.connection.id)}` : "/agent/model-connections", editor.connection ? "PATCH" : "POST", body);
      if (active.current !== owner) return false;
      if (success) {
        setEditor(null); setNotice("服务已保存，正在获取模型。目录不代表实际调用已验证。");
        setPendingConnection({ owner, ids, address: normalizedAddress(String(body.model_base_url)), id: editor.connection?.id, revision: editor.connection?.revision });
      }
      return success;
    }} /> : null}
    {tab === "models" && loading && !hasServices ? <p className="unified-loading" role="status"><RefreshCw size={16} className="spinning" aria-hidden="true" />正在读取服务与模型配置…</p> : null}
    {tab === "models" && !hasServices && !loading && editor?.owner !== owner ? <section className="unified-onboarding" aria-labelledby="unified-start-title">
      <Server size={28} aria-hidden="true" />
      <h3 id="unified-start-title">连接模型服务，开始使用</h3>
      <p>准备好服务商提供的 API 地址和密钥，团团会自动获取可选模型。</p>
      <ol className="unified-setup-steps">
        <li><span>1</span><div><strong>连接服务</strong><p>填写 Base URL 和 API Key</p></div></li>
        <li><span>2</span><div><strong>获取模型</strong><p>保存后自动读取模型列表</p></div></li>
        <li><span>3</span><div><strong>选择默认模型</strong><p>分别用于文本对话和图片生成</p></div></li>
      </ol>
      <button type="button" className="unified-primary" disabled={locked} onClick={() => setEditor({ owner })}>连接第一个服务<ArrowRight size={16} aria-hidden="true" /></button>
      <small>支持兼容 API 的服务和本地 Ollama；接口协议默认自动匹配。</small>
    </section> : null}
    {tab === "models" && hasServices ? <section className="unified-defaults" aria-label="当前默认模型">
      {(["chat", "image"] as const).map(purpose => {
        const profile = catalog.profiles.find(item => item.id === defaults?.[purpose]);
        const connection = catalog.connections.find(item => item.id === profile?.connection_id);
        const usable = profile?.enabled && connection?.enabled;
        return <div className="unified-default-summary" key={purpose}>
          {purpose === "chat" ? <MessageSquare size={18} aria-hidden="true" /> : <Image size={18} aria-hidden="true" />}
          <div><h3>{purpose === "chat" ? "文本对话与工作" : "图片生成"}</h3><strong>{!ready ? "正在读取默认配置…" : profile ? profile.model_name : "尚未选择默认模型"}</strong><small>{profile ? `${connection?.name || "模型服务"}${usable ? " · 后续新任务使用" : " · 当前不可用，请重新选择"}` : "在下方模型列表中选择"}</small></div>
          {usable ? <CheckCircle2 size={16} className="unified-default-check" aria-label="已配置" /> : null}
          <button type="button" aria-label={`${profile ? "更换" : "选择"}${purpose === "chat" ? "文本对话" : "图片生成"}模型`} disabled={loading} onClick={() => { resetFilters(); setCategory(purpose); setServiceId(null); document.querySelector<HTMLInputElement>(".unified-search input")?.focus(); }}>{profile ? "更换" : "选择"}<ArrowRight size={13} aria-hidden="true" /></button>
        </div>;
      })}
    </section> : null}
    {tab === "models" ? (hasServices ? <div className="unified-catalog-layout">
      <aside className="unified-services" aria-label="服务筛选"><button type="button" className="unified-service" aria-label="全部服务" aria-pressed={!serviceId} onClick={() => setServiceId(null)}><Server size={16} /><strong>全部服务</strong><small>{catalog.connections.length}</small></button>{catalog.connections.map(connection => <div className="unified-service-item" key={connection.id}><button type="button" className="unified-service" aria-pressed={serviceId === connection.id} onClick={() => setServiceId(connection.id)}><strong>{connection.name || "模型服务"}</strong><small className="unified-service-address">{connection.model_base_url}</small><small>{connection.enabled ? connection.api_key_configured || connection.model_protocol === "ollama" ? "已保存配置" : "缺少密钥" : "已停用"}</small></button><div className="unified-service-controls"><button type="button" className="unified-service-edit" disabled={locked || editor?.owner === owner} aria-label={`编辑${connection.name || "模型服务"}`} onClick={() => setEditor({ owner, connection })}>编辑</button><button type="button" className="unified-service-delete" disabled={locked || loading || editor?.owner === owner} aria-label={`删除${connection.name || "模型服务"}`} title="删除服务" onClick={() => { setRemoval({ owner, connection }); setNotice(""); }}><Trash2 size={14} aria-hidden="true" /></button></div></div>)}</aside>
      <section className="unified-directory" aria-label="全部模型"><div className="unified-directory-heading"><div><h3>{selectedService?.name || "全部模型"}</h3><p>{selectedService ? selectedService.model_base_url : "来自所有服务的模型，可以跨服务分别选择用途。"}</p></div><div className="unified-actions"><button type="button" disabled={locked || loading || !(selectedService ? selectedService.enabled : catalog.connections.some(item => item.enabled)) || discoveryBusy} onClick={() => void discovery.discover(true, serviceId ?? undefined)}>{discoveryBusy ? "获取中…" : selectedService ? "刷新此服务模型" : "刷新全部服务模型"}</button><button type="button" disabled={locked || !catalog.connections.some(item => item.enabled)} onClick={() => { setManual(value => !value); setManualService(selectedService?.enabled ? selectedService.id : catalog.connections.find(item => item.enabled)?.id ?? ""); }}>手动添加</button></div></div>
        {loading && !catalog.connections.length ? <p role="status">正在读取服务…</p> : null}

        {discovery.catalogs.filter(item => item.error && (!serviceId || serviceId === item.connection_id)).map(item => <p key={item.connection_id} role="alert" className="unified-alert">{item.connection_name}：{item.error}。可检查服务地址、接口协议，或手动添加模型 ID。<button type="button" disabled={locked || item.busy} onClick={() => void discovery.discover(true, item.connection_id)}>重试此服务</button></p>)}
        {manual ? <form className="unified-manual" aria-label="手动添加模型" onSubmit={event => { event.preventDefault(); addManual(); }}><label>所属服务<select aria-label="所属服务" value={manualService} onChange={event => setManualService(event.target.value)}>{catalog.connections.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name || item.model_base_url}</option>)}</select></label><label>模型 ID<input aria-label="模型 ID" value={manualName} maxLength={120} onChange={event => setManualName(event.target.value)} placeholder="保留服务提供的完整 ID" /></label><button type="submit" disabled={locked || !manualName.trim()}>添加模型</button><button type="button" disabled={locked} onClick={() => { setManual(false); setManualName(""); }}>取消添加</button></form> : null}
        {rows.some(row => !serviceId || row.connection.id === serviceId) ? <><div className="unified-tools"><label className="unified-search"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索模型或服务" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="模型状态筛选" value={availability} onChange={event => setAvailability(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></div>
        <div className="unified-filters" aria-label="模型分类">{categories.map(item => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}{hasFilters ? <button type="button" className="unified-reset" onClick={resetFilters}>清除筛选</button> : null}<small>{visible.length} 个模型</small></div></> : null}
        {visible.length ? <div className="unified-table-scroll"><table className="unified-model-table"><thead><tr><th scope="col">模型</th><th scope="col">输出</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{visible.map(row => <ModelRow key={JSON.stringify([row.connection.id, row.name])} row={row} defaults={defaults} locked={locked} ready={ready} advanced={advancedMode} onUse={purpose => useModel(row, purpose)} onInspect={(capabilities, trigger) => inspect(row, capabilities, trigger)} onEditConnection={() => setEditor({ owner, connection: row.connection })} onToggle={() => toggle(row)} />)}</tbody></table></div> : null}
        {!visible.length && hasServices ? <div className="unified-empty">
          <h4>{discoveryBusy ? "正在获取模型…" : hasFilters ? "没有符合条件的模型" : "还没有可选模型"}</h4>
          <p>{discoveryBusy ? "获取完成后，选择模型的默认用途即可开始使用。" : hasFilters ? "试试其他关键词，或清除筛选查看模型。" : "点击上方刷新按钮获取服务的模型列表；也可以手动添加服务商提供的模型 ID。"}</p>
          {hasFilters ? <button type="button" onClick={resetFilters}>清除筛选</button> : null}
        </div> : null}
        <p className="unified-directory-note">获取列表不会调用模型。启用与默认用途分别保存；视频生成暂未接入。</p>
        {advancedMode && selectedService ? <div className="unified-service-advanced"><p>{selectedService.model_base_url} · 连接版本 {selectedService.revision}</p>{archiveId === selectedService.id ? <><span>停用服务后，新任务将无法使用它的模型。</span><button type="button" disabled={locked} onClick={() => void run(async () => { if (await onMutate(`/agent/model-connections/${encodeURIComponent(selectedService.id)}`, "DELETE") && active.current === owner) setArchiveId(null); })}>确认停用</button><button type="button" disabled={locked} onClick={() => setArchiveId(null)}>取消停用</button></> : <button type="button" disabled={locked} onClick={() => selectedService.enabled ? setArchiveId(selectedService.id) : void run(async () => { await onMutate(`/agent/model-connections/${encodeURIComponent(selectedService.id)}`, "PATCH", { enabled: true, expected_revision: selectedService.revision }); })}>{selectedService.enabled ? "停用此服务" : "启用此服务"}</button>}</div> : null}
      </section>
    </div> : null) : <ModelUsageRules catalog={catalog} busy={locked} loading={loading} onMutate={onMutate} onApplied={onApplied} scope={owner} />}
    {inspector?.preview ? <div className="unified-notice"><p>目录预览，不会创建或启用模型。启用后可确认能力和编辑参数。</p><button type="button" disabled={locked || !inspector.preview.connection.enabled || !inspector.preview.connection.api_key_configured && inspector.preview.connection.model_protocol !== "ollama"} onClick={activatePreview}>启用并编辑参数</button></div> : null}
    {inspectedProfile ? <UnifiedModelInspector key={inspectedProfile.id} profile={inspectedProfile} connection={catalog.connections.find(item => item.id === inspectedProfile.connection_id)} fetchJson={fetchJson} busy={locked} error={error} onMutate={onMutate} openCapabilities={inspector?.capabilities} readOnly={Boolean(inspector?.preview) || !catalog.connections.find(item => item.id === inspectedProfile.connection_id)?.enabled} onDirtyChange={setInspectorDirty} onSavingChange={setInspectorSaving} onClose={closeInspector} /> : null}
    {advancedMode && advanced ? <div className="unified-advanced-content">{advanced}</div> : null}
  </div>;
}

function ModelRow({ row, defaults, locked, ready, advanced, onUse, onInspect, onEditConnection, onToggle }: {
  row: Row; defaults: ModelCatalog["purpose_defaults"]; locked: boolean; ready: boolean; advanced: boolean;
  onUse: (purpose: "chat" | "image") => void; onInspect: (capabilities?: boolean, trigger?: HTMLElement) => void; onEditConnection: () => void; onToggle: () => void;
}) {
  const protocol = row.connection.detected_protocol || row.connection.model_protocol;
  const callable = (purpose: "chat" | "image") => row.profile?.supported_purposes ? row.profile.supported_purposes.includes(purpose) : discoveredPurposeAvailable(row, purpose);
  const configured = row.connection.enabled && (row.connection.api_key_configured || protocol === "ollama");
  const isCurrent = (purpose: "chat" | "image") => Boolean(row.profile?.enabled && defaults?.[purpose] === row.profile.id);
  const displayName = row.entry?.display_name || row.name;
  const noPurpose = !callable("chat") && !callable("image");
  const needsCapabilities = !row.types.length;
  const explanation = !row.connection.enabled ? "服务已停用，请编辑服务后启用。" : !configured ? "请先编辑服务，配置可用密钥。" : needsCapabilities ? "输出能力待确认，确认后才能选择默认用途。" : noPurpose && !row.types.includes("video") ? "已识别输出类型，但当前接口尚未接入此用途；确认能力不会新增接口。" : "";
  return <tr>
    <td><strong>{displayName}</strong>{displayName !== row.name ? <small>{row.name}</small> : null}<small>{row.connection.name || "模型服务"}</small>{explanation ? <small>{explanation}</small> : null}</td>
    <td>{row.types.length ? row.types.map(type => <span className="unified-type" key={type}>{({ chat: "文本", image: "图片", video: "视频" })[type]}</span>) : <span className="unified-muted">待确认</span>}{advanced ? <small>{row.profile?.output_types_source === "configured" ? "手动配置" : row.entry?.output_types_source === "provider" ? "服务声明" : row.types.length ? "自动识别" : "能力待确认"}</small> : null}</td>
    <td><span className="unified-muted">{!row.connection.enabled ? "服务已停用" : !configured ? "缺少密钥" : row.types.includes("video") ? "视频暂未接入" : row.profile?.enabled ? "已启用" : "未启用"}</span>{defaults?.chat === row.profile?.id && row.profile ? <small className="unified-default">文本默认</small> : null}{defaults?.image === row.profile?.id && row.profile ? <small className="unified-default">图片默认</small> : null}</td>
    <td><div className="unified-row-actions">
      {(["chat", "image"] as const).filter(callable).map(purpose => <button type="button" key={purpose} className="unified-use" disabled={locked || !configured || !ready || isCurrent(purpose)} onClick={() => onUse(purpose)}>{isCurrent(purpose) ? purpose === "chat" ? "文本使用中" : "图片使用中" : purpose === "chat" ? "设为文本默认" : "设为图片默认"}</button>)}
      <button type="button" disabled={locked} onClick={event => onInspect(false, event.currentTarget)}>参数</button>
       {configured && needsCapabilities ? <button type="button" disabled={locked} onClick={event => onInspect(true, event.currentTarget)}>确认输出能力</button> : null}
       {explanation && !needsCapabilities ? <button type="button" disabled={locked} onClick={onEditConnection}>编辑服务接口</button> : null}
       {!configured && needsCapabilities ? <button type="button" disabled={locked} onClick={onEditConnection}>编辑服务</button> : null}
      {advanced || row.profile?.enabled === false ? <button type="button" role="switch" aria-checked={Boolean(row.profile?.enabled)} aria-label={`${row.connection.name} ${row.name} 启用`} disabled={locked || !configured} onClick={onToggle}>{row.profile?.enabled ? "停用" : "启用"}</button> : null}
    </div></td>
  </tr>;
}

/** Conservative affordances before ensure returns the authoritative saved purposes. */
function discoveredPurposeAvailable(row: Row, purpose: "chat" | "image") {
  if (!row.types.includes(purpose)) return false;
  const configured = row.connection.model_protocol;
  const base = row.connection.model_base_url.toLowerCase();
  const name = row.name.trim().toLowerCase();
  const compatible = ["auto", "openai", "images", "responses"].includes(configured);
  const nativeAuto = configured === "auto" && /anthropic\.com|generativelanguage\.googleapis\.com|ollama|:11434/.test(base);
  const trustedImageOnly = row.entry?.output_types_source === "provider" || row.profile?.capabilities?.image_generation === "supported" && row.profile.capabilities.chat === "unsupported";
  const imageAdapter = configured === "images" || compatible && name.startsWith("gpt-image-") || compatible && !nativeAuto && trustedImageOnly && row.types.length === 1 && row.types[0] === "image";
  if (purpose === "chat") return !imageAdapter;
  return imageAdapter || !nativeAuto && ["auto", "responses"].includes(configured) && /^grok-4\.7(?:[-.]|$)/.test(name);
}
