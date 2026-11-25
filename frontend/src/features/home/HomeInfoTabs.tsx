import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
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
  const storageKey = `tuantuan-home-tab:${accountKey}`;
  const [activeId, setActiveId] = useState<HomeInfoTabId>(() => {
    try {
      const stored = readStorageItem(storageKey);
      const tab = tabs.find((tab) => tab.id === stored);
      if (tab) return tab.id;
    } catch { /* Fall back to the first tab when storage is unavailable. */ }
    return tabs[0]?.id ?? "ai";
  });
  const [renderedIds, setRenderedIds] = useState<Set<HomeInfoTabId>>(() => new Set([activeId]));

  return <Tabs render={<section />} className="home-info-tabs" aria-label="信息流" value={activeId} onValueChange={(value) => {
    const next = tabs.find((tab) => tab.id === value);
    if (!next) return;
    setActiveId(next.id);
    setRenderedIds((current) => (current.has(next.id) ? current : new Set(current).add(next.id)));
    try { window.localStorage.setItem(storageKey, next.id); } catch { /* Tabs keep working when storage is unavailable. */ }
  }}>
    <TabsList className="home-tablist" aria-label="信息流分类" activateOnFocus loopFocus>
      {tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className="home-tab"><span>{tab.title}</span>{tab.count && <span className="home-count">{tab.count}</span>}</TabsTrigger>)}
    </TabsList>
    {tabs.map((tab) => <TabsContent key={tab.id} value={tab.id} className="home-tabpanel" keepMounted>{renderedIds.has(tab.id) ? panels[tab.id] : null}</TabsContent>)}
  </Tabs>;
}
