import { useEffect, useRef, useState } from "react";
import type { createApiClient } from "../api/client";
import { defaultAgentSettings } from "../constants";
import { useKernels } from "../features/chat/useKernels";
import { useModelCatalog } from "../features/settings/useModelCatalog";
import { useModelDiscovery } from "../features/settings/useModelDiscovery";
import type { RouteDataKey } from "../route-data";
import type { AgentCapabilities, AgentSettings, ModelCapabilityReport, ModelServiceCheck, ModelServiceMonitor } from "../types";

type ModelSaveReceipt = { committed: boolean; saved_revision: number | null; settings: AgentSettings };
function matchesModelConfiguration(result: { connection_id?: string; config_revision?: number }, saved: AgentSettings) {
  return (result.connection_id === undefined || saved.connection_id === undefined || result.connection_id === saved.connection_id)
    && (result.config_revision === undefined || saved.config_revision === undefined || result.config_revision === saved.config_revision);
}

type ModelRequestKind = "read" | "monitor" | "capabilities" | "check" | "save" | "serviceCapabilities";
type ModelSettingsScope = {
  client: ReturnType<typeof createApiClient>;
  account: string;
  active: boolean;
  epoch: number;
  requests: Record<ModelRequestKind, number>;
  controllers: Set<AbortController>;
};

function modelKeyOptional(settings: AgentSettings) {
  return settings.model_protocol === "ollama" || (settings.model_protocol === "auto" && /ollama|:11434(?:\/|$)/i.test(settings.model_base_url));
}

function normalizedModelAddress(value: string) {
  return value.trim().replace(/\/+$/, "");
}

type Options = {
  fetchJson: ReturnType<typeof createApiClient>;
  userEmail: string;
  modelCatalogEnabled: boolean;
  invalidateRouteData: (...keys: RouteDataKey[]) => void;
  setCapabilities: (capabilities: AgentCapabilities | null) => void;
  setModelUnavailable: (message: string | null) => void;
  setErrorMessage: (message: string) => void;
  setNoticeMessage: (message: string) => void;
};

/**
 * 管理当前账号的 Agent 配置、模型检测和默认内核写入。
 * @param options 当前账号、API 客户端及页面数据和反馈回调。
 * @returns 配置草稿、已保存配置、目录状态及其读写操作。
 */
