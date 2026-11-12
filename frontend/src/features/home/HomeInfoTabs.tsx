import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { readStorageItem } from "../../storage";

export type HomeInfoTabId = "ai" | "trending" | "stack";

export type HomeInfoTabDef = {
  id: HomeInfoTabId;
  title: string;
  count?: string;
};

type HomeInfoTabsProps = {
  accountKey: string;
  tabs: HomeInfoTabDef[];
  panels: Record<HomeInfoTabId, ReactNode>;
};

export function HomeInfoTabs({ accountKey, tabs, panels }: HomeInfoTabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [activeId, setActiveId] = useState<HomeInfoTabId>(() => {
    try {
      const stored = readStorageItem(`tuantuan-home-tab:${accountKey}`);
      if (stored && tabs.some((tab) => tab.id === stored)) return stored as HomeInfoTabId;
    } catch { /* Fall back to the first tab when storage is unavailable. */ }
    return tabs[0]?.id ?? "ai";
  });
  const [renderedIds, setRenderedIds] = useState<Set<HomeInfoTabId>>(() => new Set([activeId]));

  function activate(id: HomeInfoTabId) {
    setActiveId(id);
    setRenderedIds((current) => (current.has(id) ? current : new Set(current).add(id)));
    try { window.localStorage.setItem(`tuantuan-home-tab:${accountKey}`, id); } catch { /* Tabs keep working when storage is unavailable. */ }
  }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    activate(next.id);
    tabRefs.current[next.id]?.focus();
  }
  return <section className="home-info-tabs" aria-label="信息流">
    <div className="home-tablist" role="tablist" aria-label="信息流分类" onKeyDown={handleKeyDown}>
      {tabs.map((tab) => <button key={tab.id} ref={(node) => { tabRefs.current[tab.id] = node; }} className={`home-tab${activeId === tab.id ? " on" : ""}`} type="button" role="tab" id={`home-tab-${tab.id}`} aria-selected={activeId === tab.id} aria-controls={`home-tab-panel-${tab.id}`} tabIndex={activeId === tab.id ? 0 : -1} onClick={() => activate(tab.id)}><span>{tab.title}</span>{tab.count && <span className="home-count">{tab.count}</span>}</button>)}
    </div>
    {tabs.map((tab) => <div key={tab.id} className="home-tabpanel" role="tabpanel" id={`home-tab-panel-${tab.id}`} aria-labelledby={`home-tab-${tab.id}`} hidden={activeId !== tab.id}>{renderedIds.has(tab.id) ? panels[tab.id] : null}</div>)}
  </section>;
}
