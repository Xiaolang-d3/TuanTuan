import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createApiClient, SESSION_EXPIRED_EVENT } from "../../api/client";
import {
  AuthSession, AuthUser, clearStoredToken, readStoredToken,
  tokenExpiresAt, tokenStorageKey, validateSession, writeStoredToken
} from "./session";

type VerifiedSession = AuthSession & { apiBase: string };

export function useAuthSession(apiBase: string) {
  const [token, setToken] = useState(readStoredToken);
  const [verified, setVerified] = useState<VerifiedSession | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [notice, setNotice] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutPending = useRef(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const authenticated = verified?.access_token === token && verified?.apiBase === apiBase ? verified : null;

  const reset = useCallback((message = "") => {
    clearStoredToken();
    tokenRef.current = null;
    setToken(null);
    setVerified(null);
    setRestoreError("");
    setRestoreNonce(0);
    setLogoutError("");
    setNotice(message);
  }, []);

  useEffect(() => {
    if (!token || authenticated) return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: number | undefined;
    void createApiClient(apiBase, token)<{ user: AuthUser }>("/auth/me", { signal: controller.signal })
      .then((payload) => {
        if (cancelled || tokenRef.current !== token) return;
        const session = validateSession({ access_token: token, user: payload.user });
        setVerified({ ...session, apiBase });
        setRestoreError("");
        setRestoreNonce(0);
      })
      .catch((reason: unknown) => {
        if (cancelled || tokenRef.current !== token) return;
        if (reason instanceof ApiError && reason.status === 401) {
          reset("登录状态已失效，请重新登录");
          return;
        }
        setRestoreError("登录服务暂时不可用，请重新连接。正在自动重试…");
        timer = window.setTimeout(() => setRestoreNonce((value) => value + 1), Math.min(30_000, 1500 * 2 ** Math.min(restoreNonce, 5)));
      });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [apiBase, token, authenticated, restoreNonce, reset]);

  useEffect(() => {
    const onExpired = (event: Event) => {
      if ((event as CustomEvent<{ token: string }>).detail?.token === tokenRef.current) {
        reset("登录状态已失效，请重新登录");
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== tokenStorageKey && event.key !== null) return;
      const next = readStoredToken();
      if (next === tokenRef.current) return;
      tokenRef.current = next;
      setToken(next);
      setVerified(null);
      setRestoreError("");
      setRestoreNonce(0);
      setNotice(next ? "" : "账户已在其他窗口退出，请重新登录");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener("storage", onStorage);
    };
  }, [reset]);

  useEffect(() => {
    if (!authenticated || !token) return;
    const expiresAt = tokenExpiresAt(token);
    if (expiresAt === null) return;
    const expire = () => reset("登录已到期，请重新登录");
    const timer = window.setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    const onFocus = () => { if (Date.now() >= expiresAt) expire(); };
    window.addEventListener("focus", onFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [authenticated, token, reset]);

  function acceptSession(session: AuthSession) {
    validateSession(session);
    writeStoredToken(session.access_token);
    tokenRef.current = session.access_token;
    setToken(session.access_token);
    setVerified({ ...session, apiBase });
    setRestoreError("");
    setRestoreNonce(0);
    setNotice("");
    setLogoutError("");
  }

  function updateSession(nextToken: string, user: AuthUser) {
    acceptSession({ access_token: nextToken, user });
  }

  async function logout() {
    if (logoutPending.current || !token) return;
    logoutPending.current = true;
    const outgoing = token;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await createApiClient(apiBase, outgoing)("/auth/logout", { method: "POST" });
      if (tokenRef.current === outgoing) reset();
    } catch (reason) {
      if (tokenRef.current !== outgoing) return;
      if (reason instanceof ApiError && reason.status === 401) reset();
      else setLogoutError("退出未完成，请重新连接后重试。");
    } finally { logoutPending.current = false; setLogoutBusy(false); }
  }

  return {
    token, authenticated, restoreError, notice, logoutBusy, logoutError,
    acceptSession, updateSession, logout,
    retryRestore: () => { setRestoreError(""); setRestoreNonce((value) => value + 1); }
  };
}
