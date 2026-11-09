import type { PresentationService } from "./presentation-service";

type PresentationDraft = { topic: string; pages: number; key: string; open: boolean; retry?: { id: string; revision: number; uncertain: boolean } };
// Service identity scopes drafts to this authenticated backend connection.
// Keep prompts in memory only; a new login or a full reload starts fresh.
const stores = new WeakMap<PresentationService, Map<number, PresentationDraft>>();

export function presentationDrafts(service: PresentationService) {
  let store = stores.get(service);
  if (!store) { store = new Map(); stores.set(service, store); }
  return store;
}
