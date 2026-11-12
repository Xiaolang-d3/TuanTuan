import { useCallback, useEffect, useRef, useState } from "react";
import { createApiClient } from "../../api/client";

export type KernelCatalog = {
  choices: Array<{ id: "tuantuan" | "dsh"; name: string; available: boolean; reason: string }>;
  default_kernel: "tuantuan" | "dsh";
};

export function useKernels(fetch: ReturnType<typeof createApiClient>) {
  const [catalog, setCatalog] = useState<KernelCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(fetch);
  clientRef.current = fetch;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await clientRef.current<KernelCatalog>("/agent/kernels");
      setCatalog(next);
    } catch {
      setCatalog(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { catalog, busy, refresh };
}
