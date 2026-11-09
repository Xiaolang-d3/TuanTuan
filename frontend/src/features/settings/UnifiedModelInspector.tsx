import { useEffect, useRef, useState } from "react";
import type { createApiClient } from "../../api/client";
import type { ModelConnection, ModelProfile } from "../../types";
import { ComposerModelParameters } from "../chat/ComposerModelParameters";
import { ModelOutputSettings } from "./ModelOutputSettings";
import { ModelProfileCapabilities } from "./ModelProfileCapabilities";
import { UnifiedModelParameters } from "./UnifiedModelParameters";
import type { UnifiedModelManagerProps } from "./UnifiedModelManager";

export function UnifiedModelInspector({ profile, connection, fetchJson, busy, error, onMutate, onClose }: {
  profile: ModelProfile; connection?: ModelConnection; fetchJson: ReturnType<typeof createApiClient>; busy: boolean; error: string;
  onMutate: UnifiedModelManagerProps["onMutate"]; onClose: () => void;
}) {
  const [showCapabilities, setShowCapabilities] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.scrollIntoView?.({ block: "nearest" }); root.current?.focus({ preventScroll: true }); }, []);
  return <section ref={root} tabIndex={-1} className="unified-inspector" aria-label={`${profile.model_name} 参数设置`}>
    <div className="unified-directory-heading"><div><h3>{profile.model_name}</h3><p>{connection?.name} · 参数按模型保存，从后续请求生效。</p></div><button type="button" onClick={onClose}>收起参数</button></div>
    <ComposerModelParameters disabled={busy} settings={{ profile, protocol: connection?.detected_protocol || connection?.model_protocol, fetchJson, error,
      onSave: (id, revision, update) => onMutate(`/agent/model-profiles/${encodeURIComponent(id)}`, "PATCH", { ...update, expected_revision: revision }) }} />
    <UnifiedModelParameters profile={profile} busy={busy} onSave={update => onMutate(`/agent/model-profiles/${encodeURIComponent(profile.id)}`, "PATCH", { ...update, expected_revision: profile.revision })} />
    <details className="unified-capability-details" onToggle={event => setShowCapabilities(event.currentTarget.open)}><summary>高级能力与上下文</summary>
      {showCapabilities ? <><ModelOutputSettings profile={profile} busy={busy} onSave={capabilities => onMutate(`/agent/model-profiles/${encodeURIComponent(profile.id)}`, "PATCH", { capabilities: { ...profile.capabilities, ...capabilities }, expected_revision: profile.revision })} /><ModelProfileCapabilities profileId={profile.id} modelName={profile.model_name} fetchJson={fetchJson} disabled={busy} /></> : null}
    </details>
  </section>;
}