export function useAgentPreferences({ fetchJson, userEmail, modelCatalogEnabled, invalidateRouteData, setCapabilities, setModelUnavailable, setErrorMessage, setNoticeMessage }: Options) {
  const kernels = useKernels(fetchJson);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(defaultAgentSettings);
  const [savedAgentSettings, setSavedAgentSettings] = useState<AgentSettings>(defaultAgentSettings);
  const savedAgentSettingsRef = useRef<AgentSettings>(defaultAgentSettings);
  const [modelSettingsLoaded, setModelSettingsLoaded] = useState(false);
  const [modelSettingsLoadError, setModelSettingsLoadError] = useState("");
  const [modelSaveUnknown, setModelSaveUnknown] = useState<string | null>(null);
  const modelSettingsScopeRef = useRef<ModelSettingsScope | null>(null);
  const modelSettingsStateScopeRef = useRef<ModelSettingsScope | null>(null);
  if (!modelSettingsScopeRef.current || modelSettingsScopeRef.current.client !== fetchJson || modelSettingsScopeRef.current.account !== userEmail) {
    const previous = modelSettingsScopeRef.current;
    if (previous) {
      previous.active = false;
      for (const controller of previous.controllers) controller.abort();
    }
    modelSettingsScopeRef.current = {
      client: fetchJson, account: userEmail, active: true, epoch: 0,
      requests: { read: 0, monitor: 0, capabilities: 0, check: 0, save: 0, serviceCapabilities: 0 },
      controllers: new Set()
    };
  }
  const modelSettingsScope = modelSettingsScopeRef.current;
  const modelSettingsReady = modelSettingsLoaded && modelSettingsStateScopeRef.current === modelSettingsScope;
  const [agentSettingsBusy, setAgentSettingsBusy] = useState(false);
  const [modelSettingsEditing, setModelSettingsEditing] = useState(false);
  const modelSettingsEditingRef = useRef(false);
  const [modelMonitor, setModelMonitor] = useState<ModelServiceMonitor | null>(null);
  const [modelMonitorBusy, setModelMonitorBusy] = useState(false);
  const { availableModels, discoveryBusy: modelDiscoveryBusy, discoveryError: modelDiscoveryError, discoverModels, invalidateDiscovery } = useModelDiscovery({
    fetchJson,
    onModelSuggested: (modelName) => {
      if (modelSettingsScopeRef.current !== modelSettingsScope || !modelSettingsScope.active) return;
      updateModelSettingsEditing(true);
      setAgentSettings((current) => current.model_name.trim() ? current : { ...current, model_name: modelName });
    },
    onNotice: setNoticeMessage
  });
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilityReport | null>(null);
  const [modelCapabilitiesBusy, setModelCapabilitiesBusy] = useState(false);
  const modelCatalog = useModelCatalog({
    fetchJson,
    scope: modelSettingsScope,
    enabled: modelCatalogEnabled,
    refreshKey: savedAgentSettings.config_revision
  });
  const defaultModelHasDraft = Boolean(agentSettings.api_key.trim()) || agentSettings.model_name !== savedAgentSettings.model_name
    || agentSettings.model_base_url !== savedAgentSettings.model_base_url || agentSettings.model_protocol !== savedAgentSettings.model_protocol;

  useEffect(() => {
    modelSettingsStateScopeRef.current = null;
    modelSettingsEditingRef.current = false;
    setModelSettingsLoaded(false);
    setModelSettingsLoadError("");
    setModelSaveUnknown(null);
    setAgentSettings({ ...defaultAgentSettings });
    savedAgentSettingsRef.current = { ...defaultAgentSettings };
    setSavedAgentSettings({ ...defaultAgentSettings });
    setAgentSettingsBusy(false);
    setModelSettingsEditing(false);
    setCapabilities(null);
    setModelMonitor(null);
    setModelMonitorBusy(false);
    setModelCapabilities(null);
    setModelCapabilitiesBusy(false);
    invalidateDiscovery();
    return () => {
      for (const controller of modelSettingsScope.controllers) controller.abort();
      modelSettingsScope.controllers.clear();
    };
  }, [modelSettingsScope]);

  function beginModelRequest(kind: ModelRequestKind) {
    const epoch = modelSettingsScope.epoch;
    const requestId = ++modelSettingsScope.requests[kind];
    const controller = new AbortController();
    modelSettingsScope.controllers.add(controller);
    return {
      signal: controller.signal,
      current: () => modelSettingsScope.active && modelSettingsScopeRef.current === modelSettingsScope
        && modelSettingsScope.epoch === epoch && modelSettingsScope.requests[kind] === requestId && !controller.signal.aborted,
      finish: () => modelSettingsScope.controllers.delete(controller)
    };
  }

  function invalidateModelRequests() {
    modelSettingsScope.epoch += 1;
    for (const controller of modelSettingsScope.controllers) controller.abort();
    modelSettingsScope.controllers.clear();
    setModelMonitorBusy(false);
    setModelCapabilitiesBusy(false);
  }

  function canDiscoverModels(settings: AgentSettings) {
    if (modelKeyOptional(settings)) return true;
    if (settings.api_key.trim()) return true;
    return settings.api_key_configured && normalizedModelAddress(settings.model_base_url) === normalizedModelAddress(savedAgentSettings.model_base_url);
  }

  function discoverCurrentModels(force = false) {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown) return;
    if (!canDiscoverModels(agentSettings)) {
      if (force) setErrorMessage("服务地址已更改，请先填写该服务的 API Key；模型名称也可手动填写。");
      return;
    }
    void discoverModels(agentSettings, { force, silent: !force });
  }

  async function refreshCapabilities() {
    const request = beginModelRequest("serviceCapabilities");
    try {
      const next = await fetchJson<AgentCapabilities>("/agent/capabilities", { signal: request.signal });
      if (request.current()) setCapabilities(next);
      return next;
    } catch (error) {
      if (request.current()) {
        setCapabilities(null);
        setErrorMessage(error instanceof Error ? `无法读取服务能力：${error.message}` : "无法读取服务能力");
      }
      return null;
    } finally { request.finish(); }
  }

  function updateModelSettingsEditing(next: boolean) {
    modelSettingsEditingRef.current = next;
    setModelSettingsEditing(next);
  }

  function applySavedModelSettings(next: AgentSettings, preserveDraft = false) {
    const clean = { ...next, api_key: "" };
    savedAgentSettingsRef.current = clean;
    setSavedAgentSettings(clean);
    modelSettingsStateScopeRef.current = modelSettingsScope;
    setModelSettingsLoaded(true);
    setModelSettingsLoadError("");
    if (preserveDraft || modelSettingsEditingRef.current) return clean;
    setAgentSettings(clean);
    const keyOptional = modelKeyOptional(next);
    updateModelSettingsEditing(!next.api_key_configured && !keyOptional);
    if ((next.api_key_configured || keyOptional) && next.credential_status !== "saved_unverified") void discoverModels(clean, { silent: true });
    return clean;
  }

  async function refreshAgentSettings(options: { preserveDraft?: boolean } = {}) {
    const request = beginModelRequest("read");
    try {
      const next = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
      if (request.current()) applySavedModelSettings(next, options.preserveDraft);
      return next;
    } catch (error) {
      if (!request.current()) return null;
      setModelSettingsLoadError(error instanceof Error ? error.message : "读取模型配置失败");
      throw error;
    } finally { request.finish(); }
  }

  async function refreshModelMonitor() {
    const request = beginModelRequest("monitor");
    try {
      const next = await fetchJson<ModelServiceMonitor>("/agent/model-monitor?hours=24", { signal: request.signal });
      if (request.current() && matchesModelConfiguration(next, savedAgentSettingsRef.current)) setModelMonitor(next);
      return next;
    } catch (error) {
      if (request.current()) throw error;
      return null;
    } finally { request.finish(); }
  }

  async function refreshModelCapabilities(probe = false) {
    const request = beginModelRequest("capabilities");
    setModelCapabilitiesBusy(true);
    try {
      const next = probe
        ? await fetchJson<ModelCapabilityReport>("/agent/models/capabilities", {
          method: "POST", signal: request.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_name: savedAgentSettings.model_name, model_base_url: savedAgentSettings.model_base_url,
            model_protocol: savedAgentSettings.model_protocol, api_key: "", probe: true
          })
        })
        : await fetchJson<ModelCapabilityReport>("/agent/models/capabilities", { signal: request.signal });
      if (!request.current() || !matchesModelConfiguration(next, savedAgentSettingsRef.current)) return null;
      setModelCapabilities(next);
      if (probe && next.probe_error) setErrorMessage(next.probe_error);
      else if (probe) setNoticeMessage(next.vision.source === "probe" ? "已完成能力检测" : "已读取模型能力");
      return next;
    } catch (error) {
      if (request.current()) setErrorMessage(error instanceof Error ? `模型能力检测失败：${error.message}` : "模型能力检测失败");
      return null;
    } finally {
      if (request.current()) setModelCapabilitiesBusy(false);
      request.finish();
    }
  }

  async function checkModelService(afterSave = false) {
    const request = beginModelRequest("check");
    // An older polling response must not overwrite the active check result.
    modelSettingsScope.requests.monitor += 1;
    setModelMonitorBusy(true);
    if (!afterSave) setErrorMessage("");
    try {
      const next = await fetchJson<ModelServiceCheck>("/agent/model-monitor/check", { method: "POST", signal: request.signal });
      if (!request.current() || !matchesModelConfiguration(next, savedAgentSettingsRef.current)) return;
      modelSettingsScope.requests.monitor += 1;
      setModelMonitor(next);
      if (next.available) {
        setModelUnavailable(null);
        setNoticeMessage(afterSave ? "设置已保存，连接检测成功" : "连接检测成功");
      } else setErrorMessage(`${afterSave ? "配置已保存，但连接检测失败：" : ""}${next.check_error_message || "模型连接检测失败"}`);
    } catch (error) {
      if (request.current()) setErrorMessage(`${afterSave ? "配置已保存，但连接检测失败：" : ""}${error instanceof Error ? error.message : "模型服务检测失败"}`);
    } finally {
      if (request.current()) setModelMonitorBusy(false);
      request.finish();
    }
  }

  function changeModelSettings(next: AgentSettings) {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown) return;
    if (normalizedModelAddress(next.model_base_url) !== normalizedModelAddress(agentSettings.model_base_url)) next = { ...next, api_key: "" };
    const connectionChanged = next.model_base_url !== agentSettings.model_base_url
      || next.api_key !== agentSettings.api_key || next.model_protocol !== agentSettings.model_protocol;
    if (connectionChanged) invalidateDiscovery();
    else if (next.model_name !== agentSettings.model_name) invalidateDiscovery({ keepModels: true });
    updateModelSettingsEditing(true);
    setAgentSettings(next);
  }

  function beginModelSettingsEdit() {
    if (modelSettingsReady && !agentSettingsBusy && !modelSaveUnknown) updateModelSettingsEditing(true);
  }

  function cancelModelSettingsEdit() {
    setAgentSettings({ ...savedAgentSettings, api_key: "" });
    setModelSaveUnknown(null);
    updateModelSettingsEditing(false);
    invalidateDiscovery();
    if ((savedAgentSettings.api_key_configured || modelKeyOptional(savedAgentSettings)) && savedAgentSettings.credential_status !== "saved_unverified") {
      void discoverModels(savedAgentSettings, { silent: true });
    }
  }

  function completeModelSave(saved: AgentSettings) {
    invalidateModelRequests();
    const clean = { ...saved, api_key: "" };
    setAgentSettings(clean);
    savedAgentSettingsRef.current = clean;
    setSavedAgentSettings(clean);
    modelSettingsStateScopeRef.current = modelSettingsScope;
    setModelSettingsLoaded(true);
    setModelSaveUnknown(null);
    updateModelSettingsEditing(false);
    setAgentSettingsBusy(false);
    setModelMonitor(null);
    setModelCapabilities(null);
    invalidateDiscovery();
    invalidateRouteData("agentSettings", "modelMonitor", "modelCapabilities", "capabilities");
    setNoticeMessage("设置已保存，正在检测连接");
    void checkModelService(true);
    void refreshCapabilities();
    void refreshModelCapabilities();
    if (clean.api_key_configured || modelKeyOptional(clean)) {
      void discoverModels(clean, { silent: true, force: true });
    }
  }

  async function reconcileModelSave(requestId: string, request: ReturnType<typeof beginModelRequest>) {
    const current = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
    if (!request.current()) return;
    if (current.last_save_request_id === requestId) {
      completeModelSave(current);
      return;
    }
    const receipt = await fetchJson<ModelSaveReceipt>(`/agent/settings/requests/${encodeURIComponent(requestId)}`, { signal: request.signal });
    if (!request.current()) return;
    if (receipt.committed) {
      const superseded = receipt.saved_revision !== null && (receipt.settings.config_revision ?? 0) > receipt.saved_revision;
      completeModelSave(receipt.settings);
      if (superseded) setErrorMessage("此前保存已提交，当前配置已由后续更新覆盖。当前显示服务端最新配置。");
    } else {
      applySavedModelSettings(receipt.settings, true);
      setErrorMessage("暂无法确认上次保存结果，请稍后重新确认；也可读取最新配置后继续编辑。");
    }
  }

  async function confirmModelSave(requestId = modelSaveUnknown) {
    if (!requestId || agentSettingsBusy) return;
    const request = beginModelRequest("save");
    setAgentSettingsBusy(true);
    try { await reconcileModelSave(requestId, request); }
    catch {
      if (request.current()) setErrorMessage("暂无法确认上次保存结果，请检查连接后重新确认。");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function resumeModelEditing() {
    if (!modelSaveUnknown || agentSettingsBusy) return;
    const request = beginModelRequest("save");
    setAgentSettingsBusy(true);
    try {
      const latest = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
      if (!request.current()) return;
      applySavedModelSettings(latest, true);
      setModelSaveUnknown(null);
      updateModelSettingsEditing(true);
      invalidateDiscovery();
      setErrorMessage("");
      setNoticeMessage("已读取最新配置，可以继续编辑；再次保存会检查版本冲突，上次提交仍可能稍后完成。");
    } catch {
      if (request.current()) setErrorMessage("读取最新配置失败，暂时保留待确认状态。");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function saveAgentPreferences() {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown || !agentSettings.model_name.trim()) return;
    if (!canDiscoverModels(agentSettings) && normalizedModelAddress(agentSettings.model_base_url) !== normalizedModelAddress(savedAgentSettings.model_base_url)) {
      setErrorMessage("服务地址已更改，请填写该服务的 API Key 后再保存。");
      return;
    }
    if (agentSettings.api_key.trim() && savedAgentSettings.secret_storage_writable === false) {
      setErrorMessage(savedAgentSettings.secret_storage === "environment"
        ? "当前部署使用只读环境密钥，请由服务部署配置更新凭证。"
        : "本机密钥存储暂不可写，请修复系统钥匙串后再保存密钥。");
      return;
    }
    invalidateModelRequests();
    invalidateDiscovery();
    const request = beginModelRequest("save");
    const requestId = crypto.randomUUID();
    setAgentSettingsBusy(true);
    setErrorMessage("");
    try {
      const saved = await fetchJson<AgentSettings>("/agent/settings", {
        method: "PUT", signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...savedAgentSettings, model_name: agentSettings.model_name, model_base_url: agentSettings.model_base_url,
          model_protocol: agentSettings.model_protocol, api_key: agentSettings.api_key,
          expected_revision: savedAgentSettings.config_revision, request_id: requestId
        })
      });
      if (request.current()) completeModelSave(saved);
    } catch (error) {
      if (!request.current()) return;
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
      if (status === 409) {
        setErrorMessage("配置已在其他页面更新。已读取最新版本，当前修改保留，请检查后重新保存。");
        await refreshAgentSettings({ preserveDraft: true }).catch(() => undefined);
      } else if (status === null || status >= 500 || status === 408) {
        setModelSaveUnknown(requestId);
        setErrorMessage("保存结果暂未确认，正在读取服务端状态；不会自动重复提交。");
        try { await reconcileModelSave(requestId, request); }
        catch { /* Keep the request receipt pending until the user can reconnect. */ }
      } else setErrorMessage(error instanceof Error ? error.message : "保存模型设置失败");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function changeDefaultKernel(kernel: "tuantuan" | "dsh") {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown || modelSettingsEditing) return;
    if (!kernels.catalog?.choices.find((choice) => choice.id === kernel && choice.available)) return;
    const request = beginModelRequest("save");
    setAgentSettingsBusy(true);
    setErrorMessage("");
    try {
      const saved = await fetchJson<AgentSettings>("/agent/settings", {
        method: "PUT",
        signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...savedAgentSettings,
          default_kernel: kernel,
          expected_revision: savedAgentSettings.config_revision,
          request_id: crypto.randomUUID()
        })
      });
      if (!request.current()) return;
      applySavedModelSettings(saved);
      invalidateRouteData("agentSettings");
      await kernels.refresh();
      if (request.current()) {
        setNoticeMessage(kernel === "dsh" ? "新对话默认使用 DeepSeek Harness" : "新对话默认使用团团内核");
      }
    } catch (error) {
      if (!request.current()) return;
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
      if (status === 409) {
        setErrorMessage("设置已在其他页面更新，请重新读取后再试。");
        await refreshAgentSettings().catch(() => undefined);
      } else {
        setErrorMessage(error instanceof Error ? error.message : "保存默认内核失败");
      }
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function refreshChatGPTSubscription() {
    invalidateRouteData("agentSettings", "modelMonitor", "modelCapabilities", "capabilities");
    await Promise.all([refreshAgentSettings({ preserveDraft: true }), modelCatalog.reload({ strict: true })]);
  }

  async function refreshDefaultModelSelection() {
    invalidateModelRequests();
    invalidateDiscovery();
    updateModelSettingsEditing(false);
    setModelMonitor(null);
    setModelCapabilities(null);
    invalidateRouteData("agentSettings", "modelMonitor", "modelCapabilities", "capabilities");
    try { await refreshAgentSettings(); }
    catch { setErrorMessage("默认模型已更新，但读取最新配置失败，请重新读取配置。"); return; }
    void refreshModelMonitor().catch(() => undefined);
    void refreshModelCapabilities();
    void refreshCapabilities();
  }

  function retryAgentSettings() {
    setModelSettingsLoadError("");
    invalidateRouteData("agentSettings");
    void refreshAgentSettings().catch(() => undefined);
  }

  return {
    modelSettingsScope, modelSettingsReady, modelSettingsLoadError, modelSettingsEditing, modelSaveUnknown,
    agentSettings, savedAgentSettings, agentSettingsBusy, defaultModelHasDraft,
    modelMonitor, modelMonitorBusy, modelCapabilities, modelCapabilitiesBusy,
    availableModels, modelDiscoveryBusy, modelDiscoveryError, modelCatalog, kernels, changeDefaultKernel,
    refreshAgentSettings, refreshModelMonitor, refreshModelCapabilities, refreshCapabilities, retryAgentSettings,
    refreshChatGPTSubscription, refreshDefaultModelSelection, confirmModelSave, resumeModelEditing,
    discoverCurrentModels, changeModelSettings, beginModelSettingsEdit, cancelModelSettingsEdit, saveAgentPreferences, checkModelService
  };
}
