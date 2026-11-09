import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredToken, isPersistentSession, readStoredToken } from "./features/auth/session";
import { readConversationFolders, readIdList, readStringMap } from "./features/chat/localChatPreferences";
import { readStorageItem } from "./storage";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("storage namespace migration", () => {
  it.each(["localStorage", "sessionStorage"] as const)("preserves an existing login in %s and clears both namespaces on logout", (storageName) => {
    window[storageName].setItem("careerloop-auth-token", "saved-token");
    expect(readStoredToken()).toBe("saved-token");
    expect(isPersistentSession()).toBe(storageName === "localStorage");
    expect(window[storageName].getItem("tuantuan-auth-token")).toBe("saved-token");
    expect(window[storageName].getItem("careerloop-auth-token")).toBeNull();
    // An unread legacy token in the other store must not restore a signed-out session.
    window[storageName === "localStorage" ? "sessionStorage" : "localStorage"].setItem("careerloop-auth-token", "stale-token");
    clearStoredToken();
    expect(readStoredToken()).toBeNull();
  });

  it("keeps the session token ahead of a persistent legacy login", () => {
    sessionStorage.setItem("careerloop-auth-token", "temporary");
    localStorage.setItem("careerloop-auth-token", "persistent");
    expect(readStoredToken()).toBe("temporary");
    expect(isPersistentSession()).toBe(false);
  });

  it("migrates theme, scoped preferences and structured drafts only when read", () => {
    localStorage.setItem("careerloop-theme", "dark");
    localStorage.setItem("careerloop-sidebar:a@example.test", "collapsed");
    localStorage.setItem("careerloop-composer-drafts:a@example.test", '{"7":"unfinished message"}');
    localStorage.setItem("careerloop-composer-drafts:b@example.test", '{"8":"another account"}');
    localStorage.setItem("careerloop-pinned-conversations:a@example.test", "[7]");
    localStorage.setItem("careerloop-conversation-folders:a@example.test", '{"folders":[{"id":"work","name":"工作"}],"assignments":{"7":"work"}}');
    expect(readStorageItem("tuantuan-theme")).toBe("dark");
    expect(readStorageItem("tuantuan-sidebar:a@example.test")).toBe("collapsed");
    expect(readStringMap("tuantuan-composer-drafts:a@example.test")).toEqual(new Map([[7, "unfinished message"]]));
    expect(readIdList("tuantuan-pinned-conversations:a@example.test")).toEqual([7]);
    expect(readConversationFolders("tuantuan-conversation-folders:a@example.test")).toEqual({ folders: [{ id: "work", name: "工作" }], assignments: { 7: "work" } });
    expect(localStorage.getItem("careerloop-composer-drafts:a@example.test")).toBeNull();
    expect(localStorage.getItem("careerloop-composer-drafts:b@example.test")).toBe('{"8":"another account"}');
  });

  it("prefers current values including empty strings and does not migrate twice", () => {
    localStorage.setItem("tuantuan-theme", "");
    localStorage.setItem("careerloop-theme", "dark");
    expect(readStorageItem("tuantuan-theme")).toBe("");
    expect(localStorage.getItem("careerloop-theme")).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    expect(readStorageItem("tuantuan-theme")).toBe("");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("returns legacy data without deleting it when migration cannot be persisted", () => {
    localStorage.setItem("careerloop-theme", "dark");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(readStorageItem("tuantuan-theme")).toBe("dark");
    expect(localStorage.getItem("careerloop-theme")).toBe("dark");
    expect(localStorage.getItem("tuantuan-theme")).toBeNull();
  });

  it("handles blocked storage and missing keys", () => {
    expect(readStorageItem("tuantuan-missing")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readStorageItem("tuantuan-theme")).toBeNull();
  });

  it("retains the older unscoped sidebar and view migration", () => {
    localStorage.setItem("bosscopilot-sidebar", "collapsed");
    localStorage.setItem("bosscopilot-view", "chat");
    expect(readStorageItem("tuantuan-sidebar")).toBe("collapsed");
    expect(readStorageItem("tuantuan-view")).toBe("chat");
    expect(localStorage.getItem("bosscopilot-sidebar")).toBeNull();
  });
});
