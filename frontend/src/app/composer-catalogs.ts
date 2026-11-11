import type { ModelProfile } from "../types";
import type { ServiceModelCatalog } from "../features/chat/types";

/** Keep saved models available until a service directory has been read. */
export function composerCatalogsWithSavedModels(catalogs: ServiceModelCatalog[], profiles: ModelProfile[], currentProfileId?: string | null): ServiceModelCatalog[] {
  return catalogs.map(service => {
    const serviceProfiles = profiles.filter(profile => profile.connection_id === service.connection_id);
    const enabled = serviceProfiles.filter(profile => profile.enabled);
    const models = service.models.filter(name => !serviceProfiles.some(profile => profile.model_name === name && !profile.enabled) || enabled.some(profile => profile.model_name === name));
    // Keep the current selection visible even if it disappeared from the latest
    // directory; never silently offer other removed models as current results.
    const savedOnly = enabled.filter(profile => (!service.source || profile.id === currentProfileId) && !models.includes(profile.model_name)).map(profile => profile.model_name);
    return { ...service, models, savedOnly: Array.from(new Set(savedOnly)) };
  });
}
