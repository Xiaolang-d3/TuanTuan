import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Eye, Image, MessageCircle, Plus, RefreshCw, Search, Server, SlidersHorizontal, Video } from "lucide-react";
import type { createApiClient } from "../../api/client";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from "../../components/ui/combobox";
import type { ModelCatalog, ModelCatalogEntry, ModelConnection, ModelProfile } from "../../types";
import { useComposerModelDiscovery } from "../chat/useComposerModelDiscovery";
import { inferredOutputTypes, type ModelCategory } from "../chat/model-categories";
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
  additionalConnectionActions?: ReactNode;
};
type Row = { connection: ModelConnection; name: string; profile?: ModelProfile; entry?: ModelCatalogEntry; types: ModelCategory[] };
const defaultPurposes = {
  chat: { title: "主模型", actionName: "文本对话模型", description: "用于日常对话和工作任务", icon: MessageCircle, badge: "文本默认", empty: "没有可用的文本模型" },
  vision: { title: "图像理解", actionName: "图像理解模型", description: "用于聊天中的「模型看图」", icon: Eye, badge: "图像理解默认", empty: "没有可用的图像理解模型" },
  image: { title: "图片生成", actionName: "图片生成模型", description: "用于生成和编辑图片", icon: Image, badge: "图片默认", empty: "没有可用的图片模型" }
} as const;
type DefaultPurpose = keyof typeof defaultPurposes;
const purposeOrder = ["chat", "vision", "image"] as const;
const pickerPageSize = 8;
const narrowModelSettings = "(max-width: 600px)";
const categories = [{ id: "all", label: "全部" }, { id: "chat", label: "文本" }, { id: "image", label: "图片" }, { id: "video", label: "视频" }, { id: "unknown", label: "待确认" }];
const modelKey = (row: Row) => JSON.stringify([row.connection.id, row.name]);
const modelDisplayName = (row: Row) => row.entry?.display_name || row.name;
const normalizedAddress = (value: string) => value.trim().replace(/\/+$/, "");
type ModelServiceOption = { id: string | null; label: string };
const allServices: ModelServiceOption = { id: null, label: "全部服务" };

