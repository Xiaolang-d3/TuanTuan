import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, CheckCircle2, ChevronDown, Cpu, Eye, EyeOff, Gauge, Image, LoaderCircle, RefreshCw, Save, ScanSearch, TriangleAlert, Wrench } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import type { createApiClient } from "../../api/client";
import type { AgentSettings, ModelCapabilityFlag, ModelCapabilityReport, ModelServiceMonitor } from "../../types";
import { CAPABILITY_SOURCE_LABELS, formatContextTokens, formatUsd } from "./modelCapabilities";
import { connectionProtocolLabel } from "./protocolLabels";
import "./model-settings.css";
import { ModelSettingsDialog } from "./ModelSettingsDialog";

type Props = {
  fetchJson: ReturnType<typeof createApiClient>;
  manager?: (advanced: ReactNode) => ReactNode;
  kernelSettings?: ReactNode;
  connectionManager?: ReactNode;
  routingManager?: ReactNode;
  purposeManager?: ReactNode;
  settings: AgentSettings;
  savedSettings: AgentSettings;
  editing: boolean;
  busy: boolean;
  saveUnknown?: boolean;
  error?: string;
  onConfirmSave?: () => void;
  onResumeEditing?: () => void;
  monitor: ModelServiceMonitor | null;
  monitorBusy: boolean;
  availableModels: string[];
  discoveryBusy: boolean;
  discoveryError: string;
  capabilities: ModelCapabilityReport | null;
  capabilitiesBusy: boolean;
  onSettingsChange: (settings: AgentSettings) => void;
  onDiscoverModels: (force?: boolean) => void;
  onCheckService: () => void;
  onProbeCapabilities: () => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
};

const statusLabels: Record<ModelServiceMonitor["status"], string> = {
  healthy: "运行正常",
  degraded: "服务波动",
  unavailable: "当前不可用",
  unknown: "等待检测"
};

const requestKindLabels: Record<string, string> = {
  generate: "普通调用",
  stream: "流式调用",
  health_check: "主动检测"
};

const capabilityLabels: Record<ModelCapabilityFlag["status"], string> = {
  supported: "支持",
  unsupported: "不支持",
  unknown: "未知"
};

