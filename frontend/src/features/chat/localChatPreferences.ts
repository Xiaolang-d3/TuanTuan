import { readStorageItem } from "../../storage";
export function readStringMap(storageKey: string): Map<number, string> {
  try {
    const raw = readStorageItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    const values = new Map<number, string>();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return values;
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key);
      if (Number.isInteger(id) && id > 0 && typeof value === "string" && value) values.set(id, value);
    }
    return values;
  } catch {
    return new Map();
  }
}

export function writeStringMap(storageKey: string, values: Map<number, string>) {
  const payload: Record<string, string> = {};
  for (const [id, text] of values) {
    if (text) payload[String(id)] = text;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}

export function readIdList(storageKey: string): number[] {
  try {
    const raw = readStorageItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

export function writeIdList(storageKey: string, ids: number[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(ids));
}

export type ConversationFolder = {
  id: string;
  name: string;
};

const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function readConversationFolders(storageKey: string): { folders: ConversationFolder[]; assignments: Record<number, string> } {
  try {
    const raw = readStorageItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { folders: [], assignments: {} };
    const record = parsed as { folders?: unknown; assignments?: unknown };
    const folders = Array.isArray(record.folders)
      ? record.folders.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const folder = item as { id?: unknown; name?: unknown };
        const name = typeof folder.name === "string" ? folder.name.trim().slice(0, 40) : "";
        return typeof folder.id === "string" && FOLDER_ID.test(folder.id) && name ? [{ id: folder.id, name }] : [];
      }).slice(0, 30)
      : [];
    const known = new Set(folders.map((folder) => folder.id));
    const assignments: Record<number, string> = {};
    if (record.assignments && typeof record.assignments === "object" && !Array.isArray(record.assignments)) {
      for (const [key, value] of Object.entries(record.assignments)) {
        const id = Number(key);
        if (Number.isInteger(id) && id > 0 && typeof value === "string" && known.has(value)) assignments[id] = value;
      }
    }
    return { folders, assignments };
  } catch {
    return { folders: [], assignments: {} };
  }
}

export function writeConversationFolders(storageKey: string, folders: ConversationFolder[], assignments: Record<number, string>) {
  const known = new Set(folders.map((folder) => folder.id));
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries(assignments)) {
    if (known.has(value)) stored[key] = value;
  }
  window.localStorage.setItem(storageKey, JSON.stringify({ folders, assignments: stored }));
}
