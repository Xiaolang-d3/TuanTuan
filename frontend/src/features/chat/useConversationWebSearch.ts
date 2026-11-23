import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { writeStorageItem } from "../../storage";

type Account = { id?: number; email: string };

export function useConversationWebSearch(apiBase: string, user: Account, conversationId: number | null) {
  const key = conversationId === null ? null : `tuantuan-conversation-web-search:${JSON.stringify([
    apiBase, user.id ?? user.email.toLowerCase(), conversationId,
  ])}`;
  const fallback = useRef(new Map<string, boolean>());
  const [, setRevision] = useState(0);
  const subscribe = useCallback((notify: () => void) => {
    function onStorage(event: StorageEvent) {
      if (!key || (event.key !== key && event.key !== null)) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      fallback.current.delete(key);
      notify();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  function getSnapshot() {
    if (!key) return false;
    const localValue = fallback.current.get(key);
    if (localValue !== undefined) return localValue;
    try { return window.localStorage.getItem(key) === "true"; } catch { return false; }
  }
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => false);

  function setEnabled(next: boolean) {
    if (!key) return;
    if (writeStorageItem(key, String(next))) fallback.current.delete(key);
    else fallback.current.set(key, next);
    setRevision((revision) => revision + 1);
  }

  return { enabled, setEnabled };
}
