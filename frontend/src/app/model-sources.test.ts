import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "../types";
import { composerModelSources } from "./model-sources";

describe("composer model sources", () => {
  const catalog: ModelCatalog = {
    connections: ["text", "pictures", "offline"].map(id => ({ id, name: id, model_base_url: `https://${id}.test`, model_protocol: "auto", enabled: id !== "offline", api_key_configured: true, revision: 1 })),
    profiles: [{ id: "p1", connection_id: "text", model_name: "same", enabled: true, revision: 1 }, { id: "p2", connection_id: "pictures", model_name: "same", enabled: true, revision: 1 }],
    default_profile_id: "p1", service_connection_id: "text", purpose_defaults: { chat: "p1", image: "p2" }
  };
  it("shows all enabled services even when a legacy service preference exists", () => {
    expect(composerModelSources(catalog).connections.map(item => item.id)).toEqual(["text", "pictures"]);
  });
  it("uses the selected profile's service without merging same-name models", () => {
    expect(composerModelSources(catalog, "p2").connection?.id).toBe("pictures");
    expect(composerModelSources(catalog, "missing").connection?.id).toBe("text");
  });
});
