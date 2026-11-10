import { useCallback, useEffect, useRef, useState } from "react";
import type { createApiClient } from "../../api/client";
import type { ModelConnection, ModelProfile } from "../../types";
import { ComposerModelParameters } from "../chat/ComposerModelParameters";
import { ModelOutputSettings } from "./ModelOutputSettings";
import { ModelProfileCapabilities } from "./ModelProfileCapabilities";
import { UnifiedModelParameters } from "./UnifiedModelParameters";
import type { UnifiedModelManagerProps } from "./UnifiedModelManager";

export function UnifiedModelInspector({ profile, connection, fetchJson, busy, error, onMutate, onClose, openCapabilities = false, readOnly = false, onDirtyChange, onSavingChange }: {
  profile: ModelProfile; connection?: ModelConnection; fetchJson: ReturnType<typeof createApiClient>; busy: boolean; error: string;
  onMutate: UnifiedModelManagerProps["onMutate"]; onClose: () => void; openCapabilities?: boolean; readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void;
}) {
  const [showCapabilities, setShowCapabilities] = useState(openCapabilities);
  const [capabilitiesMounted, setCapabilitiesMounted] = useState(openCapabilities);
  const [dirty, setDirty] = useState({ thinking: false, parameters: false, capabilities: false, probe: false });
  const [saving, setSaving] = useState({ thinking: false, parameters: false, capabilities: false, probe: false });
  const thinkingDirty = useCallback((value: boolean) => setDirty(current => ({ ...current, thinking: value })), []);
  const parametersDirty = useCallback((value: boolean) => setDirty(current => ({ ...current, parameters: value })), []);
  const capabilitiesDirty = useCallback((value: boolean) => setDirty(current => ({ ...current, capabilities: value })), []);
  const thinkingSaving = useCallback((value: boolean) => setSaving(current => ({ ...current, thinking: value })), []);
  const parametersSaving = useCallback((value: boolean) => setSaving(current => ({ ...current, parameters: value })), []);
  const capabilitiesSaving = useCallback((value: boolean) => setSaving(current => ({ ...current, capabilities: value })), []);
  const probeSaving = useCallback((value: boolean) => setSaving(current => ({ ...current, probe: value })), []);
  const hasDirty = Object.values(dirty).some(Boolean);
  const isSaving = Object.values(saving).some(Boolean);
  const viewOnly = readOnly || !profile.enabled;
  const locked = busy || isSaving;
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.scrollIntoView?.({ block: "nearest" }); root.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (openCapabilities) { setShowCapabilities(true); setCapabilitiesMounted(true); } }, [openCapabilities]);
  useEffect(() => { onDirtyChange?.(hasDirty); }, [hasDirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(isSaving); }, [isSaving, onSavingChange]);
  return <section ref={root} tabIndex={-1} className="unified-inspector" aria-label={`${profile.model_name} 参数设置`}>
    <div className="unified-directory-heading"><div><h3>{profile.model_name}</h3><p>{connection?.name} · {viewOnly ? "只读预览，不会启用模型或修改设置。" : "参数按模型保存，从后续请求生效。"}</p></div><button type="button" disabled={isSaving} onClick={onClose}>收起参数</button></div>
    <ComposerModelParameters disabled={locked} readOnly={viewOnly} onDirtyChange={thinkingDirty} onSavingChange={thinkingSaving} settings={{ profile, protocol: connection?.detected_protocol || connection?.model_protocol, fetchJson, error,
      onSave: (id, revision, update) => onMutate(`/agent/model-profiles/${encodeURIComponent(id)}`, "PATCH", { ...update, expected_revision: revision }) }} />
    <UnifiedModelParameters profile={profile} busy={locked} readOnly={viewOnly} onDirtyChange={parametersDirty} onSavingChange={parametersSaving} onSave={update => onMutate(`/agent/model-profiles/${encodeURIComponent(profile.id)}`, "PATCH", { ...update, expected_revision: profile.revision })} />
    <details className="unified-capability-details" open={showCapabilities} onToggle={event => { const open = event.currentTarget.open; setShowCapabilities(open); if (open) setCapabilitiesMounted(true); }}><summary>高级能力与上下文</summary>
      {capabilitiesMounted ? <><ModelOutputSettings profile={profile} busy={locked} readOnly={viewOnly} onDirtyChange={capabilitiesDirty} onSavingChange={capabilitiesSaving} onSave={capabilities => onMutate(`/agent/model-profiles/${encodeURIComponent(profile.id)}`, "PATCH", { capabilities: { ...profile.capabilities, ...capabilities }, expected_revision: profile.revision })} />{!viewOnly ? <ModelProfileCapabilities profileId={profile.id} modelName={profile.model_name} fetchJson={fetchJson} disabled={locked} onSavingChange={probeSaving} /> : null}</> : null}
    </details>
  </section>;
}
