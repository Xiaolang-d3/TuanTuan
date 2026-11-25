import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, FolderPlus, History, MessageCircle, MoreHorizontal, Pencil, Pin, Plus, Search, Trash2, X } from "lucide-react";
import type { Conversation } from "../types";
import { DropdownMenu, DropdownMenuContent } from "./ui/DropdownMenu";

export type ConversationTimeGroup = {
  label: string;
  items: Conversation[];
  folderId?: string;
};

function parseConversationDate(value: string): Date | null {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function conversationGroupLabel(value: string, now = new Date()): string {
  const date = parseConversationDate(value);
  if (!date) return "更早";
  const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return "最近 7 天";
  return "更早";
}

export function formatConversationTime(value: string, now = new Date()): string {
  const date = parseConversationDate(value);
  if (!date) return value;
  const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric"
  }).format(date);
}

export function groupConversationsByTime(
  conversations: Conversation[],
  now = new Date(),
  pinnedIds: number[] = [],
  folders: Array<{ id: string; name: string }> = [],
  assignments: Record<number, string> = {}
): ConversationTimeGroup[] {
  const pinned = new Set(pinnedIds);
  const filed = new Set(Object.keys(assignments).map(Number));
  const order = ["今天", "昨天", "最近 7 天", "更早"];
  const buckets = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    if (pinned.has(conversation.id) || filed.has(conversation.id)) continue;
    const label = conversationGroupLabel(conversation.last_message_at || conversation.updated_at, now);
    const items = buckets.get(label) ?? [];
    items.push(conversation);
    buckets.set(label, items);
  }
  const groups = order.flatMap((label) => {
    const items = buckets.get(label);
    return items?.length ? [{ label, items }] : [];
  });
  const folderGroups = folders.flatMap((folder) => {
    const items = conversations.filter((conversation) => assignments[conversation.id] === folder.id);
    return items.length ? [{ label: folder.name, items, folderId: folder.id }] : [];
  });
  const pinnedItems = pinnedIds.flatMap((id) => {
    const item = conversations.find((conversation) => conversation.id === id);
    return item ? [item] : [];
  });
  return [
    ...(pinnedItems.length ? [{ label: "置顶", items: pinnedItems }] : []),
    ...folderGroups,
    ...groups
  ];
}

function FolderHeading({ label, folder, renaming, onStartRename, onRename, onRemove, onCancelRename }: {
  label: string;
  folder?: { id: string; name: string };
  renaming: boolean;
  onStartRename: (folderId: string) => void;
  onRename?: (folderId: string, name: string) => void;
  onRemove?: (folderId: string) => void;
  onCancelRename: () => void;
}) {
  if (!folder) return <h3>{label}</h3>;
  if (renaming) {
    return <h3><input aria-label={`重命名 ${folder.name}`} defaultValue={folder.name} autoFocus maxLength={40} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onCancelRename(); }
      if (event.key === "Enter") { onRename?.(folder.id, event.currentTarget.value); onCancelRename(); }
    }} onBlur={onCancelRename} /></h3>;
  }
  return <h3><span className="conversation-folder-heading">{folder.name}{onRename ? <button type="button" aria-label={`重命名文件夹 ${folder.name}`} onClick={() => onStartRename(folder.id)}>重命名</button> : null}{onRemove ? <button type="button" aria-label={`删除文件夹 ${folder.name}`} onClick={() => onRemove(folder.id)}>删除</button> : null}</span></h3>;
}

function conversationSubtitle(conversation: Conversation, now = new Date()): string {
  if (conversation.task_status === "active") return "进行中";
  if (conversation.status === "archived") return "已归档";
  return formatConversationTime(conversation.last_message_at || conversation.updated_at, now);
}

