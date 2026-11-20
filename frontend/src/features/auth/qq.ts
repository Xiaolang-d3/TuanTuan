import { createApiClient } from "../../api/client";

export function canUseQq(apiBase: string) {
  if (window.__TAURI__) return false;
  try {
    return new URL(apiBase || "/", window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export async function beginQq(apiBase: string, accessToken?: string) {
  const path = accessToken ? "/auth/qq/bind/start" : "/auth/qq/start";
  const { authorization_url } = await createApiClient(apiBase, accessToken)<{ authorization_url: string }>(path, { method: "POST" });
  const url = new URL(authorization_url);
  if (url.origin !== "https://graph.qq.com" || url.pathname !== "/oauth2.0/authorize" || url.username || url.password) {
    throw new Error("QQ 授权地址无效，请重试");
  }
  window.location.assign(url.href);
}

export function readQqReturn() {
  return new URLSearchParams(window.location.search).get("qq_auth");
}

export function clearQqReturn() {
  const url = new URL(window.location.href);
  url.searchParams.delete("qq_auth");
  window.history.replaceState(window.history.state, "", url);
}
