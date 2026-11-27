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
