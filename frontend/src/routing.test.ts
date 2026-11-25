import { describe, expect, it } from "vitest";
import { appRouteHash, initialAppRoute, parseAppHash, routeForSection } from "./routing";

describe("primary route", () => {
  it("opens home after login when no route is specified", () => {
    expect(initialAppRoute("")).toEqual({ section: "dashboard" });
    expect(initialAppRoute("#")).toEqual({ section: "dashboard" });
    expect(parseAppHash("#/home")).toEqual({ section: "dashboard" });
    expect(parseAppHash("#/dashboard")).toEqual({ section: "dashboard" });
    expect(parseAppHash("#/library")).toEqual({ section: "chat", page: "library" });
    expect(appRouteHash({ section: "dashboard" })).toBe("#/home");
    expect(routeForSection("dashboard")).toEqual({ section: "dashboard" });
  });
});

describe("product destination routes", () => {
  it.each([
    ["images", "#/images"],
    ["video", "#/video"],
    ["works", "#/works"],
    ["history", "#/history"]
  ] as const)("keeps %s addressable after refresh", (section, hash) => {
    expect(parseAppHash(hash)).toEqual({ section });
    expect(initialAppRoute(hash)).toEqual({ section });
    expect(routeForSection(section)).toEqual({ section });
    expect(appRouteHash({ section })).toBe(hash);
  });
  it("preserves encoded image record links without changing the old workspace URL", () => {
    const task = { section: "images", taskId: "a/b & c" } as const;
    expect(parseAppHash(appRouteHash(task))).toEqual(task);
    expect(parseAppHash("#/images?task=")).toEqual({ section: "images" });
  });
});

describe("retired product routes", () => {
  it.each([
    "search",
    "workspace",
    "workbench",
    "workbench/jobs/42/evaluation",
    "opportunities",
    "opportunities/jobs/9",
    "interview-prep",
    "interview-records",
    "projects",
    "projects/experience-1/questions/experience-1-contribution",
    "project",
    "project/project-1/interview",
    "knowledge",
    "knowledge/experience-1/experience-1-skill-fastapi",
    "evidence",
    "settings/profile"
  ])("does not recognize #%s", (path) => {
    expect(parseAppHash(`#/${path}`)).toBeNull();
    expect(initialAppRoute(`#/${path}`)).toEqual({ section: "dashboard" });
  });
});

describe("conversation route", () => {
  it("keeps workspace files separate from settings management and accepts legacy links", () => {
    expect(parseAppHash("#/chat/library")).toEqual({ section: "chat", page: "library" });
    expect(appRouteHash({ section: "chat", page: "library" })).toBe("#/chat/library");
    expect(parseAppHash("#/settings/library")).toEqual({ section: "settings", page: "library" });
  });
  it("keeps a specific conversation addressable", () => {
    expect(parseAppHash("#/chat/42")).toEqual({ section: "chat", conversationId: 42 });
    expect(appRouteHash({ section: "chat", conversationId: 42 })).toBe("#/chat/42");
  });
});

describe("account settings route", () => {
  it("keeps account settings distinct from the library", () => {
    expect(parseAppHash("#/settings/account")).toEqual({ section: "settings", page: "account" });
    expect(appRouteHash({ section: "settings", page: "account" })).toBe("#/settings/account");
    expect(parseAppHash("#/library?return=workbench")).toEqual({ section: "chat", page: "library" });
    expect(appRouteHash({ section: "settings", page: "library" })).toBe("#/settings/library");
  });
});

describe("model settings route", () => {
  it("keeps model settings addressable inside settings", () => {
    expect(parseAppHash("#/settings/model")).toEqual({ section: "settings", page: "model" });
    expect(parseAppHash("#/settings/models")).toEqual({ section: "settings", page: "model" });
    expect(appRouteHash({ section: "settings", page: "model" })).toBe("#/settings/model");
  });

  it("restores only the image default-model intent when reloading model settings", () => {
    const route = { section: "settings", page: "model", purpose: "image" } as const;
    expect(appRouteHash(route)).toBe("#/settings/model?purpose=image");
    expect(initialAppRoute(appRouteHash(route))).toEqual(route);
    expect(parseAppHash("#/settings/models?purpose=image")).toEqual(route);
    expect(parseAppHash("#/settings/model?purpose=unknown")).toEqual({ section: "settings", page: "model" });
    expect(parseAppHash("#/settings/appearance?purpose=image")).toEqual({ section: "settings", page: "appearance" });
  });
});

describe("global appearance", () => {
  it("opens and serializes its own settings route", () => {
    expect(parseAppHash("#/settings/appearance")).toEqual({ section: "settings", page: "appearance" });
    expect(appRouteHash({ section: "settings", page: "appearance" })).toBe("#/settings/appearance");
  });
});
