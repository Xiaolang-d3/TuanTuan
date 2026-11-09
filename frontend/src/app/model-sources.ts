import type { ModelCatalog } from "../types";

/** Legacy service preferences affect presentation, never the available sources. */
export function composerModelSources(catalog: ModelCatalog, selectedProfileId?: string | null) {
  const connections = catalog.connections.filter(item => item.enabled);
  const selected = catalog.profiles.find(item => item.id === selectedProfileId);
  const preferred = selected || catalog.profiles.find(item => item.id === (catalog.purpose_defaults?.chat || catalog.effective_execution_profile_id || catalog.default_profile_id));
  const connection = connections.find(item => item.id === preferred?.connection_id)
    || connections.find(item => item.id === catalog.service_connection_id)
    || connections[0];
  return { connections, connection };
}