function formatTime(value: string | null) {
  if (!value) return "暂无";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatLatency(value: number | null) {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function formatTokens(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("zh-CN").format(value);
}

function resolvedProtocol(modelName: string, configured: AgentSettings["model_protocol"], baseUrl: string) {
  if (configured !== "auto") return configured;
  const normalizedBaseUrl = baseUrl.trim();
  if (/^gpt-image-/i.test(modelName.trim())) return "images";
  if (/anthropic\.com/i.test(normalizedBaseUrl)) return "anthropic";
  if (/generativelanguage\.googleapis\.com/i.test(normalizedBaseUrl)) return "gemini";
  if (/ollama/i.test(normalizedBaseUrl) || /:11434(?:\/|$)/i.test(normalizedBaseUrl)) return "ollama";
  if (/claude/i.test(modelName)) return "anthropic";
  if (/gemini/i.test(modelName)) return "gemini";
  return "openai";
}

function protocolLabel(protocol: Exclude<AgentSettings["model_protocol"], "auto">) {
  return {
    openai: "OpenAI 兼容 Chat Completions",
    responses: "OpenAI Responses API",
    images: "OpenAI Images API",
    anthropic: "Anthropic Messages API",
    gemini: "Google Gemini generateContent",
    ollama: "Ollama Chat API"
  }[protocol];
}

function protocolBaseUrl(protocol: Exclude<AgentSettings["model_protocol"], "auto">) {
  return {
    openai: "https://api.openai.com/v1",
    responses: "https://api.openai.com/v1",
    images: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    ollama: "http://127.0.0.1:11434"
  }[protocol];
}

function protocolBaseUrlHelp(protocol: Exclude<AgentSettings["model_protocol"], "auto">) {
  if (protocol === "anthropic") return "填写 Anthropic 服务根地址，系统按 Messages 协议请求 /v1/messages。";
  if (protocol === "gemini") return "填写 Gemini API 版本根地址，系统按 generateContent 协议组装模型路径。";
  if (protocol === "ollama") return "填写 Ollama 服务根地址，系统会请求 /api/chat 和 /api/tags。";
  if (protocol === "images") return "填写服务商的 Images API 根地址与具有生图权限的密钥；模型可从服务目录读取，检测不会生成图片。";
  if (protocol === "responses") return "填写 Responses API 根地址；系统会在该根地址下请求 /responses。";
  return "填写 Chat Completions 的完整 API 根地址；系统不会自动添加 /v1。";
}

function CapabilityRow({
  icon,
  label,
  flag
}: {
  icon: ReactNode;
  label: string;
  flag: ModelCapabilityFlag | undefined;
}) {
  const status = flag?.status || "unknown";
  return (
    <article className={`model-capability-row ${status}`}>
      <span>{icon}</span>
      <div>
        <strong>{label}</strong>
        <small>{flag?.detail || "尚未读取该能力"}</small>
        {flag?.source === "probe" && flag.protocol && <small>本次检测协议：{protocolLabel(flag.protocol)}</small>}
      </div>
      <em>{capabilityLabels[status]}</em>
    </article>
  );
}

export function ModelSettingsPage({
  fetchJson,
  manager,
  kernelSettings,
  connectionManager,
  routingManager,
  purposeManager,
  settings,
  savedSettings,
  editing,
  busy,
  saveUnknown = false,
  error = "",
  onConfirmSave,
  onResumeEditing,
  monitor,
  monitorBusy,
  availableModels,
  discoveryBusy,
  discoveryError,
  capabilities,
  capabilitiesBusy,
  onSettingsChange,
  onDiscoverModels,
  onCheckService,
  onProbeCapabilities,
  onBeginEdit,
  onCancelEdit,
  onSave
}: Props) {
  const [dialogOpen, setDialogOpen] = useState(editing || saveUnknown);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (editing) wasEditing.current = true;
    else if (wasEditing.current && !saveUnknown) {
      setDialogOpen(false);
      wasEditing.current = false;
    }
  }, [editing, busy, saveUnknown]);
  function closeDialog() {
    if (busy || saveUnknown) return;
    clearKeyView();
    onCancelEdit();
    setDialogOpen(false);
    setManualModel(false);
    setShowKey(false);
    setModelSearch("");
  }
  const [manualModel, setManualModel] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const keyRequest = useRef(0);
  const [modelSearch, setModelSearch] = useState("");
  function clearKeyView() { keyRequest.current += 1; setShowKey(false); setSavedKey(""); setKeyError(""); }
  useEffect(() => {
    clearKeyView();
    if (dialogOpen) {
      setShowKey(true);
      const sameAddress = settings.model_base_url.trim().replace(/\/+$/, "") === savedSettings.model_base_url.trim().replace(/\/+$/, "");
      if (sameAddress && !settings.api_key && savedSettings.api_key_configured && savedSettings.connection_id) {
        const request = ++keyRequest.current;
        void fetchJson<{ api_key: string }>(`/agent/model-connections/${encodeURIComponent(savedSettings.connection_id)}/reveal-key`, { method: "POST" })
          .then(result => { if (request === keyRequest.current) setSavedKey(result.api_key); })
          .catch(reason => { if (request === keyRequest.current) setKeyError(reason instanceof Error ? reason.message : "读取密钥失败，请重试。"); });
      }
    }
    return () => { keyRequest.current += 1; };
  }, [dialogOpen, settings.model_base_url, savedSettings.model_base_url, savedSettings.connection_id, savedSettings.config_revision, savedSettings.api_key_configured, fetchJson]);
  const effectiveProtocol = resolvedProtocol(settings.model_name, settings.model_protocol, settings.model_base_url);
  const savedConnectionUnchanged = settings.model_name === savedSettings.model_name && settings.model_base_url === savedSettings.model_base_url && settings.model_protocol === savedSettings.model_protocol;
  const actualProtocol = !editing && savedConnectionUnchanged
    ? (monitor?.model_name === savedSettings.model_name ? monitor.protocol : undefined)
      ?? (capabilities?.model_name === savedSettings.model_name ? capabilities.protocol : undefined)
      ?? savedSettings.resolved_model_protocol
    : undefined;
  const effectiveProtocolLabel = protocolLabel(actualProtocol ?? effectiveProtocol);
  const automaticProtocolLabel = `${actualProtocol ? "当前" : "优先"}：${effectiveProtocolLabel}`;
  const addressChanged = settings.model_base_url.trim().replace(/\/+$/, "") !== savedSettings.model_base_url.trim().replace(/\/+$/, "");
  const canReuseStoredKey = savedSettings.api_key_configured && !addressChanged;
  const keyRequired = effectiveProtocol !== "ollama" && !settings.api_key.trim() && !canReuseStoredKey;
  const storageReadOnly = savedSettings.secret_storage_writable === false;
  const managedKey = savedSettings.api_key_source === "environment" || savedSettings.secret_storage === "environment";
  const fieldsBusy = busy || saveUnknown;
  async function toggleKeyVisibility() {
    if (showKey) { clearKeyView(); return; }
    const request = ++keyRequest.current;
    setKeyError("");
    if (!settings.api_key && canReuseStoredKey && savedSettings.connection_id) {
      try {
        const result = await fetchJson<{ api_key: string }>(`/agent/model-connections/${encodeURIComponent(savedSettings.connection_id)}/reveal-key`, { method: "POST" });
        if (request !== keyRequest.current) return;
        setSavedKey(result.api_key);
      } catch (reason) {
        if (request === keyRequest.current) setKeyError(reason instanceof Error ? reason.message : "读取密钥失败，请重试。");
        return;
      }
    }
    if (request === keyRequest.current) setShowKey(true);
  }
  const catalog = Array.from(new Set(availableModels.map((name) => name.trim()).filter(Boolean)));
  const filteredModels = catalog.filter(name => name.toLowerCase().includes(modelSearch.trim().toLowerCase()));
  const remainingQuota = monitor?.usage?.remaining_quota ?? null;
  const quotaAvailable = Boolean(monitor?.usage?.quota_available && remainingQuota != null);
  const usedTokens = monitor?.usage?.total_tokens ?? monitor?.summary.total_tokens ?? 0;
  const windowHours = monitor?.usage?.window_hours ?? monitor?.window_hours ?? 24;
  const estimatedCost = monitor?.summary.estimated_cost_usd ?? null;
  const pricedRequests = monitor?.summary.priced_requests ?? 0;
  const unpricedRequests = monitor?.summary.unpriced_requests ?? 0;
  const merged = capabilities?.merged;
  function changeSettings(next: AgentSettings) {
    if (!editing) onBeginEdit();
    onSettingsChange(next);
  }
  function discoverOnBlur() {
    if (editing && !fieldsBusy && (effectiveProtocol === "ollama" || settings.api_key.trim() || canReuseStoredKey)) onDiscoverModels();
  }

  const mainContent = (
    <>
      {connectionManager}
      {purposeManager}
      {!purposeManager && <>
      <section className="settings-card model-settings-card model-current-summary">
        <span className="model-current-icon" aria-hidden="true"><Cpu size={18} /></span>
        <div className="model-current-copy">
          <h3>默认模型</h3>
          <strong>{savedSettings.model_name || "尚未配置"}</strong>
          <p>{savedSettings.model_base_url || "使用服务商默认地址"}</p>
          <p className="model-default-explanation">{savedSettings.model_name ? resolvedProtocol(savedSettings.model_name, savedSettings.model_protocol, savedSettings.model_base_url) === "images" ? "图片生成模型 · 普通文字请求会尝试使用已启用的聊天模型。" : "新对话默认使用此模型；图片生成请求可能自动选择其他模型。" : "配置默认模型后可开始对话。"}</p>
          <div className="model-current-meta">
            <em className={savedSettings.api_key_configured ? "success" : "warning"}>
              {savedSettings.api_key_configured ? <CheckCircle2 size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
              {savedSettings.credential_status === "saved_unverified" ? "密钥已保存，使用时授权" : savedSettings.api_key_configured ? "密钥已配置" : "待配置密钥"}
            </em>
            {monitor ? <em className={monitor.status}>{statusLabels[monitor.status]}</em> : null}
          </div>
        </div>
        <ActionButton variant="primary" onClick={() => { setManualModel(false); setModelSearch(""); setShowKey(false); setDialogOpen(true); }}>配置模型</ActionButton>
      </section>
      <section className="settings-card model-settings-card model-purpose-summary" aria-labelledby="model-purpose-title">
        <div>
          <h3 id="model-purpose-title">模型用途</h3>
          <p>查看默认配置与不同任务的模型选择方式。</p>
        </div>
        <div className="model-purpose-list">
          <div><strong>聊天与工作</strong><span>{savedSettings.model_name && resolvedProtocol(savedSettings.model_name, savedSettings.model_protocol, savedSettings.model_base_url) !== "images" ? `默认配置：${savedSettings.model_name}` : "自动选择已启用的聊天模型"}</span></div>
          <div><strong>图片生成</strong><span>{savedSettings.model_name && resolvedProtocol(savedSettings.model_name, savedSettings.model_protocol, savedSettings.model_base_url) === "images" ? `默认配置：${savedSettings.model_name}` : "自动选择可用的图片模型"}</span></div>
          <div><strong>视频生成</strong><span>暂未接入</span></div>
        </div>
        <p>实际模型由系统路由和高级设置共同决定，尚不支持分别设置聊天与图片默认模型。可在服务连接中管理模型。</p>
      </section>
      </>}
      {dialogOpen && <ModelSettingsDialog title="配置模型" locked={fieldsBusy} onClose={closeDialog}>
        {error && <p role="alert" className="model-capability-error">{error}</p>}
        {savedSettings.secret_migration_warning ? <p className="model-settings-warning" role="alert">{savedSettings.secret_migration_warning}。旧密钥仍保留在本地数据库中，修复钥匙串后再次保存即可迁移。</p> : null}
        {storageReadOnly ? <p className="model-settings-warning" role="status">{managedKey ? "当前使用只读环境变量密钥，页面无法更换；本地 macOS 可使用系统钥匙串保存个人密钥。" : "本机密钥存储暂不可写。已保存密钥仍可使用；更换密钥前请修复系统钥匙串。"}</p> : null}
        {saveUnknown ? <p className="model-settings-warning" role="status">保存结果待确认，请重新读取服务端状态；不会自动重复提交。</p> : null}
        <section className="settings-card model-settings-card model-connection-card">
          <p className="model-dialog-intro">填写服务地址和密钥，再选择默认模型。图片生成和文字请求可能使用不同模型。</p>
          <label>
            <span id="model-base-url-label">Base URL</span>
            <input aria-labelledby="model-base-url-label" aria-describedby="model-base-url-help" type="url" autoComplete="off" spellCheck={false} value={settings.model_base_url} disabled={fieldsBusy} placeholder={protocolBaseUrl(effectiveProtocol)} onChange={(event) => { clearKeyView(); changeSettings({ ...settings, model_base_url: event.target.value }); }} onBlur={discoverOnBlur} />
            <small id="model-base-url-help">填写服务商提供的 API 地址，包含其要求的 /v1 等路径。</small>
          </label>
          <div className="model-key-field">
            <div className="model-field-heading"><label id="model-api-key-label" htmlFor="model-api-key">API Key</label>{canReuseStoredKey && <span className="model-key-badge">已配置</span>}</div>
            <div className="model-key-input">
              <input id="model-api-key" aria-labelledby="model-api-key-label" aria-describedby="model-api-key-help" type={showKey ? "text" : "password"} autoComplete="new-password" value={settings.api_key || savedKey} disabled={fieldsBusy || storageReadOnly} placeholder={effectiveProtocol === "ollama" ? "本地 Ollama 可留空" : canReuseStoredKey ? "已配置，留空则继续使用" : "请输入 API Key"} onChange={(event) => { keyRequest.current += 1; setSavedKey(""); changeSettings({ ...settings, api_key: event.target.value }); }} onBlur={discoverOnBlur} />
              <button type="button" aria-label={showKey ? "隐藏 API Key" : "查看 API Key"} aria-pressed={showKey} disabled={fieldsBusy || (!settings.api_key && !(canReuseStoredKey && savedSettings.connection_id))} onClick={() => void toggleKeyVisibility()}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
            <small id="model-api-key-help">{effectiveProtocol === "ollama" ? "本地 Ollama 可不填写密钥。" : addressChanged ? "服务地址已更改，请填写该服务的密钥；不会复用旧地址的密钥。" : canReuseStoredKey ? "密钥可见；清空后保存将继续使用已保存的密钥。" : "填写服务商提供的密钥。"}</small>
            {keyError && <small role="alert">{keyError}</small>}
          </div>
          <div className="model-name-setting">
            <div className="model-field-heading">
              <label htmlFor="model-name-input">模型名称</label>
              <button type="button" className="model-discovery-button" disabled={fieldsBusy || discoveryBusy || keyRequired} onClick={() => onDiscoverModels(true)}>
                <RefreshCw className={discoveryBusy ? "spinning" : ""} size={13} />
                {discoveryBusy ? "读取中…" : "刷新列表"}
              </button>
            </div>
            {catalog.length > 8 && !manualModel && <input type="search" aria-label="搜索模型" placeholder="搜索模型名称…" value={modelSearch} disabled={fieldsBusy} onChange={event => setModelSearch(event.target.value)} />}
            {catalog.length > 0 && !manualModel ? (
              <select id="model-name-input" value={settings.model_name} disabled={fieldsBusy} onChange={(event) => changeSettings({ ...settings, model_name: event.target.value })}>
                {!settings.model_name && <option value="">选择模型</option>}
                {settings.model_name && !filteredModels.includes(settings.model_name) ? <option value={settings.model_name} disabled>{settings.model_name}（当前配置，服务未返回）</option> : null}
                {filteredModels.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : (
              <input id="model-name-input" value={settings.model_name} disabled={fieldsBusy} placeholder="输入模型名称" onChange={(event) => changeSettings({ ...settings, model_name: event.target.value })} />
            )}
            {modelSearch.trim() && !manualModel && <small role="status">{filteredModels.length ? `找到 ${filteredModels.length} 个匹配模型` : "没有匹配的模型，可修改搜索词或手动填写。"}</small>}
            {catalog.length > 0 && <button className="model-manual-button" type="button" disabled={fieldsBusy} onClick={() => setManualModel(!manualModel)}>{manualModel ? "从列表选择" : "手动填写"}</button>}
            <small className={discoveryError ? "model-discovery-error" : ""}>
              {discoveryBusy
                ? "正在读取模型列表…"
                : discoveryError
                  ? "未能读取模型列表，可手动填写模型名称。"
                  : catalog.length
                    ? `${catalog.length} 个模型可选择，是否可用以连接检测为准。`
                    : "可直接填写模型名称，或读取服务商的模型列表。"}
            </small>
          </div>
          <details className="model-dialog-protocol">
            <summary>高级选项：接口协议（默认自动匹配）</summary>
            <section className="settings-card model-settings-card model-protocol-card">
              <label>
                <span id="model-protocol-label">接口协议</span>
                <select aria-labelledby="model-protocol-label" value={settings.model_protocol} disabled={fieldsBusy} onChange={(event) => changeSettings({ ...settings, model_protocol: event.target.value as AgentSettings["model_protocol"] })}>
                  <option value="auto">自动匹配（{automaticProtocolLabel}）</option>
                  <option value="openai">OpenAI 兼容 Chat Completions</option>
                  <option value="responses">OpenAI Responses API</option>
                  <option value="images">OpenAI Images API（文生图）</option>
                  <option value="anthropic">Anthropic Messages API</option>
                  <option value="gemini">Google Gemini generateContent</option>
                  <option value="ollama">Ollama Chat API</option>
                </select>
                {!editing && savedSettings.model_protocol === "auto" && savedSettings.detected_model_protocol ? <small className="model-detected-protocol">{connectionProtocolLabel("auto", savedSettings.detected_model_protocol)}</small> : null}
                <small>默认根据服务地址和模型推断协议；遇到明确的协议不兼容时会尝试受支持的替代接口。特殊服务可手动选择。</small>
                <small>{protocolBaseUrlHelp(effectiveProtocol)}</small>
              </label>
              {discoveryError && <p className="model-capability-error" role="alert">模型列表读取失败：{discoveryError}</p>}
            </section>
          </details>
          <div className="model-settings-actions">
            <p role="status">{saveUnknown ? "保存结果待确认" : busy ? "正在保存配置…" : !settings.model_name.trim() ? "请先选择或填写模型名称" : keyRequired ? "请填写当前服务的 API Key" : editing ? "有未保存的修改" : `默认模型：${savedSettings.model_name || "尚未配置"}`}</p>
            {saveUnknown && <ActionButton variant="secondary" disabled={busy} onClick={onResumeEditing}>读取最新配置并继续编辑</ActionButton>}
            {!saveUnknown && <ActionButton variant="secondary" disabled={fieldsBusy} onClick={closeDialog}>取消</ActionButton>}
            {saveUnknown ? <ActionButton variant="primary" disabled={busy} onClick={onConfirmSave}>{busy ? "确认中…" : "重新确认保存结果"}</ActionButton> : <ActionButton variant="primary" disabled={busy || !editing || !settings.model_name.trim() || keyRequired || (storageReadOnly && Boolean(settings.api_key.trim()))} onClick={() => { clearKeyView(); onSave(); }}>
              {busy ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}{busy ? "保存中…" : "保存并应用"}
            </ActionButton>}
          </div>
          <p className="model-save-note">{monitorBusy && !busy ? "配置已保存，连接检测中；可以继续编辑。" : "保存后从下一次对话生效。"}</p>
        </section>
      </ModelSettingsDialog>}
    </>
  );
  const advancedContent = (
    <>
        {routingManager}
        <div className="model-settings-panels">
          <p className="model-diagnostics-note">以下诊断来自已保存的连接。{editing ? "保存修改后可重新检测。" : ""}</p>

          <section className="settings-card model-quota-card">
            <div className="settings-card-heading">
              <span><Gauge size={18} /></span>
              <div><h3>模型额度</h3><p>只展示后端或调用记录里真实存在的用量，不会编造剩余额度。</p></div>
            </div>
            {quotaAvailable ? (
              <div className="model-quota-remaining">
                <span>剩余额度</span>
                <strong>{formatTokens(remainingQuota)}</strong>
              </div>
            ) : (
              <div className="model-quota-empty">
                <strong>暂无额度数据</strong>
                <span>当前服务没有返回剩余 token / 配额。下面是本地调用快照。</span>
              </div>
            )}
            <div className="model-monitor-metrics model-quota-metrics">
              <article>
                <span>近 {windowHours}h Token</span>
                <strong>{formatTokens(usedTokens)}</strong>
                <small>来自模型调用记录，不是服务商余额</small>
              </article>
              <article>
                <span>近 {windowHours}h 请求</span>
                <strong>{monitor ? formatTokens(monitor.summary.total_requests) : "—"}</strong>
                <small>{monitor ? `${monitor.summary.successful_requests} 次成功` : "等待监控数据"}</small>
              </article>
              <article>
                <span>近 {windowHours}h 估算费用</span>
                <strong>{pricedRequests ? formatUsd(estimatedCost) : "—"}</strong>
                <small>{pricedRequests ? `${pricedRequests} 次有价格数据${unpricedRequests ? `，${unpricedRequests} 次未计价` : ""}` : "按 LiteLLM 价格表或模型自定义价格估算"}</small>
              </article>
            </div>
          </section>

          <section className="settings-card model-capability-card">
            <div className="settings-card-heading model-monitor-heading">
              <span><ScanSearch size={18} /></span>
              <div><h3>模型能力检测</h3><p>分别检测图片输入、流式输出和工具调用；将发送三组小请求，可能产生少量用量。</p></div>
              <ActionButton variant="secondary" className="model-check-button" disabled={busy || editing || capabilitiesBusy} onClick={onProbeCapabilities}>
                <RefreshCw className={capabilitiesBusy ? "spinning" : ""} size={15} />
                {capabilitiesBusy ? "检测中…" : "检测"}
              </ActionButton>
            </div>
            <CapabilityRow icon={<Image size={16} />} label="是否支持多模态" flag={capabilities?.vision} />
            <CapabilityRow icon={<Activity size={16} />} label="流式输出" flag={capabilities?.streaming} />
            <CapabilityRow icon={<Wrench size={16} />} label="工具 / Function calling" flag={capabilities?.tools} />
            {merged ? <p className="model-capability-note">上下文长度 {formatContextTokens(merged.context_window.tokens)}{merged.max_output_tokens.tokens ? ` · 最大输出 ${formatContextTokens(merged.max_output_tokens.tokens)}` : ""} · 推理 {merged.capabilities.reasoning.status === "supported" ? "支持" : merged.capabilities.reasoning.status === "unsupported" ? "不支持" : "未知"}（{CAPABILITY_SOURCE_LABELS[merged.capabilities.reasoning.source]}）</p> : null}
            {capabilities?.probe_error ? <p className="model-capability-error">{capabilities.probe_error}</p> : null}
            {capabilities?.attachment_vision_enabled === false && capabilities.vision.status === "supported" ? (
              <p className="model-capability-note">模型侧通常支持看图，但应用看图开关 ATTACHMENT_VISION_ENABLED 尚未开启。</p>
            ) : null}
            {capabilities?.probed ? <p className="model-capability-note">各项结果来自独立探测；失败或未返回有效结果的项目保留为未知。</p> : null}
          </section>
          <section className="settings-card model-monitor-card">
            <div className="settings-card-heading model-monitor-heading">
              <span><Activity size={18} /></span>
              <div><h3>连接状态与调用质量</h3><p>仅统计调用结果，每 15 秒刷新；不保存你的提示词和回复内容。</p></div>
              <ActionButton variant="secondary" className="model-check-button" disabled={busy || editing || monitorBusy} onClick={onCheckService}>
                <RefreshCw className={monitorBusy ? "spinning" : ""} size={15} />{monitorBusy ? "检测中…" : "立即检测"}
              </ActionButton>
            </div>
            <div className={`model-monitor-status ${monitor?.status || "unknown"}`}>
              <i /><div><strong>{monitor ? statusLabels[monitor.status] : "正在读取状态"}</strong><small>{monitor?.status_message || "正在获取最近的模型调用记录…"}</small></div>
              <span>{monitor?.last_event_at ? `更新于 ${formatTime(monitor.last_event_at)}` : "暂无调用"}</span>
            </div>
            <div className="model-monitor-metrics">
              <article><span>成功率 · 24h</span><strong>{monitor?.summary.success_rate == null ? "—" : `${monitor.summary.success_rate}%`}</strong><small>{monitor ? `${monitor.summary.successful_requests} / ${monitor.summary.total_requests} 次成功` : "等待数据"}</small></article>
              <article><span>P95 响应耗时</span><strong>{formatLatency(monitor?.summary.p95_latency_ms ?? null)}</strong><small>平均 {formatLatency(monitor?.summary.average_latency_ms ?? null)}</small></article>
              <article><span>超时次数</span><strong>{monitor?.summary.timeout_count ?? "—"}</strong><small>{monitor?.summary.consecutive_failures ? `当前连续失败 ${monitor.summary.consecutive_failures} 次` : "当前无连续失败"}</small></article>
              <article><span>当前服务</span><strong className="model-monitor-name">{monitor?.model_name || savedSettings.model_name || "—"}</strong><small>{monitor?.protocol_label || protocolLabel(monitor?.protocol || resolvedProtocol(savedSettings.model_name, savedSettings.model_protocol, savedSettings.model_base_url))} · {monitor?.base_url || "官方默认地址"}</small></article>
            </div>
            {monitor?.error_breakdown.length ? <div className="model-monitor-errors"><span>近 24 小时异常</span><div>{monitor.error_breakdown.map((item) => <em key={item.code}>{item.label} {item.count}</em>)}</div></div> : null}
            <div className="model-monitor-events">
              <div className="model-monitor-section-title"><strong>最近调用</strong><span>仅记录类型、状态、耗时和错误分类</span></div>
              {monitor?.recent_events.length ? (
                <div className="model-monitor-event-list">
                  {monitor.recent_events.slice(0, 6).map((event) => <div className={event.status} key={event.id}><i /><strong>{requestKindLabels[event.request_kind] || event.request_kind}{event.fallback_from_profile_id ? <em className="model-monitor-fallback">备用</em> : null}</strong><span>{event.status === "success" ? `${formatLatency(event.latency_ms)}${event.cost_usd != null ? ` · ${formatUsd(event.cost_usd)}` : ""}` : event.error_message || "调用失败"}</span><time>{formatTime(event.created_at)}</time></div>)}
                </div>
              ) : <div className="model-monitor-empty"><Activity size={20} /><span>还没有调用记录，点击“立即检测”生成第一条状态数据。</span></div>}
            </div>
          </section>
        </div>
    </>
  );
  return <section className="model-settings-page">{manager ? manager(<>{kernelSettings}{advancedContent}</>) : <>
    {kernelSettings}
    {mainContent}
    <details className="model-advanced-settings">
      <summary><strong>{purposeManager ? "高级规则" : "高级设置"}</strong><span>备用模型、自动分工与诊断</span><ChevronDown size={16} /></summary>
      {advancedContent}
    </details>
  </>}</section>;
}
