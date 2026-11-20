import { readStorageItem, removeStorageItem } from "../../storage";

export type AuthUser = { id?: number; email: string; display_name?: string; has_avatar?: boolean; qq_enabled?: boolean; qq_bound?: boolean; qq_only?: boolean };
export type AuthSession = { access_token: string; user: AuthUser };
export const tokenStorageKey = "tuantuan-auth-token";

function readStorage(storage: "localStorage" | "sessionStorage") {
  return readStorageItem(tokenStorageKey, storage);
}

/** Read the token of this browser session; tokens persisted by older builds are purged, never restored. */
export function readStoredToken() {
  const token = readStorage("sessionStorage");
  removeStorageItem(tokenStorageKey, "localStorage");
  return token;
}

export function writeStoredToken(token: string) {
  clearStoredToken();
  try {
    window.sessionStorage.setItem(tokenStorageKey, token);
  } catch {
    // Restricted storage still permits the current in-memory session.
  }
}

export function clearStoredToken() {
  for (const storage of ["localStorage", "sessionStorage"] as const) {
    removeStorageItem(tokenStorageKey, storage);
  }
}

export function validateSession(value: unknown): AuthSession {
  const session = value as Partial<AuthSession> | null;
  if (!session || typeof session.access_token !== "string" || !session.access_token
    || !session.user || typeof session.user.email !== "string" || !session.user.email) {
    throw new Error("登录服务返回了无效数据，请重试");
  }
  return session as AuthSession;
}

export function tokenExpiresAt(token: string): number | null {
  try {
    const encoded = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}
