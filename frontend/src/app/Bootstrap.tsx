import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { App } from "./App";
import { resolveApiBase, type DesktopRuntimeConfig } from "./runtime";
import { isProductIntroHash, productPrivacyHash } from "../routing";
import { AuthGate } from "../components/AuthGate";
import { PageLoading } from "../components/PageLoading";
import { ProductIntroPage } from "../features/about/ProductIntroPage";

export function Bootstrap() {
  const [runtime, setRuntime] = useState<DesktopRuntimeConfig | null>(null);
  const [entryHash, setEntryHash] = useState(() => window.location.hash);
  const [returnHash, setReturnHash] = useState(() => isProductIntroHash(window.location.hash) ? "#/home" : window.location.hash || "#/home");
  const showIntro = isProductIntroHash(entryHash);

  useEffect(() => {
    function syncEntry() {
      const hash = window.location.hash;
      setEntryHash(hash);
      if (!isProductIntroHash(hash)) setReturnHash(hash || "#/home");
    }
    window.addEventListener("hashchange", syncEntry);
    return () => window.removeEventListener("hashchange", syncEntry);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void resolveApiBase()
      .then((next) => { if (!cancelled) setRuntime(next); })
      .catch((error: unknown) => {
        if (!cancelled) setRuntime({ startupError: error instanceof Error ? error.message : "无法读取桌面运行配置" });
      });
    return () => { cancelled = true; };
  }, []);

  const intro = (signedIn = false) => <ProductIntroPage returnHash={returnHash} signedIn={signedIn} showPrivacy={entryHash === productPrivacyHash} />;
  // Public product information remains available even if the local service cannot start.
  if (!runtime || runtime.startupError || !runtime.apiBase) {
    if (showIntro) return intro();
    if (!runtime) return <PageLoading label="正在启动 团团…" />;
    return (
      <main className="page-loading" role="alert">
        <div className="page-loading-copy">
          <TriangleAlert size={20} />
          <span>{runtime.startupError || "本地服务地址不可用，请重新启动 团团。"}</span>
        </div>
      </main>
    );
  }
  return (
    <AuthGate apiBase={runtime.apiBase} publicPage={showIntro ? intro : undefined}>
      {(accessToken, onLogout, user, updateSession) => (
        <App apiBase={runtime.apiBase!} accessToken={accessToken} onLogout={onLogout} user={user} updateSession={updateSession} />
      )}
    </AuthGate>
  );
}
