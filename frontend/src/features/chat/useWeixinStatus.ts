import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type createApiClient } from '../../api/client';

export type WeixinBotState = {
  connected: boolean; enabled: boolean; error: string; conversation_id?: number | null;
  unread_count: number; latest_sequence: number; readable_sequence: number;
  read_sequence: number; binding_id: string; stream_id?: string; revision?: number;
};
type Api = ReturnType<typeof createApiClient>;
type Connection = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'expired';

export function useWeixinStatus(api: Api, enabled: boolean) {
  const [view, setView] = useState<{ api: Api; status: WeixinBotState | null; connection: Connection }>({ api, status: null, connection: 'connecting' });
  const commands = useRef<{ api: Api; refresh: () => Promise<void>; accept: (next: WeixinBotState) => void } | null>(null);

  useEffect(() => {
    setView({ api, status: null, connection: 'connecting' });
    if (!enabled) return;
    const lifetime = new AbortController();
    let stream: AbortController | undefined;
    let retry: number | undefined;
    let fallback: number | undefined;
    let fetching = false;
    let attempt = 0;
    let pushSequence = 0;
    let latest: WeixinBotState | null = null;
    const retiredStreams = new Set<string>();
    const active = () => !lifetime.signal.aborted;
    const connection = (value: Connection) => { if (active()) setView(current => ({ ...current, connection: value })); };
    const accept = (next: WeixinBotState) => {
      if (!active() || !next || typeof next.connected !== 'boolean' || typeof next.enabled !== 'boolean' || typeof next.error !== 'string') return;
      if (next.stream_id && retiredStreams.has(next.stream_id)) return;
      if (latest?.stream_id && next.stream_id === latest.stream_id && (next.revision ?? 0) < (latest.revision ?? 0)) return;
      if (latest?.stream_id && next.stream_id && latest.stream_id !== next.stream_id) retiredStreams.add(latest.stream_id);
      latest = next;
      setView(current => ({ ...current, api, status: next }));
    };
    const refresh = async () => {
      if (!active() || fetching || document.visibilityState === 'hidden') return;
      fetching = true;
      const before = pushSequence;
      try {
        const next = await api<WeixinBotState>('/channels/weixin', { signal: lifetime.signal });
        if (before === pushSequence) accept(next);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          stop(); connection('expired');
        }
      } finally { fetching = false; }
    };
    const stopFallback = () => { window.clearInterval(fallback); fallback = undefined; };
    const startFallback = () => {
      if (fallback !== undefined) return;
      void refresh();
      fallback = window.setInterval(() => { void refresh(); }, 30_000);
    };
    const stop = () => {
      stream?.abort(); stream = undefined;
      window.clearTimeout(retry); retry = undefined;
      stopFallback();
    };
    const connect = async () => {
      if (!active() || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      stream = controller;
      connection(attempt ? 'reconnecting' : 'connecting');
      let expired = false;
      try {
        if (!api.events) throw new Error('当前连接仅支持定时刷新');
        await api.events('/channels/weixin/events', controller.signal, (event, data) => {
          if (!active() || stream !== controller || controller.signal.aborted || event !== 'weixin-status') return;
          const next = data as WeixinBotState;
          if (!next || typeof next.connected !== 'boolean' || typeof next.enabled !== 'boolean' || typeof next.error !== 'string') throw new Error('无效的实时通知');
          pushSequence++;
          accept(next);
          attempt = 0;
          stopFallback();
          connection('live');
        });
      } catch (error) { expired = error instanceof ApiError && error.status === 401; }
      finally {
        if (!active() || controller.signal.aborted || stream !== controller) return;
        if (expired) { stop(); connection('expired'); return; }
        connection('reconnecting');
        startFallback();
        retry = window.setTimeout(() => { void connect(); }, Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)));
      }
    };
    const visibility = () => {
      stop();
      if (document.visibilityState === 'hidden') connection('paused');
      else { attempt = 0; void connect(); }
    };
    const entry = { api, refresh, accept };
    commands.current = entry;
    document.addEventListener('visibilitychange', visibility);
    void connect();
    return () => {
      lifetime.abort(); stop();
      document.removeEventListener('visibilitychange', visibility);
      if (commands.current === entry) commands.current = null;
    };
  }, [api, enabled]);

  const refresh = useCallback(async () => { if (commands.current?.api === api) await commands.current.refresh(); }, [api]);
  const accept = useCallback((next: WeixinBotState) => { if (commands.current?.api === api) commands.current.accept(next); }, [api]);
  return { status: enabled && view.api === api ? view.status : null, connection: view.connection, refresh, accept };
}

export type WeixinChannel = ReturnType<typeof useWeixinStatus>;
