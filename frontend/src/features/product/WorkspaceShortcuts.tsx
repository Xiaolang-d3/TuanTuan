import { useEffect, useState } from "react";
import { FolderKanban, History } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { creationKinds, readCreationRecords, type CreationRecord, type FetchCreationJson } from "./creationRecordsApi";
import { createProjectsApi, type Project } from "./projectsApi";
import "./WorkspaceShortcuts.css";

type Props = {
  fetchJson: FetchCreationJson;
  onProject: (id: string) => void;
  onRecord: (record: CreationRecord) => void;
  expandedByDefault?: boolean;
  onViewProjects?: () => void;
  onViewRecords?: () => void;
};

export function WorkspaceShortcuts({ fetchJson, onProject, onRecord, expandedByDefault = false, onViewProjects, onViewRecords }: Props) {
  const [projectsOpen, setProjectsOpen] = useState(expandedByDefault);
  const [recordsOpen, setRecordsOpen] = useState(expandedByDefault);
  const projects = useShortcutItems(projectsOpen, fetchJson, loadProjects);
  const records = useShortcutItems(recordsOpen, fetchJson, loadRecords);
  return <nav className="workspace-shortcuts" aria-label="工作区快捷入口">
    <details open={projectsOpen} onToggle={event => setProjectsOpen(event.currentTarget.open)}>
      <summary>{onViewProjects ? "我的项目" : "常用项目"}</summary>
      <ShortcutList state={projects} empty="暂无进行中的项目。" label="最近更新的进行中项目"
        row={item => <ActionButton variant="ghost" size="sm" icon={<FolderKanban size={14} aria-hidden="true" />}
          title={item.name} onClick={() => onProject(item.id)}>{item.name}</ActionButton>} keyFor={item => item.id} />
      {onViewProjects && <ActionButton className="workspace-shortcut-index" variant="ghost" size="sm"
        onClick={onViewProjects}>查看全部项目</ActionButton>}
    </details>
    <details open={recordsOpen} onToggle={event => setRecordsOpen(event.currentTarget.open)}>
      <summary>最近记录</summary>
      <ShortcutList state={records} empty="暂无创作记录。" label="最近更新的创作记录"
        row={item => <ActionButton variant="ghost" size="sm" icon={<History size={14} aria-hidden="true" />}
          aria-label={`${creationKinds[item.kind]}：${item.title}`} title={item.title} onClick={() => onRecord(item)}>{item.title}</ActionButton>}
        keyFor={item => `${item.kind}:${item.id}`} />
      {onViewRecords && <ActionButton className="workspace-shortcut-index" variant="ghost" size="sm"
        onClick={onViewRecords}>查看全部创作记录</ActionButton>}
    </details>
  </nav>;
}

async function loadProjects(fetchJson: FetchCreationJson, signal: AbortSignal) {
  const { items } = await createProjectsApi(fetchJson).list(signal);
  return items.filter(item => item.status === "active").slice(0, 3);
}

async function loadRecords(fetchJson: FetchCreationJson, signal: AbortSignal) {
  const { items } = await readCreationRecords(fetchJson, { limit: 3, signal });
  return items;
}

function useShortcutItems<T extends Project | CreationRecord>(open: boolean, fetchJson: FetchCreationJson,
  load: (fetchJson: FetchCreationJson, signal: AbortSignal) => Promise<T[]>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ client: FetchCreationJson; items: T[] | null }>();
  useEffect(() => {
    if (!open) { setResult(undefined); return; }
    const controller = new AbortController();
    load(fetchJson, controller.signal).then(items => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, items });
    }, () => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, items: null });
    });
    return () => controller.abort();
  }, [open, fetchJson, load, attempt]);
  return {
    items: open && result?.client === fetchJson ? result.items : undefined,
    retry: () => { setResult(undefined); setAttempt(previous => previous + 1); },
  };
}

function ShortcutList<T>({ state, empty, label, row, keyFor }: {
  state: { items: T[] | null | undefined; retry: () => void };
  empty: string;
  label: string;
  row: (item: T) => React.ReactNode;
  keyFor: (item: T) => string;
}) {
  if (state.items === undefined) return <p role="status">正在读取…</p>;
  if (state.items === null) return <><p role="status">暂时无法读取。</p><ActionButton variant="ghost" size="sm" onClick={state.retry}>重试</ActionButton></>;
  if (!state.items.length) return <p>{empty}</p>;
  return <ul aria-label={label}>{state.items.map(item => <li key={keyFor(item)}>{row(item)}</li>)}</ul>;
}
