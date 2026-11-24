import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { ApiError, type createApiClient } from "../../api/client";
import type { ModelCatalog, ModelConnection, ModelProtocol, ModelServiceCheck, ProfileCapabilityReport } from "../../types";
import { ModelProfileCapabilities } from "./ModelProfileCapabilities";
import { connectionProtocolLabel } from "./protocolLabels";
import "./model-connections.css";
import { useComposerModelDiscovery } from "../chat/useComposerModelDiscovery";
import { ComposerModelParameters } from "../chat/ComposerModelParameters";
import { modelCategories, inferredOutputTypes } from "../chat/model-categories";
import { ModelOutputSettings } from "./ModelOutputSettings";
import { currentModelService } from "./model-service";

type Draft = { name: string; model_base_url: string; model_protocol: ModelProtocol; api_key: string; model_name: string };
const blankDraft: Draft = { name: "", model_base_url: "", model_protocol: "auto", api_key: "", model_name: "" };
const address = (value: string) => value.trim().replace(/\/+$/, "");
function keyOptional(draft: Draft) { return draft.model_protocol === "ollama" || (draft.model_protocol === "auto" && /ollama|:11434(?:\/|$)/i.test(draft.model_base_url)); }
type Props = {
  catalog: ModelCatalog; loading: boolean; busy: boolean; error: string; defaultLocked?: boolean; secretWritable?: boolean;
  fetchJson: ReturnType<typeof createApiClient>;
  onReload: () => Promise<void>;
  onMutate: (path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => Promise<boolean>;
  onDefaultChanged: () => Promise<void>;
  onEnsureProfile?: (connectionId: string, modelName: string, revision: number) => Promise<string | null>;
  singleService?: boolean;
  additionalConnectionActions?: ReactNode;
};

export function ModelConnectionManager({ catalog, loading, busy, error, defaultLocked = false, secretWritable, fetchJson, onReload, onMutate, onDefaultChanged, onEnsureProfile, singleService = false, additionalConnectionActions }: Props) {
  const [editor, setEditor] = useState<{ id: string | null; revision: number; originalAddress: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [keyVisible, setKeyVisible] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const keyRequest = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelName, setModelName] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const activeCategoryFilter = singleService && categoryFilter === "unknown" ? "all" : categoryFilter;
  const purposeMode = Boolean(catalog.purpose_defaults);
  const defaultIds = new Set([catalog.default_profile_id, ...Object.values(catalog.purpose_defaults ?? {})].filter(Boolean));

  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [archiveCandidate, setArchiveCandidate] = useState<string | null>(null);
  // Set when a check/discovery says this model rejects Chat Completions.
  const [protocolSuggestion, setProtocolSuggestion] = useState<string | null>(null);
  const [recheckConnectionId, setRecheckConnectionId] = useState<string | null>(null);
  const [capabilityProfileId, setCapabilityProfileId] = useState<string | null>(null);
  const [parameterCapabilityReport, setParameterCapabilityReport] = useState<ProfileCapabilityReport | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const modelEditorRef = useRef<HTMLElement>(null);
  const diagnosticRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  useEffect(() => { if (editor) { editorRef.current?.scrollIntoView?.({ block: "nearest" }); editorRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); } }, [editor?.id]);
  useEffect(() => { if (capabilityProfileId) modelEditorRef.current?.scrollIntoView?.({ block: "nearest" }); }, [capabilityProfileId]);
  const currentConnection = singleService ? currentModelService(catalog) : catalog.connections.find(item => item.id === selectedId && item.enabled) ?? null;
  const managedConnection = currentConnection?.auth_kind === "chatgpt_subscription";
  const service = useComposerModelDiscovery({ fetchJson, scope: "model-settings", connection: currentConnection ?? undefined });
  const selectedRef = useRef(selectedId);
  selectedRef.current = currentConnection?.id ?? null;
  const canDiscover = Boolean(currentConnection && (managedConnection ? currentConnection.credential_status === "available" : currentConnection.api_key_configured || keyOptional({ ...blankDraft, model_protocol: currentConnection.model_protocol, model_base_url: currentConnection.model_base_url })));
  useEffect(() => { if (canDiscover && !purposeMode && !singleService) void service.discover(); }, [service.discover, canDiscover, purposeMode, singleService]);
  const savedProfiles = new Map<string, ModelCatalog["profiles"][number]>();
  for (const profile of catalog.profiles.filter(item => item.connection_id === currentConnection?.id)) {
    const previous = savedProfiles.get(profile.model_name);
    if (!previous || profile.id === catalog.default_profile_id || (profile.enabled && !previous.enabled && previous.id !== catalog.default_profile_id)) savedProfiles.set(profile.model_name, profile);
  }
  const visibleNames = Array.from(new Set([...service.models, ...(purposeMode ? [...savedProfiles.keys()] : [])])).filter(name => {
    if (!singleService && !name.toLowerCase().includes(modelFilter.trim().toLowerCase())) return false;
    const profile = savedProfiles.get(name);
    const types = profile?.output_types ?? inferredOutputTypes(name, currentConnection?.model_protocol, profile?.capabilities);
    return activeCategoryFilter === "all" || (activeCategoryFilter === "unknown" ? !types.length : types.includes(activeCategoryFilter as "chat" | "image" | "video"));
  });
  async function openModelSettings(name: string) {
    if (!currentConnection || busy) return;
    const id = currentConnection.id;
    const profile = savedProfiles.get(name);
    if (purposeMode && !profile) { setNotice("请先启用此模型，再配置能力与参数。"); return; }
    const profileId = profile?.id ?? await onEnsureProfile?.(id, name, currentConnection.revision);
    if (profileId && selectedRef.current === id) {
      setNotice(""); setParameterCapabilityReport(null); setCapabilityProfileId(profileId);
    }
  }
  async function useModel(name: string) {
    if (!currentConnection || managedConnection || busy || defaultLocked) return;
    const connectionId = currentConnection.id;
    const profile = savedProfiles.get(name);
    if (modelCategories(name, currentConnection.model_protocol, profile?.capabilities).includes("video")) { setNotice("视频生成接口暂未接入，暂时无法使用视频模型。"); return; }
    if (profile && !profile.enabled) { setNotice("此模型已停用，请在设置中启用后再选择。"); return; }
    const profileId = profile?.id ?? await onEnsureProfile?.(connectionId, name, currentConnection.revision);
    if (profileId && selectedRef.current === connectionId) await setDefault(profileId);
  }
  const defaultProfile = catalog.profiles.find(item => item.id === catalog.default_profile_id);
  const defaultConnectionId = defaultProfile?.connection_id;
  useEffect(() => { keyRequest.current += 1; setKeyVisible(false); setSavedKey(""); setKeyError(""); setEditor(null); setDraft({ ...blankDraft }); setSelectedId(null); setNotice(""); setCapabilityProfileId(null); return () => { keyRequest.current += 1; }; }, [fetchJson]);
  useEffect(() => {
    const active = catalog.connections.filter(item => item.enabled);
    if (purposeMode && active.length === 1) setSelectedId(active[0].id);
  }, [catalog.connections, purposeMode]);
  useEffect(() => {
    diagnosticRef.current.id += 1;
    diagnosticRef.current.controller?.abort();
    setDiagnosticMessage(""); setDiagnosticBusy(false); setProtocolSuggestion(null);
    return () => { diagnosticRef.current.id += 1; diagnosticRef.current.controller?.abort(); };
  }, [selectedId, currentConnection?.revision, fetchJson]);
  useEffect(() => {
    // Re-run the check once the switched connection revision has arrived.
    if (!recheckConnectionId || busy || currentConnection?.id !== recheckConnectionId || currentConnection.model_protocol !== "responses") return;
    setRecheckConnectionId(null);
    void diagnose("check");
  }, [recheckConnectionId, busy, currentConnection?.id, currentConnection?.revision, currentConnection?.model_protocol]);

  function clearKeyView() { keyRequest.current += 1; setKeyVisible(false); setSavedKey(""); setKeyError(""); }
  function closeEditor() { clearKeyView(); setEditor(null); setDraft({ ...blankDraft }); }
  function editConnection(connection?: ModelConnection) {
    if (connection?.auth_kind === "chatgpt_subscription") return;
    clearKeyView();
    setCapabilityProfileId(null);
    setNotice("");
    setEditor({ id: connection?.id ?? null, revision: connection?.revision ?? 0, originalAddress: connection?.model_base_url ?? "" });
    setDraft(connection ? { ...blankDraft, name: connection.name, model_base_url: connection.model_base_url, model_protocol: connection.model_protocol } : { ...blankDraft });
  }
  async function saveConnection() {
    if (!editor || busy) return;
    const existing = catalog.connections.find(item => item.id === editor.id);
    if (existing?.auth_kind === "chatgpt_subscription") return;
    const changedAddress = address(draft.model_base_url) !== address(editor.originalAddress);
    if (!keyOptional(draft) && !draft.api_key.trim() && (!existing?.api_key_configured || changedAddress)) return;
    const body = editor.id ? { name: draft.name, model_base_url: draft.model_base_url, model_protocol: draft.model_protocol, api_key: draft.api_key, expected_revision: editor.revision }
      : { ...draft, model_name: draft.model_name.trim() || undefined };
    // Keep credentials only while editing. Every submission attempt clears the input.
    clearKeyView(); setDraft(current => ({ ...current, api_key: "" }));
    const success = await onMutate(editor.id ? `/agent/model-connections/${encodeURIComponent(editor.id)}` : "/agent/model-connections", editor.id ? "PATCH" : "POST", body);
    if (success) { closeEditor(); setNotice("连接已保存。读取模型后启用需要的模型，再设置默认用途。"); }
    else setNotice("连接未确认保存，密钥输入已清除；请检查结果后重新填写。 ");
  }
  async function setDefault(profileId: string) {
    if (defaultLocked || busy) return;
    const profile = catalog.profiles.find(item => item.id === profileId);
    const source = catalog.connections.find(item => item.id === profile?.connection_id);
    if (source?.auth_kind === "chatgpt_subscription") return;
    if (profile && modelCategories(profile.model_name, source?.model_protocol, profile.capabilities).includes("video")) {
      setNotice("视频生成接口暂未接入，暂时无法设为默认模型。");
      return;
    }
    if (await onMutate("/agent/model-default", "POST", { profile_id: profileId })) {
      await onDefaultChanged();
      setNotice("默认模型已更新，从下一次对话生效。");
    }
  }
  async function addModel() {
    if (!currentConnection || managedConnection || !modelName.trim() || busy) return;
    if (await onMutate("/agent/model-profiles", "POST", { connection_id: currentConnection.id, model_name: modelName.trim() })) {
      setModelName(""); setNotice("模型已添加，可以设为默认或在对话中选择。");
    }
  }
  async function enableModel(name: string) {
    if (!currentConnection || busy) return;
    const profile = savedProfiles.get(name);
    const success = profile ? await onMutate(`/agent/model-profiles/${encodeURIComponent(profile.id)}`, "PATCH", { enabled: true, expected_revision: profile.revision }) : await onEnsureProfile?.(currentConnection.id, name, currentConnection.revision);
    if (success) setNotice("模型已启用，可在下方使用规则中选择默认用途。");
  }
  async function switchToResponses() {
    if (!currentConnection || managedConnection || busy) return;
    const connectionId = currentConnection.id;
    if (await onMutate(`/agent/model-connections/${encodeURIComponent(connectionId)}`, "PATCH", { model_protocol: "responses", expected_revision: currentConnection.revision })) {
      setProtocolSuggestion(null);
      setNotice("已改用 OpenAI Responses API，正在重新检测此连接…");
      setRecheckConnectionId(connectionId);
    }
  }
  async function diagnose(kind: "discover" | "check") {
    if (!currentConnection || busy || diagnosticBusy) return;
    if (kind === "discover") { void service.discover(true); return; }
    diagnosticRef.current.controller?.abort();
    const id = ++diagnosticRef.current.id;
    const controller = new AbortController(); diagnosticRef.current.controller = controller;
    const connectionId = currentConnection.id;
    setDiagnosticBusy(true); setDiagnosticMessage(""); setProtocolSuggestion(null);
    const current = () => diagnosticRef.current.id === id && !controller.signal.aborted;
    try {
      const result = await fetchJson<Pick<ModelServiceCheck, "available" | "check_error_message" | "suggested_protocol"> & { check_scope?: string }>(`/agent/model-connections/${encodeURIComponent(connectionId)}/check`, { method: "POST", signal: controller.signal });
      if (current()) {
        setDiagnosticMessage(result.available ? result.check_scope === "catalog" ? "模型目录检测成功；选择模型后可检查实际调用。" : "连接检测成功。" : result.check_error_message || "连接检测未通过。");
        if (!result.available && result.suggested_protocol === "responses") setProtocolSuggestion(connectionId);
      }
    } catch (reason) {
      if (current()) {
        setDiagnosticMessage(reason instanceof Error ? reason.message : "读取连接诊断失败，可手动添加模型。");
        if (reason instanceof ApiError && reason.details?.suggested_protocol === "responses") setProtocolSuggestion(connectionId);
      }
    }
    finally { if (current()) setDiagnosticBusy(false); }
  }
  const parameterProfile = catalog.profiles.find(profile => profile.id === capabilityProfileId);
  const parameterConnection = catalog.connections.find(connection => connection.id === parameterProfile?.connection_id);
  const managedParameter = parameterConnection?.auth_kind === "chatgpt_subscription";
  const existingEditor = catalog.connections.find(item => item.id === editor?.id);
  const editorTitle = singleService ? editor?.id ? "编辑服务" : "配置服务" : editor?.id ? "编辑连接" : "添加连接";
  const needsKey = !keyOptional(draft) && !draft.api_key.trim() && (!existingEditor?.api_key_configured || address(draft.model_base_url) !== address(editor?.originalAddress ?? ""));

  async function toggleKeyVisibility() {
    if (existingEditor?.auth_kind === "chatgpt_subscription") return;
    if (keyVisible) { clearKeyView(); return; }
    const request = ++keyRequest.current;
    setKeyError("");
    if (!draft.api_key && editor?.id && existingEditor?.api_key_configured && address(draft.model_base_url) === address(editor.originalAddress)) {
      try {
        const result = await fetchJson<{ api_key: string }>(`/agent/model-connections/${encodeURIComponent(editor.id)}/reveal-key`, { method: "POST" });
        if (request !== keyRequest.current) return;
        setSavedKey(result.api_key);
      } catch (reason) {
        if (request === keyRequest.current) setKeyError(reason instanceof ApiError && [404, 405].includes(reason.status) ? "当前后端尚未加载查看密钥接口，请重启后端服务后重试。已保存的密钥仍可继续使用。" : reason instanceof Error ? reason.message : "读取密钥失败，请重试。");
        return;
      }
    }
    if (request === keyRequest.current) setKeyVisible(true);
  }

  const modelPanel = (parameterProfile ? <section ref={modelEditorRef} className="model-inline-editor" aria-label={`${parameterProfile.model_name} 设置`}>
      <div className="model-connections-heading"><h4>{parameterProfile.model_name} 设置</h4><button type="button" aria-label="关闭模型设置" disabled={busy} onClick={() => setCapabilityProfileId(null)}>收起设置</button></div>
      {purposeMode && error ? <p role="alert" className="model-capability-error">{error}</p> : null}
      {purposeMode ? <ModelOutputSettings key={`output:${parameterProfile.id}:${parameterProfile.revision}`} profile={parameterProfile} busy={busy} onSave={capabilities => onMutate(`/agent/model-profiles/${encodeURIComponent(parameterProfile.id)}`, "PATCH", { capabilities, expected_revision: parameterProfile.revision })} /> : null}
      {(!purposeMode || parameterProfile.output_types?.includes("chat")) ? <ComposerModelParameters key={`${parameterProfile.id}:${parameterProfile.revision}`} disabled={busy} settings={{ profile: parameterProfile, protocol: parameterConnection?.detected_protocol || parameterConnection?.model_protocol, fetchJson, error, capabilityReport: parameterCapabilityReport,
        onSave: async (id, revision, update) => {
          const saved = await onMutate(`/agent/model-profiles/${encodeURIComponent(id)}`, "PATCH", { ...update, expected_revision: revision });
          if (saved) setNotice("思考设置已保存，所有使用此模型的对话从后续请求生效。");
          return saved;
        }
      }} /> : null}
      {notice ? <p className="model-connections-notice" role="status">{notice}</p> : null}
      <details className="model-profile-advanced"><summary>更多选项</summary>
        <div className="model-connection-actions">{!purposeMode ? !managedParameter && <button type="button" disabled={busy || defaultLocked || !parameterProfile.enabled || parameterProfile.id === catalog.default_profile_id} onClick={() => void setDefault(parameterProfile.id)}>设为默认</button> : <p className="model-connections-hint">默认模型在下方使用规则中设置。</p>}<button type="button" disabled={busy || defaultIds.has(parameterProfile.id)} onClick={() => void onMutate(`/agent/model-profiles/${encodeURIComponent(parameterProfile.id)}`, "PATCH", { enabled: !parameterProfile.enabled, expected_revision: parameterProfile.revision })}>{parameterProfile.enabled ? "停用模型" : "启用模型"}</button></div>
        <ModelProfileCapabilities profileId={parameterProfile.id} modelName={parameterProfile.model_name} fetchJson={fetchJson} disabled={busy} onReport={setParameterCapabilityReport} />
      </details>
    </section> : null);
  const connectionEditor = (editor && existingEditor?.auth_kind !== "chatgpt_subscription" ? <div ref={editorRef} className="model-inline-editor" role="region" aria-label={editorTitle}>{!singleService ? <div className="model-connections-heading"><h4>{editorTitle}</h4></div> : null}{notice && <p role="status" className="model-connections-notice">{notice}</p>}{error && <p role="alert" className="model-capability-error">{error}</p>}<form className="model-connection-editor" onSubmit={event => { event.preventDefault(); void saveConnection(); }}>
      {!singleService ? <p className="model-connections-hint">填写服务地址和密钥。保存后读取服务提供的模型，并选择要使用的模型。</p> : null}
      <label>{singleService ? "服务地址（Base URL）" : "连接 Base URL"}<input type="url" autoComplete="off" value={draft.model_base_url} disabled={busy} onChange={event => { clearKeyView(); setDraft({ ...draft, model_base_url: event.target.value, api_key: "" }); }} placeholder="服务商提供的 API 根地址" /></label>
      <label>{singleService ? "API Key" : "连接 API Key"}<span className="model-key-input"><input type={keyVisible ? "text" : "password"} autoComplete="new-password" value={draft.api_key || savedKey} disabled={busy || secretWritable === false} onChange={event => { keyRequest.current += 1; setSavedKey(""); setDraft({ ...draft, api_key: event.target.value }); }} placeholder={existingEditor?.api_key_configured && !needsKey ? "留空继续使用此连接的密钥" : keyOptional(draft) ? "本地 Ollama 可留空" : "请输入此连接的密钥"} /><button type="button" aria-label={keyVisible ? "隐藏 API Key" : "查看 API Key"} disabled={busy} onClick={() => void toggleKeyVisibility()}>{keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>{address(draft.model_base_url) !== address(editor.originalAddress) && editor.id ? "地址已更改，请填写新地址的密钥；不会复用原连接密钥。" : "密钥默认隐藏，提交或取消后清空输入。"}</small>{keyError && <small role="alert">{keyError}</small>}</label>
      <details className="model-connection-more"><summary>更多设置（可选）</summary>
      {!singleService ? <label>连接名称（可选）<input value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="如工作模型、本地模型" /></label> : null}
      {!editor.id && !singleService ? <label>模型名称（可选）<input value={draft.model_name} disabled={busy} onChange={event => setDraft({ ...draft, model_name: event.target.value })} placeholder="留空，保存连接后从服务读取" /></label> : null}
      <details><summary>接口协议 · 默认自动匹配<ChevronDown size={13} /></summary><select aria-label="连接接口协议" value={draft.model_protocol} disabled={busy} onChange={event => setDraft({ ...draft, model_protocol: event.target.value as ModelProtocol })}>{["auto", "openai", "responses", "images", "anthropic", "gemini", "ollama"].map(value => <option key={value} value={value}>{({ auto: "自动匹配", openai: "OpenAI 兼容", responses: "OpenAI Responses", images: "OpenAI Images（文生图）", anthropic: "Anthropic", gemini: "Gemini", ollama: "Ollama" } as Record<string, string>)[value]}</option>)}</select></details>
      {(draft.model_protocol === "images" || /^gpt-image-/i.test(draft.model_name.trim())) && <p className="model-connections-hint">图片模型共用此连接的服务地址、API Key 和模型目录；请确认该密钥具备生图权限，检测不会生成图片。</p>}
      </details>
      {secretWritable === false && needsKey ? <p className="model-connections-hint">当前密钥存储不可写，恢复后才能新增密钥连接。</p> : null}
      <div className="model-connection-actions"><button type="button" disabled={busy} onClick={closeEditor}>取消编辑</button><button type="submit" disabled={busy || needsKey || (secretWritable === false && Boolean(draft.api_key.trim()))}>{busy ? "提交中…" : singleService ? "保存服务" : "保存连接"}</button></div>
    </form></div> : null);
  const modelTools = currentConnection ? <div className="model-add-profile">
    <div className="model-connections-heading"><div>{singleService ? <h3>模型</h3> : <h4>模型</h4>}<p>从当前服务读取模型，按能力筛选并启用。</p></div><div className="model-directory-actions"><button type="button" aria-label="读取模型列表" disabled={busy || service.busy || !canDiscover} onClick={() => void diagnose("discover")}>{service.busy ? "读取中…" : "读取模型"}</button></div></div>
    {service.models.length > 0 ? <p role="status">已读取 {service.models.length} 个模型。{purposeMode ? "启用后可在使用规则中选择。自动分类不代表接口一定可用。" : "列表以服务返回为准；仅选用或保存参数时记录配置。"}</p> : null}
    {!singleService && !managedConnection ? <details><summary>手动添加模型</summary><label htmlFor="additional-model-name">为 {currentConnection.name || "此连接"} 添加模型</label><div className="model-connection-actions"><input id="additional-model-name" placeholder="输入服务商提供的模型名称" value={modelName} disabled={busy} onChange={event => setModelName(event.target.value)} /><button type="button" disabled={busy || !modelName.trim()} onClick={() => void addModel()}>添加模型</button></div></details> : null}
    {!singleService && !managedConnection ? <details><summary>检测与诊断</summary><p>检测会使用连接下的模型检查接口，可能产生调用费用；没有模型时仅读取目录。</p><button type="button" disabled={busy || diagnosticBusy || !canDiscover} onClick={() => void diagnose("check")}>{diagnosticBusy ? "检测中…" : "检测此连接"}</button></details> : null}
    {diagnosticMessage ? <p role="status">{diagnosticMessage}</p> : null}
    {(protocolSuggestion === currentConnection.id || service.suggestedProtocol === "responses") ? <div className="model-protocol-suggestion" role="alert"><span>该模型不支持 Chat Completions，改用 OpenAI Responses API</span><button type="button" disabled={busy || diagnosticBusy} onClick={() => void switchToResponses()}>改用 Responses 并重新检测</button></div> : null}
    {!purposeMode && [...savedProfiles.values()].some(profile => !service.models.includes(profile.model_name)) ? <details><summary>已保存的历史配置</summary><p className="model-connections-hint">以下配置不代表服务当前可用的模型，仅供已有对话和参数管理。</p>{[...savedProfiles.values()].filter(profile => !service.models.includes(profile.model_name)).map(profile => <button type="button" key={profile.id} aria-label={profile.model_name + " 历史配置"} onClick={() => setCapabilityProfileId(profile.id)}>{profile.model_name}</button>)}</details> : null}
  </div> : null;

  const renderModelDirectory = (connection: ModelConnection) => <>
        {modelTools}
        <div className={singleService ? "model-catalog-toolbar" : ""}>
        {!singleService && (purposeMode || service.models.length > 8) ? <input type="search" aria-label="搜索服务模型" placeholder="搜索模型名称…" value={modelFilter} onChange={event => setModelFilter(event.target.value)} /> : null}
        {purposeMode ? <div className="model-type-filters" role="group" aria-label="按模型输出筛选">{[["all", "全部"], ["chat", "对话"], ["image", "图片"], ["video", "视频"], ...(!singleService ? [["unknown", "待确认"]] : [])].map(([id, label]) => <button type="button" key={id} aria-pressed={activeCategoryFilter === id} onClick={() => setCategoryFilter(id)}>{label}</button>)}</div> : null}
        </div>
        {purposeMode ? <div className="model-directory-heading"><span>模型名称</span><span>模型能力</span><span>状态与操作</span></div> : null}
        <div className={`model-profile-list service-model-list${parameterProfile ? " is-editing" : ""}`}>{visibleNames.map(name => {
          const profile = savedProfiles.get(name);
          const categories = purposeMode ? profile?.output_types ?? inferredOutputTypes(name, connection.model_protocol, profile?.capabilities) : modelCategories(name, connection.model_protocol, profile?.capabilities);
          const isVideo = categories.includes("video");
          const inferred = categories.map(category => ({ chat: "对话", image: "图片生成", video: "视频生成" })[category]).join("、") || "待确认";
          const capabilityNames: Record<string, string> = { vision: "图片输入", tools: "工具调用", streaming: "流式输出", image_generation: "图片生成" };
          const supported = Object.entries(profile?.capabilities ?? {}).filter(([, value]) => value === "supported").map(([key]) => capabilityNames[key]).filter(Boolean);
          return <Fragment key={name}><div className={`model-profile-row${purposeMode ? " model-directory-row" : ""}${profile?.id === catalog.default_profile_id ? " is-default" : ""}`}>
            <span><strong>{name}</strong>{profile?.id === catalog.default_profile_id && !purposeMode ? <small>默认模型</small> : profile && !profile.enabled ? <small>已停用</small> : null}{!singleService ? <small>来源：{connection.name || connection.model_base_url || "模型服务"}</small> : null}{!purposeMode ? <><small>分类参考：{inferred}{isVideo ? "（暂未接入）" : ""}</small><small>{supported.length ? `已配置能力：${supported.join("、")}` : "能力待确认"}</small></> : null}</span>
            {purposeMode ? <span className="model-directory-capabilities">{inferred}<small>{profile?.output_types_source === "configured" ? "已配置" : categories.length ? "自动识别" : "请确认能力"}{supported.length ? ` · ${supported.join("、")}` : ""}</small>{categories.includes("image") && profile && !profile.supported_purposes?.includes("image") ? <small>图片生成接口待接入</small> : null}</span> : null}
            <div>{purposeMode ? isVideo ? <span className="model-enabled-label">暂未接入</span> : profile?.enabled ? <span className="model-enabled-label">已启用{catalog.purpose_defaults?.chat === profile.id ? " · 聊天默认" : ""}{catalog.purpose_defaults?.image === profile.id ? " · 图片默认" : ""}</span> : <button type="button" aria-label={`${name} 启用模型`} disabled={busy || (!profile && !onEnsureProfile)} onClick={() => void enableModel(name)}>启用</button> : !managedConnection && profile?.id !== catalog.default_profile_id ? <button type="button" aria-label={`${name} 用于新对话`} disabled={busy || defaultLocked || isVideo || (!profile && !onEnsureProfile)} onClick={() => void useModel(name)}>使用</button> : null}<button type="button" aria-label={`${name} 设置`} disabled={busy || (managedConnection && !canDiscover)} onClick={() => void openModelSettings(name)}>设置</button></div>
          </div>{parameterProfile?.model_name === name && parameterProfile.connection_id === connection.id ? modelPanel : null}</Fragment>;
        })}</div>
        {purposeMode && !visibleNames.length && !service.busy && (service.models.length > 0 || savedProfiles.size > 0) ? <p role="status" className="model-connections-hint">{singleService ? "当前分类下没有模型，可切换分类或重新读取模型。" : "没有符合筛选条件的模型，请调整分类或搜索词。"}</p> : null}
        {service.busy ? <p role="status" className="model-connections-hint">正在读取服务模型…</p> : service.error ? <p role="alert" className="model-capability-error">{service.error}</p> : !service.models.length ? <p className="model-connections-hint">{canDiscover ? purposeMode ? "尚未读取服务目录。已保存的模型仍会显示，可点击读取更新列表。" : singleService ? "服务尚未返回模型，请重新读取。" : "服务尚未返回模型，可刷新列表或手动填写。" : "请先编辑此连接并配置密钥，再读取模型列表。"}</p> : null}

        {parameterProfile && !visibleNames.includes(parameterProfile.model_name) ? modelPanel : null}
        {!singleService && !managedConnection ? <details className="model-connection-more"><summary>连接选项</summary><p className="model-connections-hint">接口协议：{connectionProtocolLabel(connection.model_protocol, connection.detected_protocol)}</p><button type="button" disabled={busy || connection.id === defaultConnectionId} onClick={() => setArchiveCandidate(connection.id)}>停用连接</button></details> : null}
  </>;

  if (singleService) return <div className="model-single-service">
    {additionalConnectionActions}
    <section className="settings-card model-settings-card model-connections-card model-service-summary" aria-labelledby="model-connections-title">
      <div className="model-connections-heading"><div><h3 id="model-connections-title">服务连接</h3><p>配置一个模型服务，在下方管理它提供的所有模型。</p></div>{!managedConnection && <button type="button" className="model-service-edit" disabled={busy || loading || editor !== null} onClick={() => editConnection(currentConnection ?? undefined)}>{currentConnection ? "编辑服务" : "配置服务"}</button>}</div>
      {managedConnection ? <p className="model-connections-hint">{canDiscover ? "当前 ChatGPT 订阅可用。" : "当前不可用，请在 ChatGPT 订阅登录中管理账号。"}</p> : !editor ? currentConnection ? <dl className="model-service-facts"><div className="model-service-address"><dt>服务地址</dt><dd>{currentConnection.model_base_url || "服务商默认地址"}</dd></div><div><dt>API Key</dt><dd>{currentConnection.api_key_configured ? "已配置" : "未配置"}</dd></div><div><dt>接口协议</dt><dd>{connectionProtocolLabel(currentConnection.model_protocol, currentConnection.detected_protocol)}</dd></div></dl> : <p className="model-connections-hint">{loading ? "正在读取服务配置…" : "填写服务地址和 API Key，即可读取对话、图片等模型。"}</p> : null}
      {editor ? connectionEditor : null}
      {error ? <p className="model-capability-error" role="alert">{error}<button type="button" disabled={busy || loading} onClick={() => void onReload()}>重新读取</button></p> : null}
      {notice && !editor && !parameterProfile ? <p role="status" className="model-connections-notice">{notice}</p> : null}
    </section>
    <section className="settings-card model-settings-card model-connections-card model-service-directory" aria-label="模型">
      {currentConnection ? renderModelDirectory(currentConnection) : <><h3>模型</h3><p className="model-connections-hint">配置服务后，即可读取模型。</p></>}
    </section>
  </div>;

  return <section className="settings-card model-settings-card model-connections-card" aria-labelledby="model-connections-title">
    <div className="model-connections-heading"><div><h3 id="model-connections-title">服务连接</h3><p>管理服务地址和密钥，一个连接可以提供多种模型。</p></div><button className="model-connections-add" type="button" disabled={busy} onClick={() => editConnection()}>添加连接</button></div>
    {additionalConnectionActions}
    {editor && !editor.id ? connectionEditor : null}
    {error ? <p className="model-capability-error" role="alert">{error}<button type="button" disabled={busy || loading} onClick={() => void onReload()}>重新读取</button></p> : null}
    {notice && !editor && !parameterProfile ? <p className="model-connections-notice" role="status">{notice}</p> : null}
    {defaultLocked ? <p className="model-connections-hint">默认配置有未保存的修改，保存或取消后可切换默认模型。</p> : null}
    {loading && !catalog.connections.length ? <p role="status">正在读取连接…</p> : null}
    {!loading && !catalog.connections.some(item => item.enabled) ? <p className="model-connections-hint">还没有连接，添加服务地址和密钥后读取模型列表。</p> : null}
    <div className="model-connection-list">{catalog.connections.filter(item => item.enabled).map(connection => <article key={connection.id} className={selectedId === connection.id ? "selected" : ""}>
      <div className="model-connection-head">
      <button className="model-connection-select" type="button" aria-expanded={selectedId === connection.id} onClick={() => { setSelectedId(current => current === connection.id ? null : connection.id); setModelName(""); setModelFilter(""); setArchiveCandidate(null); setCapabilityProfileId(null); }}><strong>{connection.name || connection.model_base_url || "模型服务"}<ChevronDown size={14} aria-hidden="true" /></strong><small>{connection.model_base_url || "官方默认地址"} · {connection.api_key_configured ? "密钥已配置" : "未配置密钥"}{defaultConnectionId === connection.id ? " · 包含当前默认模型" : ""}</small><small>{selectedId === connection.id ? service.busy ? "正在读取服务模型…" : service.models.length ? `服务返回 ${service.models.length} 个模型` : "展开后读取服务模型" : "展开后读取服务模型"}</small></button>
      {connection.auth_kind !== "chatgpt_subscription" && <div className="model-connection-actions"><button type="button" disabled={busy} onClick={() => editConnection(connection)}>编辑连接</button></div>}
      </div>
      {editor?.id === connection.id ? connectionEditor : null}
      {archiveCandidate === connection.id ? <div className="model-archive-confirm"><span>停用后，该连接的模型将无法用于新对话。</span><button type="button" disabled={busy} onClick={async () => { if (await onMutate(`/agent/model-connections/${encodeURIComponent(connection.id)}`, "DELETE")) { setArchiveCandidate(null); if (selectedId === connection.id) setSelectedId(null); } }}>确认停用</button><button type="button" disabled={busy} onClick={() => setArchiveCandidate(null)}>取消</button></div> : null}
      {selectedId === connection.id ? renderModelDirectory(connection) : null}
    </article>)}</div>
  </section>;
}
