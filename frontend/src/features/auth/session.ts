import { readStorageItem, removeStorageItem } from "../../storage";

export type AuthUser = { id?: number; email: string; display_name?: string; has_avatar?: boolean };
export type AuthSession = { access_token: string; user: AuthUser };
export const tokenStorageKey = "tuantuan-auth-token";

function readStorage(storage: "localStorage" | "sessionStorage") {
  return readStorageItem(tokenStorageKey, storage);
}

export function readStoredToken() {
  return readStorage("sessionStorage") || readStorage("localStorage");
}

export function isPersistentSession() {
  return !readStorage("sessionStorage") && Boolean(readStorage("localStorage"));
}

export function writeStoredToken(token: string, persistent: boolean) {
  clearStoredToken();
  try {
    window[persistent ? "localStorage" : "sessionStorage"].setItem(tokenStorageKey, token);
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
