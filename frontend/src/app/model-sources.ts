import type { ModelCatalog, ModelConnection } from "../types";

export function isComposerModelConnectionAvailable(connection: ModelConnection) {
  return connection.enabled && (connection.auth_kind !== "chatgpt_subscription" || connection.credential_status === "available");
}

export function composerDefaultModelProfile(catalog: ModelCatalog) {
  const profileId = catalog.purpose_defaults?.chat || catalog.effective_execution_profile_id || catalog.default_profile_id;
  return catalog.profiles.find(item => item.id === profileId);
}

/** Legacy service preferences affect presentation, never the available sources. */
export function composerModelSources(catalog: ModelCatalog, selectedProfileId?: string | null) {
  const connections = catalog.connections.filter(isComposerModelConnectionAvailable);
  const selected = catalog.profiles.find(item => item.id === selectedProfileId);
  const preferred = selected || composerDefaultModelProfile(catalog);
  const connection = connections.find(item => item.id === preferred?.connection_id)
    || connections.find(item => item.id === catalog.service_connection_id)
    || connections[0];
  return { connections, connection };
}
