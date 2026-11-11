import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../types";
import type { ServiceModelCatalog } from "../features/chat/types";
import { composerCatalogsWithSavedModels } from "./composer-catalogs";

const profiles: ModelProfile[] = [
  { id: "current", connection_id: "one", model_name: "model-a", enabled: true, revision: 1 },
  { id: "saved", connection_id: "one", model_name: "model-b", enabled: true, revision: 1 },
  { id: "disabled", connection_id: "one", model_name: "disabled", enabled: false, revision: 1 },
  { id: "other", connection_id: "two", model_name: "model-b", enabled: true, revision: 1 }
];
const service: ServiceModelCatalog = { connection_id: "one", connection_name: "服务一", revision: 1, models: [], busy: false, error: "" };

describe("composerCatalogsWithSavedModels", () => {
  it("falls back only to enabled saved profiles from the same service before a directory is known", () => {
    const [result] = composerCatalogsWithSavedModels([service], profiles, "current");
    expect(result.models).toEqual([]);
    expect(result.savedOnly).toEqual(["model-a", "model-b"]);
  });
  it("filters disabled models and retains only a missing current selection after loading", () => {
    const [result] = composerCatalogsWithSavedModels([{ ...service, source: "cache", models: ["disabled", "new-model"] }], profiles, "current");
    expect(result.models).toEqual(["new-model"]);
    expect(result.savedOnly).toEqual(["model-a"]);
    expect(composerCatalogsWithSavedModels([{ ...service, source: "live", models: ["model-a"] }], profiles, "current")[0].savedOnly).toEqual([]);
  });
  it("allows an enabled duplicate without reviving the disabled profile", () => {
    const duplicate = { id: "enabled-copy", connection_id: "one", model_name: "disabled", enabled: true, revision: 1 };
    expect(composerCatalogsWithSavedModels([{ ...service, source: "live", models: ["disabled"] }], [...profiles, duplicate])[0].models).toEqual(["disabled"]);
  });
});
