import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { createApiClient } from "../api/client";
import type { Conversation } from "../types";
import { useConversationModels } from "./useConversationModels";

vi.mock("../features/chat/useComposerModelDiscovery", () => ({
  useComposerModelDiscovery: () => ({ catalogs: [], discover: vi.fn() })
}));

afterEach(cleanup);

it("ignores a model write from the former account when both accounts have the same conversation ID", async () => {
  const conversation: Conversation = { id: 7, title: "对话", status: "active", summary: "", updated_at: "", model_profile_id: null };
  const profile = { id: "chat", connection_id: "service", model_name: "对话模型", enabled: true, revision: 1 };
  const modelCatalog = {
    catalog: {
      profiles: [profile], default_profile_id: null,
      connections: [{ id: "service", name: "服务", model_base_url: "https://models.example.test/v1", model_protocol: "openai" as const, api_key_configured: true, enabled: true, revision: 1 }]
    },
    busy: false, loaded: true, loading: false, error: "", reload: vi.fn(), mutate: vi.fn(), ensureProfile: vi.fn()
  };
  let resolveFormerWrite!: (value: Conversation) => void;
  const formerWrite = new Promise<Conversation>(resolve => { resolveFormerWrite = resolve; });
  const fetchJson = vi.fn<ReturnType<typeof createApiClient>>().mockReturnValueOnce(formerWrite).mockResolvedValueOnce(conversation);
  const setConversations = vi.fn<Dispatch<SetStateAction<Conversation[]>>>();
  const invalidateConversationReads = vi.fn();
  const { result, rerender } = renderHook(({ scope }) => useConversationModels({
    fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>,
    scope, conversation, currentConversationId: conversation.id, currentConversationIdRef: { current: conversation.id },
    modelCatalog, capabilities: null, savedModelName: "尚未配置", chatBusy: false,
    invalidateConversationReads, setConversations, setModelUnavailable: vi.fn(), setNoticeMessage: vi.fn()
  }), { initialProps: { scope: "former-account" } });

  let selecting!: Promise<void>;
  act(() => { selecting = result.current.selectConversationModel(profile.id); });
  const [resource, request] = fetchJson.mock.calls[0];
  expect(resource).toBe("/conversations/7");
  expect(request).toMatchObject({ method: "PATCH", body: JSON.stringify({ model_profile_id: profile.id }) });
  expect(result.current.modelSelectionBusy).toBe(true);

  rerender({ scope: "current-account" });
  expect(request?.signal?.aborted).toBe(true);
  await act(async () => { resolveFormerWrite(conversation); await selecting; });
  expect(setConversations).not.toHaveBeenCalled();
  expect(invalidateConversationReads).not.toHaveBeenCalled();
  expect(result.current.modelSelectionFeedback).toBeNull();
  expect(result.current.modelSelectionBusy).toBe(false);

  await act(() => result.current.selectConversationModel(profile.id));
  expect(invalidateConversationReads).toHaveBeenCalledOnce();
  expect(setConversations).toHaveBeenCalledOnce();
  const [update] = setConversations.mock.calls[0];
  expect(typeof update === "function" ? update([conversation]) : update).toEqual([{ ...conversation, model_profile_id: profile.id }]);
  expect(result.current.modelSelectionFeedback).toMatchObject({ kind: "success" });
});

function setupDraft() {
  const profile = { id: "saved", connection_id: "service", model_name: "对话模型", enabled: true, revision: 1 };
  const modelCatalog = {
    catalog: { profiles: [profile], default_profile_id: "saved", connections: [{ id: "service", name: "服务", model_base_url: "https://models.example.test/v1", model_protocol: "openai" as const, api_key_configured: true, enabled: true, revision: 1 }] },
    busy: false, loaded: true, loading: false, error: "", reload: vi.fn(), mutate: vi.fn(), ensureProfile: vi.fn(),
  };
  const fetchJson = vi.fn();
  const onChange = vi.fn();
  const setConversations = vi.fn();
  const hook = renderHook(({ draft, scope }) => useConversationModels({
    fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>, scope,
    conversation: null, currentConversationId: 7, currentConversationIdRef: { current: 7 },
    modelCatalog, capabilities: null, savedModelName: "", chatBusy: false,
    draftSelection: draft ? { profileId: null, onChange } : undefined,
    invalidateConversationReads: vi.fn(), setConversations, setModelUnavailable: vi.fn(), setNoticeMessage: vi.fn(),
  }), { initialProps: { draft: true, scope: "account-a" } });
  return { ...hook, fetchJson, onChange, setConversations, modelCatalog };
}

it("selects a saved model for the home draft without changing the existing conversation", async () => {
  const { result, onChange, fetchJson, setConversations } = setupDraft();
  await act(() => result.current.selectConversationModel("saved"));
  expect(onChange).toHaveBeenCalledWith("saved");
  expect(fetchJson).not.toHaveBeenCalled();
  expect(setConversations).not.toHaveBeenCalled();
});

it("materializes a service model for the draft and ignores completion after leaving home", async () => {
  const { result, rerender, modelCatalog, onChange, fetchJson } = setupDraft();
  modelCatalog.ensureProfile.mockResolvedValueOnce("new-profile");
  await act(() => result.current.selectServiceModel("new-model", "service"));
  expect(onChange).toHaveBeenCalledWith("new-profile");
  expect(fetchJson).not.toHaveBeenCalled();
  onChange.mockClear();
  let resolveProfile!: (id: string) => void;
  modelCatalog.ensureProfile.mockImplementationOnce(() => new Promise(resolve => { resolveProfile = resolve; }));
  let selection!: Promise<void>;
  act(() => { selection = result.current.selectServiceModel("another-model", "service"); });
  rerender({ draft: false, scope: "account-a" });
  await act(async () => { resolveProfile("late-profile"); await selection; });
  expect(onChange).not.toHaveBeenCalled();
  expect(fetchJson).not.toHaveBeenCalled();
});