export function UnifiedModelManager({ catalog, loading, busy, error, secretWritable, fetchJson, onReload, onMutate, onEnsureProfile, onApplied, advanced, additionalConnectionActions }: UnifiedModelManagerProps) {
  const owner = useMemo(() => ({ active: true }), [fetchJson]);
  const active = useRef(owner); active.current = owner;
  const latestCatalog = useRef(catalog); latestCatalog.current = catalog;
  const [tab, setTab] = useState<"overview" | "models" | "services">("overview");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [managedModelKey, setManagedModelKey] = useState<string | null>(null);
  const pickerId = useId();
  const [pickerPurpose, setPickerPurpose] = useState<DefaultPurpose | null>(null);
  const [pickerError, setPickerError] = useState("");
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const focusPickerSearch = useRef(true);
  const restorePickerFocus = useRef(false);
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
  const discovery = useComposerModelDiscovery({ fetchJson, scope: owner, connections: catalog.connections.filter(item => !isSubscriptionConnection(item) || connectionAvailable(item)) });
  const manualConnections = catalog.connections.filter(item => item.enabled && !isSubscriptionConnection(item));
  const locked = busy || working || inspectorSaving;
  useEffect(() => {
    owner.active = true;
    pickerTrigger.current = null;
    restorePickerFocus.current = false;
    setPickerPurpose(null); setPickerError(""); setManagedModelKey(null);
    setTab("overview"); setServiceId(null); setEditor(null); setInspector(null); setPendingConnection(null); setManual(false); setRemoval(null);
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

  useEffect(() => {
    if (tab !== "overview" || pickerPurpose || locked || loading || !restorePickerFocus.current) return;
    restorePickerFocus.current = false;
    pickerTrigger.current?.focus();
  }, [tab, pickerPurpose, locked, loading]);

  const rows: Row[] = [];
  for (const connection of tab === "models" ? catalog.connections : []) {
    const saved = new Map<string, ModelProfile>();
    for (const profile of catalog.profiles.filter(item => item.connection_id === connection.id)) {
      const previous = saved.get(profile.model_name);
      if (!previous || (!previous.enabled && profile.enabled) || purposeOrder.some(purpose => profile.id === catalog.purpose_defaults?.[purpose])) saved.set(profile.model_name, profile);
    }
    const source = discovery.catalogs.find(item => item.connection_id === connection.id);
    for (const name of new Set([...saved.keys(), ...(source?.models ?? [])])) {
      const profile = saved.get(name);
      const entry = source?.entries?.find(item => item.id === name) ?? profile?.discovery ?? undefined;
      rows.push({ connection, name, profile, entry, types: profile?.output_types ?? entry?.output_types ?? inferredOutputTypes(name, connection.detected_protocol || connection.model_protocol, profile?.capabilities) });
    }
  }
  const visible = rows.filter(row => (!serviceId || row.connection.id === serviceId) && `${row.name} ${row.entry?.display_name ?? ""} ${row.connection.name}`.toLowerCase().includes(query.trim().toLowerCase()) && (category === "all" || (category === "unknown" ? !row.types.length : row.types.includes(category as ModelCategory))) && (availability === "all" || (availability === "enabled" ? row.profile?.enabled && row.connection.enabled : !row.profile?.enabled || !row.connection.enabled)))
    .sort((first, second) => Number(Boolean(second.profile?.enabled && connectionAvailable(second.connection))) - Number(Boolean(first.profile?.enabled && connectionAvailable(first.connection))));
  const managedModel = advancedMode && managedModelKey ? rows.find(row => modelKey(row) === managedModelKey) : undefined;
  const hasServices = catalog.connections.length > 0;
  const showsModelSetup = tab === "overview" || tab === "models";
  const hasFilters = Boolean(query.trim() || category !== "all" || availability !== "all");
  function resetFilters() { setQuery(""); setCategory("all"); setAvailability("all"); }
  function changeTab(next: typeof tab, after?: () => void) {
    if (next === tab && !after) return;
    protectInspector(() => {
      setInspector(null);
      setInspectorDirty(false);
      setNotice("");
      restorePickerFocus.current = false;
      pickerTrigger.current = null;
      setPickerPurpose(null);
      setPickerError("");
      setManagedModelKey(null);
      setTab(next);
      after?.();
    });
  }
  function addService() {
    changeTab("services", () => setEditor({ owner }));
  }
  const selectedService = catalog.connections.find(item => item.id === serviceId);
  const serviceOptions = useMemo(() => [allServices, ...catalog.connections.map(connection => ({
    id: connection.id, label: connection.name || connection.model_base_url
  }))], [catalog.connections]);
  const selectedServiceOption = serviceOptions.find(option => option.id === serviceId) ?? allServices;
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
  const removalProtected = removalProfiles.some(item => item.id === catalog.default_profile_id || purposeOrder.some(purpose => item.id === defaults?.[purpose]));
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
  function closePicker() {
    restorePickerFocus.current = Boolean(pickerTrigger.current);
    setPickerPurpose(null);
    setPickerError("");
  }
  function useModel(row: Row | null, purpose: DefaultPurpose, fromPicker = false) {
    if (row && !connectionAvailable(row.connection)) return;
    if (!ready) { setNotice("默认用途尚未读取，请重新读取配置后再选择。"); return; }
    const version = defaultVersion;
    void run(async () => {
      if (fromPicker) setPickerError("");
      const id = row ? await ensure(row) : null;
      if ((row && !id) || active.current !== owner || !owner.active) return;
      if (row) {
        const latestConnection = latestCatalog.current.connections.find(item => item.id === row.connection.id);
        if (!latestConnection || !connectionAvailable(latestConnection) || latestConnection.revision !== row.connection.revision) {
          const message = "服务配置已更新，请重新读取后再选择。";
          if (fromPicker) setPickerError(message);
          else setNotice(message);
          return;
        }
      }
      let saved: boolean;
      try {
        saved = await onMutate(`/agent/model-defaults/${purpose}`, "POST", { profile_id: id, expected_version: version });
      } catch (error) {
        if (!fromPicker) throw error;
        if (active.current === owner && owner.active) setPickerError("未能确认保存结果，请重试或重新读取配置。");
        return;
      }
      if (active.current !== owner || !owner.active) return;
      if (!saved) {
        if (fromPicker) setPickerError("保存未完成，请重试。");
        return;
      }
      if (fromPicker) closePicker();
      setNotice(row ? `已用于${defaultPurposes[purpose].title}，从后续新任务生效。` : `${defaultPurposes[purpose].title}已设为自动选择，从后续新任务生效。`);
      try { await onApplied(); } catch { if (active.current === owner) setNotice("默认模型已保存，摘要未刷新，请重新读取配置核对。"); }
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
    if (!row || !connectionAvailable(row.connection)) return;
    void run(async () => {
      const id = await ensure(row);
      if (id && active.current === owner) { setInspector({ owner, id, capabilities: inspector.capabilities, trigger: inspector.trigger }); setNotice("模型已启用，可编辑参数；尚未设为默认。"); }
    });
  }
  function addManual() {
    const connection = manualConnections.find(item => item.id === manualService);
    if (!connection || !manualName.trim()) return;
    protectInspector(() => {
      setInspector(null); setInspectorDirty(false);
      void run(async () => { const id = await onEnsureProfile(connection.id, manualName.trim(), connection.revision); if (id && active.current === owner) { setManual(false); setManualName(""); setInspector({ owner, id, capabilities: true }); setNotice("模型已添加，可在下方确认输出能力后选择默认用途。"); } });
    });
  }

  return <div className="unified-model-manager model-connections-card">
    <header className="unified-heading">
      <h2>模型管理</h2>
      {(hasServices || loading || !showsModelSetup) && <button type="button" className="unified-primary" disabled={locked || loading || editor?.owner === owner} onClick={addService}><Plus size={16} aria-hidden="true" />添加服务</button>}
    </header>
    <nav className="unified-tabs" aria-label="模型管理内容">
      <button type="button" aria-pressed={tab === "services"} disabled={Boolean(editor || removing)} onClick={() => changeTab("services")}>基础配置</button>
      <button type="button" aria-pressed={tab !== "services"} disabled={Boolean(editor || removing)} onClick={() => { if (tab === "services") changeTab("overview"); }}>模型配置</button>
    </nav>
    <div className="unified-subnav">
      {tab !== "services" && <nav aria-label="模型配置内容">
        <button type="button" aria-pressed={tab === "overview"} onClick={() => changeTab("overview")}>场景默认模型</button>
        <button type="button" aria-pressed={tab === "models"} onClick={() => changeTab("models")}>模型列表</button>
      </nav>}
      <button type="button" className="unified-advanced-toggle" aria-expanded={advancedMode} onClick={() => {
        if (!advancedMode) { setAdvancedMode(true); return; }
        protectInspector(() => {
          if (inspector?.trigger) { setInspector(null); setInspectorDirty(false); }
          setManagedModelKey(null);
          setAdvancedMode(false);
        });
      }}><SlidersHorizontal size={14} aria-hidden="true" />{advancedMode ? "收起高级" : "高级设置"}</button>
    </div>
    {error ? <div role="alert" className="unified-alert">{error}<button type="button" disabled={locked || loading} onClick={() => void onReload()}>重新读取</button></div> : null}
    {notice ? <p className="unified-notice" role="status">{notice}</p> : null}
    {pendingInspectorAction ? <div className="unified-discard" role="alert"><p>参数有未保存的修改。可继续编辑并保存，或放弃后继续。</p><button type="button" onClick={() => { setPendingInspectorAction(null); document.querySelector<HTMLElement>(".unified-inspector")?.focus(); }}>继续编辑</button><button type="button" disabled={locked} onClick={() => { if (locked) return; const action = pendingInspectorAction; setPendingInspectorAction(null); setInspectorDirty(false); action(); }}>放弃参数修改并继续</button></div> : null}
    {removing ? <section className="unified-removal" aria-label="删除服务"><h3>删除“{removing.name || "模型服务"}”？</h3><p>{removing.model_base_url}</p><p>此服务及 {removalProfiles.length} 个已保存模型将从列表中移除，历史对话记录保留。需要再次使用时可重新添加服务。</p>{removalProtected ? <p role="alert">此服务包含当前默认模型，请先切换或清除相关场景的默认模型，再删除服务。</p> : null}{removalOutdated ? <p role="alert">服务配置已更新，请取消后重新选择要删除的服务。</p> : null}<div className="unified-actions"><button type="button" className="unified-danger" disabled={locked || loading || removalProtected || removalOutdated} onClick={() => protectInspector(() => { setInspector(null); setInspectorDirty(false); void run(async () => {
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
        setEditor(null);
        if (!editor.connection) { resetFilters(); setTab("models"); }
        setNotice("服务已保存，正在获取模型列表。");
        setPendingConnection({ owner, ids, address: normalizedAddress(String(body.model_base_url)), id: editor.connection?.id, revision: editor.connection?.revision });
      }
      return success;
    }} /> : null}
    {showsModelSetup && loading && !hasServices ? <p className="unified-loading" role="status"><RefreshCw size={16} className="spinning" aria-hidden="true" />正在读取服务与模型配置…</p> : null}
    {showsModelSetup && !hasServices && !loading && editor?.owner !== owner ? <section className="unified-onboarding" aria-labelledby="unified-start-title">
      <Server size={28} aria-hidden="true" />
      <h3 id="unified-start-title">连接模型服务，开始使用</h3>
      <p>准备好服务商提供的 API 地址和密钥，团团会自动获取可选模型。</p>
      <button type="button" className="unified-primary" disabled={locked} onClick={addService}>连接第一个服务<ArrowRight size={16} aria-hidden="true" /></button>
    </section> : null}
    {tab === "overview" && hasServices ? <section className="unified-defaults" aria-label="当前默认模型">
      {purposeOrder.map(purpose => {
        const defaultId = defaults?.[purpose];
        const profile = catalog.profiles.find(item => item.id === defaultId);
        const connection = catalog.connections.find(item => item.id === profile?.connection_id);
        const usable = profile?.enabled && connection && connectionAvailable(connection) && (profile.supported_purposes?.includes(purpose) ?? true);
        const purposeInfo = defaultPurposes[purpose];
        const PurposeIcon = purposeInfo.icon;
        const purposeReady = ready && (purpose !== "vision" || defaults?.vision !== undefined);
        const expanded = pickerPurpose === purpose;
        return <div className="unified-default-item" key={purpose}>
          <div className="unified-default-summary">
            <PurposeIcon size={18} aria-hidden="true" />
            <div>
              <h3>{purposeInfo.title}</h3>
              <strong>{!purposeReady ? loading ? "正在读取默认配置…" : "当前服务端暂未提供配置" : profile ? profile.discovery?.display_name || profile.model_name : defaultId ? "原模型已不可用" : "自动选择"}</strong>
              <small>{purposeInfo.description}</small>
              {purposeReady && (profile || defaultId) && <small>{profile ? `${connection?.name || "模型服务"}${usable ? " · 后续新任务使用" : " · 当前不可用，请重新选择"}` : "请选择其他模型或设为自动选择"}</small>}
            </div>
            {purposeReady && <button type="button" aria-label={`${defaultId ? "更换" : "选择"}${purposeInfo.actionName}`} aria-expanded={expanded} aria-controls={expanded ? `${pickerId}-${purpose}` : undefined} disabled={locked || loading || editor?.owner === owner} onClick={event => {
              if (expanded) { closePicker(); return; }
              pickerTrigger.current = event.currentTarget;
              focusPickerSearch.current = event.detail === 0 || !window.matchMedia?.(narrowModelSettings).matches;
              restorePickerFocus.current = false;
              setPickerError("");
              setPickerPurpose(purpose);
            }}>{defaultId ? "更换" : "选择"}<ArrowRight size={13} aria-hidden="true" /></button>}
          </div>
          {expanded && <DefaultModelPicker id={`${pickerId}-${purpose}`} purpose={purpose} currentId={defaults?.[purpose]} catalog={catalog} locked={locked || loading || !purposeReady} error={pickerError} focusSearch={focusPickerSearch.current} onCancel={closePicker} onSave={row => useModel(row, purpose, true)} onConnect={addService} onManage={() => { resetFilters(); setCategory(purpose === "vision" ? "chat" : purpose); setServiceId(null); setAdvancedMode(true); changeTab("models"); }} />}
        </div>;
      })}
      <div className="unified-default-item unified-default-summary">
        <Video size={18} aria-hidden="true" />
        <div><h3>视频生成</h3><strong>暂未接入</strong><small>接入视频生成服务后可设置默认模型。</small></div>
      </div>
    </section> : null}
    {tab === "models" && hasServices && (
      <section className="unified-directory" aria-label="全部模型">
        <div className="unified-directory-heading">
          <h3>全部模型</h3>
          <div className="unified-actions">
            <button type="button" disabled={locked || loading || !discovery.catalogs.some(item => !serviceId || item.connection_id === serviceId) || discoveryBusy} onClick={() => void discovery.discover(true, serviceId ?? undefined)}>{discoveryBusy ? "获取中…" : selectedService ? "刷新此服务模型" : "刷新全部服务模型"}</button>
            <button type="button" aria-expanded={manual} disabled={locked || !manualConnections.length || Boolean(selectedService && isSubscriptionConnection(selectedService))} onClick={() => { setManual(value => !value); setManualService(manualConnections.find(item => item.id === serviceId)?.id ?? manualConnections[0]?.id ?? ""); }}>手动添加</button>
          </div>
        </div>
        <div className="unified-tools">
          <label className="unified-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <Combobox items={serviceOptions} value={selectedServiceOption} onValueChange={(option) => setServiceId(option?.id ?? null)} itemToStringLabel={(option) => option.label}>
            <ComboboxTrigger className="unified-service-filter" aria-label="按服务筛选">
              <span className="unified-service-filter-label"><ComboboxValue /></span>
            </ComboboxTrigger>
            <ComboboxContent className="unified-service-filter-popup" aria-label="按服务筛选">
              <ComboboxInput aria-label="搜索服务" placeholder="搜索服务" />
              <ComboboxEmpty>没有匹配的服务</ComboboxEmpty>
              <ComboboxList>
                {(option: ModelServiceOption) => <ComboboxItem key={option.id} value={option}><span>{option.label}</span></ComboboxItem>}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>筛选<ChevronDown size={14} aria-hidden="true" /></button>
        </div>
        {filtersOpen && <div className="unified-filter-options">
          <label>输出类型<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>启用状态<select value={availability} onChange={event => setAvailability(event.target.value)}><option value="all">全部</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></label>
        </div>}
        {hasFilters && <div className="unified-filter-summary"><span>{category !== "all" && `${categories.find(item => item.id === category)?.label} · `}{availability !== "all" && `${availability === "enabled" ? "已启用" : "未启用"} · `}{visible.length} 个结果</span><button type="button" className="unified-reset" onClick={resetFilters}>清除筛选</button></div>}
        {discovery.catalogs.filter(item => item.error && (!serviceId || serviceId === item.connection_id)).map(item => <p key={item.connection_id} role="alert" className="unified-alert">{item.connection_name}：{item.error}。可检查服务地址、接口协议，或手动添加模型 ID。<button type="button" disabled={locked || item.busy} onClick={() => void discovery.discover(true, item.connection_id)}>重试此服务</button></p>)}
        {manual ? <form className="unified-manual" aria-label="手动添加模型" onSubmit={event => { event.preventDefault(); addManual(); }}><label>所属服务<select aria-label="所属服务" value={manualService} onChange={event => setManualService(event.target.value)}>{manualConnections.map(item => <option key={item.id} value={item.id}>{item.name || item.model_base_url}</option>)}</select></label><label>模型 ID<input aria-label="模型 ID" value={manualName} maxLength={120} onChange={event => setManualName(event.target.value)} placeholder="保留服务提供的完整 ID" /></label><button type="submit" disabled={locked || !manualName.trim()}>添加模型</button><button type="button" disabled={locked} onClick={() => { setManual(false); setManualName(""); }}>取消添加</button></form> : null}
        {visible.length > 0 && <ul className="unified-model-list" role="list" aria-label="模型目录">
          {visible.map(row => <li key={modelKey(row)}>{modelDisplayName(row)}</li>)}
        </ul>}
        {!visible.length && hasServices ? <div className="unified-empty">
          <h4>{discoveryBusy ? "正在获取模型…" : hasFilters ? "没有符合条件的模型" : "还没有可选模型"}</h4>
          <p>{discoveryBusy ? "获取完成后，选择模型的默认用途即可开始使用。" : hasFilters ? "试试其他关键词，或清除筛选查看模型。" : "刷新模型列表，或手动添加服务商提供的模型 ID。"}</p>
        </div> : null}
      </section>
    )}
    {additionalConnectionActions && <div hidden={tab !== "services"}>{additionalConnectionActions}</div>}
    {tab === "services" && <section className="unified-services" aria-label="已连接服务">
      {loading && !hasServices ? <p role="status">正在读取服务…</p> : null}
      {!loading && !hasServices && editor?.owner !== owner ? <p className="unified-empty">还没有连接服务。添加服务后即可获取模型。</p> : null}
      {catalog.connections.map(connection => <article className="unified-service-item" key={connection.id}>
        <div className="unified-service-copy">
          <h3>{connection.name || "模型服务"}</h3>
          {isSubscriptionConnection(connection) ? <small>{connectionAvailable(connection) ? "当前 ChatGPT 订阅可用" : "当前不可用，请在 ChatGPT 订阅登录中管理账号"}</small> : <>
            <p>{connection.model_base_url}</p>
            <small>{connection.enabled ? connection.api_key_configured ? "API Key 已配置" : isOllamaConnection(connection) ? "本地服务，无需 API Key" : "缺少 API Key" : "已停用"}</small>
          </>}
        </div>
        <div className="unified-actions">
          <button type="button" onClick={() => { resetFilters(); setServiceId(connection.id); changeTab("models"); }}>查看模型</button>
          {!isSubscriptionConnection(connection) && <>
            <button type="button" disabled={locked || editor?.owner === owner} aria-label={`编辑${connection.name || "模型服务"}`} onClick={() => setEditor({ owner, connection })}>编辑</button>
            <button type="button" className="unified-danger" disabled={locked || loading || editor?.owner === owner} aria-label={`删除${connection.name || "模型服务"}`} onClick={() => { setRemoval({ owner, connection }); setNotice(""); }}>删除</button>
          </>}
        </div>
        {advancedMode && !isSubscriptionConnection(connection) && <div className="unified-service-advanced">
          <p>连接版本 {connection.revision}</p>
          {archiveId === connection.id ? <div className="unified-actions">
            <span>停用后，新任务将无法使用此服务的模型。</span>
            <button type="button" disabled={locked} onClick={() => void run(async () => { if (await onMutate(`/agent/model-connections/${encodeURIComponent(connection.id)}`, "DELETE") && active.current === owner) setArchiveId(null); })}>确认停用</button>
            <button type="button" disabled={locked} onClick={() => setArchiveId(null)}>取消停用</button>
          </div> : <button type="button" disabled={locked} onClick={() => connection.enabled ? setArchiveId(connection.id) : void run(async () => { await onMutate(`/agent/model-connections/${encodeURIComponent(connection.id)}`, "PATCH", { enabled: true, expected_revision: connection.revision }); })}>{connection.enabled ? "停用此服务" : "启用此服务"}</button>}
        </div>}
      </article>)}
    </section>}
    {advancedMode && tab === "models" && (visible.length > 0 || managedModel) && <section className="unified-model-management" aria-label="管理单个模型">
      <label>管理单个模型
        <select value={managedModel ? modelKey(managedModel) : ""} disabled={locked} onChange={event => {
          const key = event.target.value;
          protectInspector(() => {
            setInspector(null);
            setInspectorDirty(false);
            setManagedModelKey(key || null);
          });
        }}>
          <option value="">选择要管理的模型</option>
          {managedModel && !visible.includes(managedModel) && <option value={modelKey(managedModel)}>{modelOptionName(managedModel)}</option>}
          {visible.map(row => <option key={modelKey(row)} value={modelKey(row)}>{modelOptionName(row)}</option>)}
        </select>
      </label>
      {managedModel && <ManagedModelActions row={managedModel} defaults={defaults} locked={locked} ready={ready}
        onUse={purpose => useModel(managedModel, purpose)} onInspect={(capabilities, trigger) => inspect(managedModel, capabilities, trigger)}
        onEditConnection={() => setEditor({ owner, connection: managedModel.connection })} connectionEditorOpen={editor?.owner === owner}
        onToggle={() => toggle(managedModel)} />}
    </section>}
    {inspector?.preview ? <div className="unified-notice"><p>目录预览，不会创建或启用模型。启用后可确认能力和编辑参数。</p><button type="button" disabled={locked || !connectionAvailable(inspector.preview.connection)} onClick={activatePreview}>启用并编辑参数</button></div> : null}
    {inspectedProfile ? <UnifiedModelInspector key={inspectedProfile.id} profile={inspectedProfile} connection={catalog.connections.find(item => item.id === inspectedProfile.connection_id)} fetchJson={fetchJson} busy={locked} error={error} onMutate={onMutate} openCapabilities={inspector?.capabilities} readOnly={Boolean(inspector?.preview) || !catalog.connections.find(item => item.id === inspectedProfile.connection_id)?.enabled} onDirtyChange={setInspectorDirty} onSavingChange={setInspectorSaving} onClose={closeInspector} onVisionChanged={onReload} /> : null}
    {advancedMode && tab !== "services" && advanced ? <div className="unified-advanced-content">{advanced}</div> : null}
  </div>;
}

function isOllamaConnection(connection: ModelConnection) {
  const protocol = connection.detected_protocol || connection.model_protocol;
  return protocol === "ollama" || (protocol === "auto" && /ollama|:11434/i.test(connection.model_base_url));
}

function isSubscriptionConnection(connection: ModelConnection) {
  return connection.auth_kind === "chatgpt_subscription";
}

function connectionAvailable(connection: ModelConnection) {
  return connection.enabled && (isSubscriptionConnection(connection) ? connection.credential_status === "available" : connection.api_key_configured || isOllamaConnection(connection));
}

function purposeAvailable(row: Row, purpose: DefaultPurpose) {
  if (isSubscriptionConnection(row.connection) && purpose !== "chat") return false;
  if (purpose === "vision") return row.profile?.supported_purposes?.includes(purpose) ?? false;
  return row.profile?.supported_purposes?.includes(purpose) ?? discoveredPurposeAvailable(row, purpose);
}

function DefaultModelPicker({ id, purpose, currentId, catalog, locked, error, focusSearch, onCancel, onSave, onConnect, onManage }: {
  id: string;
  purpose: DefaultPurpose;
  currentId: string | null | undefined;
  catalog: ModelCatalog;
  locked: boolean;
  error: string;
  focusSearch: boolean;
  onCancel: () => void;
  onSave: (row: Row | null) => void;
  onConnect: () => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pickerPageSize);
  const [selection, setSelection] = useState(currentId ?? null);
  const search = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusSearch) (search.current ?? cancel.current)?.focus();
    else panel.current?.focus({ preventScroll: true });
  }, [focusSearch]);

  const candidates = useMemo(() => {
    const connections = new Map(catalog.connections.filter(connectionAvailable).map(item => [item.id, item]));
    const rows = [];
    for (const profile of catalog.profiles) {
      const connection = connections.get(profile.connection_id);
      if (!profile.enabled || !connection) continue;
      const row = {
        connection,
        profile,
        name: profile.model_name,
        entry: profile.discovery ?? undefined,
        types: profile.output_types ?? profile.discovery?.output_types ?? inferredOutputTypes(profile.model_name, connection.detected_protocol || connection.model_protocol, profile.capabilities)
      };
      if (purposeAvailable(row, purpose)) rows.push(row);
    }
    return rows.sort((first, second) => Number(second.profile.id === currentId) - Number(first.profile.id === currentId));
  }, [catalog.connections, catalog.profiles, currentId, purpose]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = candidates.filter(row => {
    const searchable = `${row.name} ${row.entry?.display_name ?? ""} ${row.connection.name || row.connection.model_base_url}`.toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const selected = candidates.find(row => row.profile.id === selection);
  const changed = (selection === null || Boolean(selected)) && selection !== (currentId ?? null);
  const canSave = changed && !locked;
  const label = `选择${defaultPurposes[purpose].actionName}`;

  return <section ref={panel} id={id} className="unified-default-picker" aria-label={label} tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape" && !locked) { event.stopPropagation(); onCancel(); }
  }}>
    {candidates.length > 0 && <label className="unified-search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label="搜索可用模型" placeholder="搜索模型名称、ID 或服务" value={query} disabled={locked} onChange={event => { setQuery(event.target.value); setLimit(pickerPageSize); }} /></label>}
    <div role="group" aria-label="默认模型选项" className="unified-picker-choices">
      <label className="unified-picker-option">
        <input type="radio" name={id} checked={selection === null} disabled={locked} onChange={() => setSelection(null)} />
        <span className="unified-picker-label"><strong>自动选择</strong><small>由团团从已启用的可用模型中选择</small></span>
        {!currentId && <small className="unified-type">当前默认</small>}
      </label>
      {results.length > 0 && <div className="unified-picker-options">
        {results.slice(0, limit).map(row => <label className="unified-picker-option" key={row.profile.id}>
          <input type="radio" name={id} checked={selection === row.profile.id} disabled={locked} onChange={() => setSelection(row.profile.id)} />
          <span className="unified-picker-label"><strong>{row.entry?.display_name || row.name}</strong><small>{row.connection.name || row.connection.model_base_url}{row.entry?.display_name && row.entry.display_name !== row.name ? ` · ${row.name}` : ""}</small></span>
          {currentId === row.profile.id && <small className="unified-type">当前默认</small>}
        </label>)}
      </div>}
    </div>
    {candidates.length > 0 && !results.length && <p role="status">没有匹配的模型，试试其他关键词。</p>}
    {results.length > limit && <button type="button" disabled={locked} onClick={() => setLimit(value => value + pickerPageSize)}>显示更多（共 {results.length} 个）</button>}
    {changed && selected && !results.slice(0, limit).includes(selected) && <p>已选 {selected.entry?.display_name || selected.name} · {selected.connection.name || selected.connection.model_base_url}</p>}
    {!candidates.length && <>
      <p>{defaultPurposes[purpose].empty}。</p>
      {purpose === "vision" && <p>请在模型列表中确认图片输入能力，并选择未设置文本上下文限制的档案。</p>}
      <div className="unified-actions"><button type="button" disabled={locked} onClick={onConnect}>连接模型服务</button><button type="button" disabled={locked} onClick={onManage}>前往模型列表</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="unified-actions unified-picker-actions">
      <button ref={cancel} type="button" disabled={locked} onClick={onCancel}>取消</button>
      {(candidates.length > 0 || currentId) && <button type="button" className="unified-primary" aria-disabled={!canSave} disabled={!changed} onClick={() => { if (canSave) onSave(selected ?? null); }}>{locked && changed ? "保存中…" : selection === null ? "设为自动选择" : "设为默认"}</button>}
    </div>
  </section>;
}

function modelOptionName(row: Row) {
  const name = modelDisplayName(row);
  const service = row.connection.name || row.connection.model_base_url;
  return `${name} · ${service}${name !== row.name ? ` · ${row.name}` : ""}`;
}

function ManagedModelActions({ row, defaults, locked, ready, onUse, onInspect, onEditConnection, connectionEditorOpen, onToggle }: {
  row: Row; defaults: ModelCatalog["purpose_defaults"]; locked: boolean; ready: boolean;
  onUse: (purpose: DefaultPurpose) => void;
  onInspect: (capabilities: boolean, trigger: HTMLElement) => void; onEditConnection: () => void;
  connectionEditorOpen: boolean; onToggle: () => void;
}) {
  const configured = connectionAvailable(row.connection);
  const enabled = Boolean(row.profile?.enabled);
  const isCurrent = (purpose: DefaultPurpose) => Boolean(row.profile && defaults?.[purpose] === row.profile.id);
  const purposes = purposeOrder.filter(purpose => (purpose !== "vision" || defaults?.vision !== undefined) && purposeAvailable(row, purpose));
  const needsCapabilities = !row.types.length;
  const subscription = isSubscriptionConnection(row.connection);
  const explanation = !configured && subscription ? "请在基础配置中管理 ChatGPT 订阅登录。" : !row.connection.enabled ? "服务已停用，请编辑服务后启用。" : !configured ? "请先编辑服务，配置可用密钥。" : needsCapabilities ? "输出能力待确认，确认后才能选择默认用途。" : !purposes.length && !row.types.includes("video") ? "已识别输出类型，但当前接口尚未接入此用途；确认能力不会新增接口。" : "";

  return <div className="unified-managed-model" role="group" aria-label={`${modelDisplayName(row)}的详情`}>
    <div className="unified-row-meta">
      {row.types.map(type => <span className="unified-type" key={type}>{({ chat: "文本", image: "图片", video: "视频" })[type]}</span>)}
      <span className="unified-type">{enabled ? "已启用" : "未启用"}</span>
      {purposes.filter(isCurrent).map(purpose => <span className="unified-type" key={purpose}>{defaultPurposes[purpose].badge}</span>)}
    </div>
    {explanation ? <small>{explanation}</small> : row.types.includes("video") ? <small>视频暂未接入</small> : null}
    <small>{row.profile?.output_types_source === "configured" ? "手动配置" : row.entry?.output_types_source === "provider" ? "服务声明" : row.types.length ? "自动识别" : "能力待确认"}</small>
    <div className="unified-actions unified-model-actions">
      {!configured && !subscription && <button type="button" disabled={locked || connectionEditorOpen} onClick={onEditConnection}>编辑服务</button>}
      {configured && needsCapabilities && <button type="button" disabled={locked} onClick={event => onInspect(true, event.currentTarget)}>确认输出能力</button>}
      <button type="button" disabled={locked} onClick={event => onInspect(false, event.currentTarget)}>参数</button>
      <button type="button" role="switch" aria-checked={enabled} aria-label={`${row.connection.name || row.connection.model_base_url} ${row.name} 启用`} disabled={locked || !configured} onClick={onToggle}>{enabled ? "停用" : "启用"}</button>
      {purposes.filter(purpose => !isCurrent(purpose)).map(purpose => <button key={purpose} type="button" disabled={locked || !configured || !ready} onClick={() => onUse(purpose)}>设为{defaultPurposes[purpose].badge}</button>)}
    </div>
  </div>;
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
