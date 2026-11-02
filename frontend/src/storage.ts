type StorageName = "localStorage" | "sessionStorage";

function legacyKeys(key: string): string[] {
  if (!key.startsWith("tuantuan-")) return [];
  const suffix = key.slice("tuantuan-".length);
  return [`careerloop-${suffix}`, ...(["sidebar", "view"].includes(suffix) ? [`bosscopilot-${suffix}`] : [])];
}

/** Migrate one key on first use; never overwrite a current value or discard an unsaved legacy value. */
export function readStorageItem(key: string, storageName: StorageName = "localStorage"): string | null {
  try {
    const storage = window[storageName];
    const aliases = legacyKeys(key);
    let value = storage.getItem(key);
    if (value === null) {
      for (const alias of aliases) {
        value = storage.getItem(alias);
        if (value !== null) {
          try { storage.setItem(key, value); } catch { return value; }
          break;
        }
      }
    }
    if (value !== null) {
      for (const alias of aliases) {
        try { storage.removeItem(alias); } catch { /* Retry cleanup on the next read. */ }
      }
    }
    return value;
  } catch { return null; }
}

/** Clear both namespaces so signing out cannot restore a legacy token. */
export function removeStorageItem(key: string, storageName: StorageName = "localStorage"): void {
  for (const candidate of [key, ...legacyKeys(key)]) {
    try { window[storageName].removeItem(candidate); } catch { /* Storage may be disabled. */ }
  }
}
