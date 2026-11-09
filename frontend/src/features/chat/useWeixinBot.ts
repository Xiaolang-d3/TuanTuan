import { useEffect, useRef, useState } from 'react';
import type { createApiClient } from '../../api/client';
import type { ChatMessage } from './types';
import { useWeixinStatus, type WeixinBotState, type WeixinChannel } from './useWeixinStatus';
export type { WeixinBotState } from './useWeixinStatus';

type Options = {
  fetchJson: ReturnType<typeof createApiClient>; enabled: boolean;
  activeConversationId: number | null; chatBusy: boolean;
  onMessages: (messages: ChatMessage[]) => void;
  channel?: WeixinChannel;
};

function isPageHidden() {
  return document.visibilityState === 'hidden';
}

export function useWeixinBot(options: Options) {
  const local = useWeixinStatus(options.fetchJson, options.enabled && !options.channel);
  const channel = options.channel ?? local;
  const status = channel.status;
  const current = useRef(options);
  const viewEpoch = useRef(0);
  if (current.current.activeConversationId !== options.activeConversationId || current.current.chatBusy !== options.chatBusy) viewEpoch.current++;
  current.current = options;
  const scope = useRef(0);
  const inFlight = useRef<symbol | null>(null);
  const retryNeeded = useRef(false);
  const [reload, setReload] = useState(0);
  const abort = useRef(new AbortController());
  const latestStatus = useRef(status);
  latestStatus.current = status;

  useEffect(() => {
    scope.current++;
    abort.current = new AbortController();
    return () => { scope.current++; abort.current.abort(); inFlight.current = null; retryNeeded.current = false; };
  }, [options.fetchJson, options.enabled]);

  async function loadUnread() {
    if (!options.enabled) return;
    if (inFlight.current) { retryNeeded.current = true; return; }
    const ticket = Symbol();
    inFlight.current = ticket;
    const epoch = scope.current;
    const api = options.fetchJson;
    try {
      const next = status;
      if (!next) return;
      if (epoch !== scope.current || api !== current.current.fetchJson || !current.current.enabled) return;
      const active = current.current;
      if (!next.connected || !next.conversation_id || next.unread_count <= 0
          || next.readable_sequence <= (next.read_sequence ?? 0)
          || active.activeConversationId !== next.conversation_id || active.chatBusy
          || isPageHidden()) return;
      const view = viewEpoch.current;
      const messages = await api<ChatMessage[]>(`/chat/messages?conversation_id=${next.conversation_id}`, { signal: abort.current.signal });
      if (epoch !== scope.current || api !== current.current.fetchJson || !current.current.enabled || view !== viewEpoch.current || current.current.chatBusy
          || current.current.activeConversationId !== next.conversation_id || latestStatus.current?.binding_id !== next.binding_id || isPageHidden()) return;
      current.current.onMessages(messages);
      const updated = await api<WeixinBotState>('/channels/weixin/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abort.current.signal,
        body: JSON.stringify({ through_sequence: next.readable_sequence, binding_id: next.binding_id })
      });
      if (epoch === scope.current && api === current.current.fetchJson && current.current.enabled) channel.accept(updated);
    } catch {
      // Keep unread on a failed load; the retry timer tries again.
    } finally {
      if (inFlight.current === ticket) {
        inFlight.current = null;
        if (retryNeeded.current) { retryNeeded.current = false; setReload(value => value + 1); }
      }
    }
  }

  useEffect(() => {
    void loadUnread();
    // Retry message loading independently of status events when a request fails.
    const timer = window.setInterval(() => { void loadUnread(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [status, reload, options.activeConversationId, options.chatBusy, options.fetchJson, options.enabled]);
  useEffect(() => {
    const visible = () => { if (!isPageHidden()) void loadUnread(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [status, options.activeConversationId, options.chatBusy, options.fetchJson, options.enabled]);
  return status;
}
