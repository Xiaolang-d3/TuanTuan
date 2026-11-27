import { lazy } from "react";
import type { createApiClient } from "../api/client";
import { PageLoading } from "../components/PageLoading";
import { AgentKernelSettings } from "../features/settings/AgentKernelSettings";
import type { useAgentPreferences } from "./useAgentPreferences";

const ModelConnectionManager = lazy(() => import("../features/settings/ModelConnectionManager").then((module) => ({ default: module.ModelConnectionManager })));
const UnifiedModelManager = lazy(() => import("../features/settings/UnifiedModelManager").then((module) => ({ default: module.UnifiedModelManager })));
const ChatGPTSubscriptionSettings = lazy(() => import("../features/settings/ChatGPTSubscriptionSettings").then((module) => ({ default: module.ChatGPTSubscriptionSettings })));
const ModelRoutingPanel = lazy(() => import("../features/settings/ModelRoutingPanel").then((module) => ({ default: module.ModelRoutingPanel })));
const ModelFallbackSettings = lazy(() => import("../features/settings/ModelFallbackSettings").then((module) => ({ default: module.ModelFallbackSettings })));
const ModelUsageRules = lazy(() => import("../features/settings/ModelUsageRules").then((module) => ({ default: module.ModelUsageRules })));

const ModelSettingsPage = lazy(() => import("../features/settings/ModelSettingsPage").then((module) => ({
  default: module.ModelSettingsPage
})));

type Props = {
  preferences: ReturnType<typeof useAgentPreferences>;
  fetchJson: ReturnType<typeof createApiClient>;
  userEmail: string;
  purpose?: "image";
  errorMessage: string;
};

/**
 * 组装模型设置路由中的管理面板、内核设置与读取反馈。
 * @param props 当前账号的配置状态以及进入页面时选中的用途。
 * @returns 模型设置页面、读取状态或重试提示。
 */
export function ModelSettingsRoute({ preferences, fetchJson, userEmail, purpose, errorMessage }: Props) {
  const {
    modelSettingsReady, modelSettingsLoadError, modelSettingsEditing, modelSaveUnknown,
    agentSettings, savedAgentSettings, agentSettingsBusy, defaultModelHasDraft,
    modelMonitor, modelMonitorBusy, modelCapabilities, modelCapabilitiesBusy,
    availableModels, modelDiscoveryBusy, modelDiscoveryError, modelCatalog, kernels, changeDefaultKernel,
    refreshModelCapabilities, retryAgentSettings, refreshChatGPTSubscription, refreshDefaultModelSelection,
    confirmModelSave, resumeModelEditing, discoverCurrentModels, changeModelSettings, beginModelSettingsEdit,
    cancelModelSettingsEdit, saveAgentPreferences, checkModelService
  } = preferences;

  if (!modelSettingsReady) {
    return modelSettingsLoadError ? (
      <section className="settings-card model-settings-card" role="alert">
        <h3>无法读取模型配置</h3><p>请检查本地服务后重试。读取成功前不会提交默认配置。</p>
        <button type="button" onClick={retryAgentSettings}>重新读取</button>
      </section>
    ) : <PageLoading label="正在读取模型配置…" />;
  }

  return (
    <ModelSettingsPage
      fetchJson={fetchJson}
      kernelSettings={<AgentKernelSettings
        choices={kernels.catalog?.choices ?? []}
        defaultKernel={savedAgentSettings.default_kernel}
        busy={agentSettingsBusy || modelSettingsEditing || Boolean(modelSaveUnknown) || kernels.busy}
        onChange={(kernel) => { void changeDefaultKernel(kernel); }}
      />}
      manager={modelCatalog.catalog.purpose_defaults ? advanced => <UnifiedModelManager
        key={`${userEmail}:${purpose ?? "overview"}`} catalog={modelCatalog.catalog} loading={modelCatalog.loading}
        busy={modelCatalog.busy || agentSettingsBusy || Boolean(modelSaveUnknown)} error={modelCatalog.error}
        fetchJson={fetchJson} secretWritable={savedAgentSettings.secret_storage_writable}
        onReload={modelCatalog.reload} onMutate={modelCatalog.mutate} onEnsureProfile={modelCatalog.ensureProfile}
        onApplied={refreshDefaultModelSelection} advanced={advanced} initialPurpose={purpose}
        additionalConnectionActions={<ChatGPTSubscriptionSettings fetchJson={fetchJson} onChanged={refreshChatGPTSubscription}
          disabled={modelCatalog.busy || agentSettingsBusy || Boolean(modelSaveUnknown)} />}
      /> : undefined}
      error={errorMessage}
      purposeManager={modelCatalog.catalog.purpose_defaults ? <ModelUsageRules catalog={modelCatalog.catalog} busy={modelCatalog.busy || agentSettingsBusy} loading={modelCatalog.loading} onMutate={modelCatalog.mutate} onApplied={refreshDefaultModelSelection} /> : modelCatalog.loading && !modelCatalog.loaded ? <p role="status">正在读取使用规则…</p> : undefined}
      routingManager={<><ModelFallbackSettings fetchJson={fetchJson} catalog={modelCatalog.catalog} busy={modelCatalog.busy || agentSettingsBusy} /><ModelRoutingPanel key={userEmail} fetchJson={fetchJson} catalog={modelCatalog.catalog}
        disabled={agentSettingsBusy || modelCatalog.busy || Boolean(modelSaveUnknown)}
        onApplied={async () => { await modelCatalog.reload(); await refreshDefaultModelSelection(); }} /></>}
      connectionManager={<ModelConnectionManager
        singleService
        fetchJson={fetchJson} catalog={modelCatalog.catalog} loading={modelCatalog.loading}
        busy={modelCatalog.busy || agentSettingsBusy} error={modelCatalog.error}
        secretWritable={savedAgentSettings.secret_storage_writable}
        defaultLocked={defaultModelHasDraft || Boolean(modelSaveUnknown)}
        onReload={modelCatalog.reload} onMutate={modelCatalog.mutate} onEnsureProfile={modelCatalog.ensureProfile}
        onDefaultChanged={refreshDefaultModelSelection}
        additionalConnectionActions={<ChatGPTSubscriptionSettings fetchJson={fetchJson} onChanged={refreshChatGPTSubscription}
          disabled={modelCatalog.busy || agentSettingsBusy || Boolean(modelSaveUnknown)} />}
      />}
      settings={agentSettings}
      savedSettings={savedAgentSettings}
      editing={modelSettingsEditing}
      busy={agentSettingsBusy || modelCatalog.busy}
      saveUnknown={Boolean(modelSaveUnknown)}
      onConfirmSave={() => void confirmModelSave()}
      onResumeEditing={() => void resumeModelEditing()}
      monitor={modelMonitor}
      monitorBusy={modelMonitorBusy}
      availableModels={availableModels}
      discoveryBusy={modelDiscoveryBusy}
      discoveryError={modelDiscoveryError}
      capabilities={modelCapabilities}
      capabilitiesBusy={modelCapabilitiesBusy}
      onSettingsChange={changeModelSettings}
      onDiscoverModels={discoverCurrentModels}
      onCheckService={() => void checkModelService()}
      onProbeCapabilities={() => void refreshModelCapabilities(true)}
      onBeginEdit={beginModelSettingsEdit}
      onCancelEdit={cancelModelSettingsEdit}
      onSave={() => void saveAgentPreferences()}
    />
  );
}