type Props = {
  conversations: Conversation[];
  currentConversationId: number | null;
  busy: boolean;
  open?: boolean;
  onClose?: () => void;
  onSelect: (conversationId: number) => void;
  onCreate: () => void;
  onRename: (conversation: Conversation) => void;
  onArchive: (conversation: Conversation) => void;
  onRemove: (conversation: Conversation) => void;
  onSearch?: (query: string) => Promise<Conversation[]>;
  pinnedIds?: number[];
  onTogglePin?: (conversation: Conversation) => void;
  folders?: Array<{ id: string; name: string }>;
  folderAssignments?: Record<number, string>;
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (folderId: string, name: string) => void;
  onRemoveFolder?: (folderId: string) => void;
  onAssignFolder?: (conversation: Conversation, folderId: string | null) => void;
};

export function ConversationHistoryPanel({
  conversations,
  currentConversationId,
  busy,
  open = false,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onRemove,
  onSearch,
  pinnedIds = [],
  onTogglePin,
  folders = [],
  folderAssignments = {},
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
  onAssignFolder
}: Props) {
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<Conversation[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!onSearch) {
      setRemoteResults(null);
      setSearchPending(false);
      return;
    }
    const needle = query.trim();
    if (!needle) {
      setRemoteResults(null);
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    setRemoteResults(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearch(needle).then((items) => {
        if (!cancelled) setRemoteResults(items);
      }).catch(() => {
        if (!cancelled) setRemoteResults(null);
      }).finally(() => {
        if (!cancelled) setSearchPending(false);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onSearch, query]);
  const filtered = useMemo(() => {
    if (remoteResults) return remoteResults;
    const needle = query.trim().toLocaleLowerCase();
    return conversations.filter((conversation) => !needle || `${conversation.title} ${conversation.summary}`.toLocaleLowerCase().includes(needle));
  }, [conversations, query, remoteResults]);
  const groups = useMemo(
    () => groupConversationsByTime(filtered, new Date(), pinnedIds, query.trim() ? [] : folders, query.trim() ? {} : folderAssignments),
    [filtered, pinnedIds, folders, folderAssignments, query]
  );
  useEffect(() => setOpenMenuId(null), [currentConversationId, open, query]);

  function openConversationDialog(action: (conversation: Conversation) => void, conversation: Conversation) {
    // Restore the row trigger before the dialog captures focus for its close behavior.
    panelRef.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${conversation.id}"][aria-expanded="true"]`)?.focus({ preventScroll: true });
    action(conversation);
  }

  function closeDrawer() {
    onClose?.();
  }

  return (
    <aside
      ref={panelRef}
      id="conversation-history-drawer"
      className={`conversation-history-panel ${open ? "drawer-open" : ""}`}
      hidden={!open}
      aria-label="对话记录"
    >
      <header>
        <div><History size={15} /><strong>对话记录</strong></div>
        <button className="conversation-history-close" type="button" onClick={closeDrawer} aria-label="关闭对话记录"><X size={16} /></button>
      </header>
      <button className="conversation-history-new" type="button" onClick={() => { onCreate(); closeDrawer(); }} disabled={busy}>
        <Plus size={15} /><span>{busy ? "正在创建…" : "新建对话"}</span>
      </button>
      {onCreateFolder ? (
        creatingFolder ? (
          <form className="conversation-folder-create" onSubmit={(event) => {
            event.preventDefault();
            const name = folderDraft.trim();
            if (!name) return;
            onCreateFolder(name);
            setFolderDraft("");
            setCreatingFolder(false);
          }}>
            <input aria-label="文件夹名称" maxLength={40} value={folderDraft} autoFocus onChange={(event) => setFolderDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); setCreatingFolder(false); setFolderDraft(""); }
            }} />
            <button type="submit" disabled={!folderDraft.trim()}>创建</button>
          </form>
        ) : <button className="conversation-history-folder" type="button" onClick={() => setCreatingFolder(true)}><FolderPlus size={15} /><span>新建文件夹</span></button>
      ) : null}
      <label className="conversation-history-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label="搜索对话标题、摘要或正文" placeholder="搜索对话…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); }
        }} />
      </label>
      <div className="conversation-history-list" onScroll={(event) => {
        if (openMenuId === null) return;
        const list = event.currentTarget;
        const trigger = list.querySelector<HTMLButtonElement>(`[data-menu-trigger="${openMenuId}"]`);
        if (!trigger) return;
        const listBounds = list.getBoundingClientRect();
        const triggerBounds = trigger.getBoundingClientRect();
        if (triggerBounds.bottom <= listBounds.top || triggerBounds.top >= listBounds.bottom) {
          setOpenMenuId(null);
        }
      }}>
        {!groups.length && !searchPending ? <p className="conversation-history-empty" role="status">{query.trim() ? "没有匹配的对话，试试其他关键词" : "还没有对话，点击上方开始"}</p> : null}
        {groups.map((group) => (
          <section className="conversation-history-group" key={group.folderId ? `folder:${group.folderId}` : group.label} aria-label={group.label}>
            <FolderHeading
              label={group.label}
              folder={folders.find((item) => item.id === group.folderId)}
              renaming={renamingFolderId === group.folderId}
              onStartRename={setRenamingFolderId}
              onRename={onRenameFolder}
              onRemove={onRemoveFolder}
              onCancelRename={() => setRenamingFolderId(null)}
            />
            {group.items.map((conversation) => (
              <div className={`conversation-history-item ${conversation.id === currentConversationId ? "active" : ""} ${conversation.status}`} key={conversation.id}>
                <button className="conversation-history-select" title={conversation.title} aria-current={conversation.id === currentConversationId ? "page" : undefined} type="button" onClick={() => { onSelect(conversation.id); closeDrawer(); setOpenMenuId(null); }}>
                  <MessageCircle size={14} />
                  <span><strong>{conversation.title}</strong><small>{conversationSubtitle(conversation)}</small></span>
                </button>
                <div className="conversation-history-actions">
                  <DropdownMenu.Root
                    modal={false}
                    open={open && openMenuId === conversation.id}
                    onOpenChange={(next, details) => {
                      if (details.reason === "escape-key") details.event.stopPropagation();
                      setOpenMenuId((current) => next ? conversation.id : current === conversation.id ? null : current);
                    }}
                  >
                    <DropdownMenu.Trigger data-menu-trigger={conversation.id} title="更多操作" aria-label={`${conversation.title} 的更多操作`}>
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </DropdownMenu.Trigger>
                    <DropdownMenuContent
                      className="conversation-history-menu"
                      aria-label={`${conversation.title} 的操作`}
                      align="end"
                      container={panelRef}
                      collisionBoundary={panelRef.current ?? undefined}
                    >
                      <DropdownMenu.Item onClick={() => openConversationDialog(onRename, conversation)}><Pencil size={13} aria-hidden="true" />重命名</DropdownMenu.Item>
                      <DropdownMenu.Item onClick={() => onArchive(conversation)}><Archive size={13} aria-hidden="true" />{conversation.status === "active" ? "归档" : "恢复"}</DropdownMenu.Item>
                      {onTogglePin && <DropdownMenu.Item onClick={() => onTogglePin(conversation)}><Pin size={13} aria-hidden="true" />{pinnedIds.includes(conversation.id) ? "取消置顶" : "置顶"}</DropdownMenu.Item>}
                      {onAssignFolder && folders.map((folder) => {
                        const assigned = folderAssignments[conversation.id] === folder.id;
                        return (
                          <DropdownMenu.Item key={folder.id} onClick={() => onAssignFolder(conversation, assigned ? null : folder.id)}>
                            <FolderPlus size={13} aria-hidden="true" />{assigned ? `移出${folder.name}` : `放入${folder.name}`}
                          </DropdownMenu.Item>
                        );
                      })}
                      <DropdownMenu.Item className="danger" onClick={() => openConversationDialog(onRemove, conversation)}><Trash2 size={13} aria-hidden="true" />删除</DropdownMenu.Item>
                    </DropdownMenuContent>
                  </DropdownMenu.Root>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
