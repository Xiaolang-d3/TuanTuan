import {
  ArrowDownUp,
  ArrowLeft,
  ChevronDown,
  Download,
  Expand,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  LibraryBundle,
  LibraryCollection,
  LibraryEditor,
  LibraryFolder,
  LibraryOrganization,
  LibrarySource,
  LibrarySourceDetail
} from "../../types";
import { type HomePendingFact } from "../home/home-metrics";
import { FilePreview } from "./FilePreview";
import { DocumentReviewPanel } from "../chat/DocumentReviewPanel";
import type { DocumentReviewService } from "../chat/document-review-service";
import { AttachmentPreviewDialog } from "../chat/AttachmentPreviewDialog";
import { LibraryImageThumbnail } from "./LibraryImageThumbnail";
import { LibraryDialog } from "./LibraryDialog";
import { LibraryFilters } from "./LibraryFilters";
import { LibraryKnowledgePanel } from "./LibraryKnowledgePanel";
import { LibraryCollections } from "./LibraryCollections";
import { emptyFileFilters, hasReadableText, knowledgeLabel, knowledgeUse, visibleLibrarySources, type FileFilters, type LibraryCategory, type LibraryFileType } from "./library-state";
import "./file-library.css";
import "./library-architecture.css";

type Props = {
  documentReviewService?: DocumentReviewService;
  onOpenDocuments?: () => void;
  initialSourceId?: number | null;
  onInitialSourceConsumed?: () => void;
  editor: LibraryEditor;
  sources: LibrarySource[];
  folders?: LibraryFolder[];
  collections?: LibraryCollection[];
  onCreateCollection?: (name: string, sourceIds?: number[]) => Promise<void>;
  onRenameCollection?: (id: number, name: string) => Promise<void>;
  onDeleteCollection?: (id: number) => Promise<void>;
  onUpdateCollectionSources?: (id: number, sourceIds: number[], action: "add" | "remove") => Promise<void>;
  busy: boolean;
  sourceBusy: boolean;
  enhancedParse: boolean;
  pendingFacts?: HomePendingFact[];
  confirmedFacts?: LibraryBundle["facts"];
  onChange: (editor: LibraryEditor) => void;
  onEnhancedParseChange: (enabled: boolean) => void;
  onImportFiles: (files: File[], folderId?: number | null, collectionId?: number | null) => void | Promise<void>;
  onCreateText: (
    title: string,
    content: string,
    privacy: "redacted" | "original",
    folderId?: number | null,
    collectionId?: number | null
  ) => void | Promise<void>;
  onLoadSource: (id: number) => Promise<LibrarySourceDetail>;
  onLoadOriginal?: (source: LibrarySourceDetail, signal?: AbortSignal) => Promise<Blob>;
  onLoadAsset?: (sourceId: number, assetId: string, signal?: AbortSignal) => Promise<Blob>;
  onUpdateSource: (
    id: number,
    changes: Partial<Pick<LibrarySource, "title" | "privacy_mode" | "enabled">> & { content?: string }
  ) => void | Promise<void>;
  onOrganizeSource?: (id: number, changes: LibraryOrganization) => Promise<void>;
  onCreateFolder?: (name: string) => Promise<void>;
  onSearchSources?: (query: string) => Promise<LibrarySource[]>;
  onUseForChat?: (ids: number[]) => Promise<void>;
  onDownloadSource: (source: LibrarySourceDetail) => void | Promise<void>;
  onDeleteSource: (id: number) => void | Promise<void>;
  onReviewFact?: (id: number, action: "confirm" | "reject") => void | Promise<void>;
  onSave: () => void | boolean | Promise<void | boolean>;
};
type Category = LibraryCategory;
type DialogKind = "folder" | "note" | "rename" | "move" | "trash" | "permanent" | "preferences" | "collection" | "renameCollection" | "deleteCollection" | "joinCollection" | "chat";
const categories: Array<[Category, string]> = [
  ["all", "全部文件"],
  ["recent", "最近使用"],
  ["favorites", "收藏"],
  ["trash", "回收站"]
];
const titles = {
  folder: "新建文件夹",
  note: "新建笔记",
  rename: "重命名文件",
  move: "移动文件",
  trash: "移入回收站",
  permanent: "永久删除",
  preferences: "文件库设置",
  collection: "新建主题集合",
  renameCollection: "重命名主题集合",
  deleteCollection: "删除主题集合",
  joinCollection: "加入主题集合",
  chat: "用于新对话"
};
function FileTypeIcon({ source }: { source: LibrarySource }) {
  const kind = source.mime_type.includes("pdf")
    ? "pdf"
    : source.mime_type.includes("word")
      ? "word"
      : source.mime_type.startsWith("image/")
        ? "image"
        : "text";
  const Icon = kind === "image" ? FileImage : FileText;
  return (
    <span className={`fl-file-icon ${kind}`}>
      <Icon size={16} strokeWidth={1.7} />
    </span>
  );
}
function sizeLabel(source: LibrarySource) {
  const bytes = source.size_bytes || 0;
  return bytes
    ? bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${source.character_count.toLocaleString()} 字`;
}
function dateLabel(value: string) {
  const date = new Date(/Z|\+\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return "—";
  const start = (item: Date) => new Date(item.getFullYear(), item.getMonth(), item.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(date)) / 86400000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
function Button({
  label,
  icon,
  primary,
  disabled,
  action
}: {
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  action: () => void;
}) {
  return (
    <button
      type="button"
      className={`fl-button ${primary ? "primary" : ""}`}
      aria-label={label}
      disabled={disabled}
      onClick={action}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function LibraryPage(props: Props) {
  const { sources, folders = [], collections = [], editor } = props;
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [area, setArea] = useState<"files" | "knowledge">("files");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [filters, setFilters] = useState<FileFilters>(emptyFileFilters);
  const [fileType, setFileType] = useState<LibraryFileType>("all");
  const [unfiled, setUnfiled] = useState(false);
  const [category, setCategory] = useState<Category>("all"),
    [folderId, setFolderId] = useState<number | null>(null);
  const [query, setQuery] = useState(""),
    [searchIds, setSearchIds] = useState<number[] | null>(null),
    [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<number[]>([]),
    [grid, setGrid] = useState(false),
    [ascending, setAscending] = useState(false);
  const [preview, setPreview] = useState<LibrarySourceDetail | null>(null),
    [previewId, setPreviewId] = useState<number | null>(null),
    [full, setFull] = useState(false),
    [loading, setLoading] = useState(false),
    [mode, setMode] = useState<"original" | "text">("original");
  const initialOpened = useRef<number | null>(null);
  useEffect(() => {
    if (!props.initialSourceId || initialOpened.current === props.initialSourceId) return;
    initialOpened.current = props.initialSourceId;
    void open(props.initialSourceId, true);
    props.onInitialSourceConsumed?.();
  }, [props.initialSourceId]);
  const [menu, setMenu] = useState<number | "new" | "workspace" | "selection" | null>(null),
    [dialog, setDialog] = useState<{ kind: DialogKind; ids: number[] } | null>(null);
  const [name, setName] = useState(""),
    [content, setContent] = useState(""),
    [target, setTarget] = useState("");
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [dragging, setDragging] = useState(false),
    [draft, setDraft] = useState<string | null>(null);
  const lock = useRef(false),
    request = useRef(0),
    input = useRef<HTMLInputElement>(null),
    search = useRef(props.onSearchSources);
  search.current = props.onSearchSources;
  const folder = folders.find((item) => item.id === folderId);
  const collection = collections.find((item) => item.id === collectionId);
  useEffect(() => {
    if (collectionId !== null && !collection) setCollectionId(null);
  }, [collectionId, collection]);
  useEffect(() => {
    let active = true;
    setSearchIds(null);
    if (!query.trim() || !search.current) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void search.current!(query)
        .then((results) => {
          if (active) setSearchIds(results.map((item) => item.id));
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : "搜索失败");
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, sources]);
  useEffect(() => {
    setSelected((current) => current.filter((id) => sources.some((source) => source.id === id)));
  }, [sources]);
  const mediaLibrary = fileType === "image" || fileType === "video";
  const effectiveFilters = mediaLibrary ? { ...filters, knowledge: "all" as const } : filters;
  const visible = visibleLibrarySources(sources, { category, fileType, folderId, unfiled, filters: effectiveFilters, query, searchIds, ascending, collectionSourceIds: collection?.source_ids });
  const filterActive = collectionId !== null || folderId !== null || unfiled || filters.origin !== "all" || effectiveFilters.knowledge !== "all";
  const scopeLabel = query
    ? "搜索结果"
    : category === "trash"
      ? "已删除文件"
      : collection?.name || (effectiveFilters.knowledge === "ready" ? "长期使用的资料" : category === "all" ? ({ all: "全部文件", image: "图片库", document: "文档库", video: "视频库" }[fileType]) : categories.find(([key]) => key === category)?.[1] || "");
  function resetFilters() {
    setFolderId(null);
    setUnfiled(false);
    setCollectionId(null);
    setFilters(emptyFileFilters);
    setSelected([]);
  }
  function showKnowledgeSources() {
    setToolsOpen(true);
    choose("all");
    setArea("files");
    setFilters({ origin: "all", knowledge: "ready" });
  }
  async function run(action: () => void | Promise<unknown>) {
    if (lock.current) return false;
    lock.current = true;
    setWorking(true);
    setError("");
    try {
      await action();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试");
      return false;
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  function closePreview() {
    request.current += 1;
    setPreview(null);
    setPreviewId(null);
    setLoading(false);
    setFull(false);
    setDraft(null);
  }
  function choose(next: Category, id: number | null = null) {
    setCategory(next);
    setFolderId(id);
    setCollectionId(null);
    setUnfiled(false);
    setFilters(emptyFileFilters);
    setSelected([]);
    setQuery("");
    setMenu(null);
    closePreview();
  }
  async function open(id: number, complete = false) {
    if (previewId === id && (preview || loading)) {
      if (complete && !preview?.mime_type.startsWith("image/") && !sources.find((item) => item.id === id)?.mime_type.startsWith("image/")) setFull(true);
      return;
    }
    const sequence = ++request.current;
    setArea("files");
    setLoading(true);
    setPreview(null);
    setPreviewId(id);
    setFull(complete && !sources.find((item) => item.id === id)?.mime_type.startsWith("image/"));
    setMode("original");
    setMenu(null);
    setError("");
    setDraft(null);
    try {
      const detail = await props.onLoadSource(id);
      if (sequence !== request.current) return;
      if (detail.trashed_at) throw new Error("请先恢复文件，再打开。");
      if (detail.mime_type.startsWith("image/")) setFull(false);
      setPreview(detail);
      await props.onOrganizeSource?.(id, { opened: true });
    } catch (reason) {
      if (sequence === request.current) {
        setPreviewId(null);
        setFull(false);
        setError(reason instanceof Error ? reason.message : "读取文件失败");
      }
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }
  async function reloadPreview(id: number) {
    const sequence = request.current;
    const detail = await props.onLoadSource(id);
    if (sequence === request.current) setPreview((current) => (current?.id === id ? detail : current));
  }
  function select(id: number, add = false) {
    setSelected((current) =>
      add ? (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) : [id]
    );
  }
  function show(kind: DialogKind, ids = selected) {
    setDialog({ kind, ids });
    setName(kind === "rename" ? sources.find((source) => source.id === ids[0])?.title || "" : kind === "renameCollection" ? collections.find((item) => item.id === ids[0])?.name || "" : "");
    setContent("");
    setTarget(kind === "joinCollection" ? String(collectionId ?? collections[0]?.id ?? "new") : folderId ? String(folderId) : "");
    setMenu(null);
  }
  async function organize(ids: number[], changes: LibraryOrganization) {
    if (!props.onOrganizeSource) throw new Error("文件管理接口不可用");
    for (const id of ids) await props.onOrganizeSource(id, changes);
  }
  async function download(ids: number[]) {
    for (const id of ids) await props.onDownloadSource(await props.onLoadSource(id));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    const success = await run(async () => {
      if (dialog.kind === "folder") await props.onCreateFolder?.(name.trim());
      if (dialog.kind === "collection") {
        if (!props.onCreateCollection) throw new Error("主题集合暂不可用");
        await props.onCreateCollection(name.trim());
      }
      if (dialog.kind === "renameCollection") {
        if (!props.onRenameCollection) throw new Error("主题集合暂不可用");
        await props.onRenameCollection(dialog.ids[0], name.trim());
      }
      if (dialog.kind === "deleteCollection") {
        if (!props.onDeleteCollection) throw new Error("主题集合暂不可用");
        await props.onDeleteCollection(dialog.ids[0]);
        setCollectionId(null);
      }
      if (dialog.kind === "joinCollection") {
        if (target === "new") {
          if (!props.onCreateCollection) throw new Error("主题集合暂不可用");
          await props.onCreateCollection(name.trim(), dialog.ids);
        } else {
          if (!props.onUpdateCollectionSources || !target) throw new Error("请选择主题集合");
          await props.onUpdateCollectionSources(Number(target), dialog.ids, "add");
        }
      }
      if (dialog.kind === "chat") {
        if (!props.onUseForChat) throw new Error("对话入口不可用");
        await props.onUseForChat(dialog.ids);
      }
      if (dialog.kind === "note") await props.onCreateText(name.trim() || "新建笔记", content, "redacted", folderId, collectionId);
      if (dialog.kind === "rename") await props.onUpdateSource(dialog.ids[0], { title: name.trim() });
      if (dialog.kind === "move") await organize(dialog.ids, { folder_id: target ? Number(target) : null });
      if (dialog.kind === "trash") await organize(dialog.ids, { trashed: true });
      if (dialog.kind === "permanent")
        for (const id of dialog.ids) {
          await props.onDeleteSource(id);
          setDialog((current) => (current ? { ...current, ids: current.ids.filter((item) => item !== id) } : null));
          setSelected((current) => current.filter((item) => item !== id));
        }
    });
    if (success) {
      setDialog(null);
      setSelected([]);
      closePreview();
    }
  }
  const disabled = working || props.sourceBusy;
  const useChat = (ids: number[]) => show("chat", ids);
  const actions = (ids: number[], isTrash = false) => (
    <div className="fl-selection-actions">
      {isTrash ? (
        <>
          <Button
            label="恢复"
            icon={<RotateCcw size={17} />}
            disabled={working}
            action={() =>
              void run(async () => {
                await organize(ids, { trashed: false });
                setSelected([]);
              })
            }
          />
          <Button
            label="永久删除"
            icon={<Trash2 size={17} />}
            disabled={working}
            action={() => show("permanent", ids)}
          />
        </>
      ) : (
        <>
          <Button
            label="用于对话"
            primary
            icon={<Sparkles size={17} />}
            disabled={working || ids.length > 8 || ids.some((id) => !hasReadableText(sources.find((source) => source.id === id)!))}
            action={() => useChat(ids)}
          />
          <Button label="加入主题集合" icon={<FolderPlus size={16} />} disabled={working || (!props.onUpdateCollectionSources && !props.onCreateCollection)} action={() => show("joinCollection", ids)} />
          <Button label="移动" icon={<Folder size={16} />} disabled={working || !props.onOrganizeSource} action={() => show("move", ids)} />
          <div className="fl-menu-wrap">
            <button type="button" className="fl-icon-button" aria-label="更多文件操作" title="更多文件操作" aria-expanded={menu === "selection"}
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "selection" ? null : "selection"); }}><MoreHorizontal size={19} /></button>
            {menu === "selection" && <div className="fl-menu">
              <Button
                label={ids.every((id) => sources.find((source) => source.id === id)?.enabled) ? "改为仅存档" : "开启长期使用"}
                disabled={working || ids.some((id) => !hasReadableText(sources.find((source) => source.id === id)!))}
                action={() => void run(async () => {
                  const enabled = !ids.every((id) => sources.find((source) => source.id === id)?.enabled);
                  for (const id of ids) await props.onUpdateSource(id, { enabled });
                })}
              />
              {collection && <Button label="移出当前集合" disabled={working} action={() => void run(async () => {
                if (!props.onUpdateCollectionSources) throw new Error("主题集合暂不可用");
                await props.onUpdateCollectionSources(collection.id, ids, "remove");
                setSelected([]);
              })} />}
              <Button
                label="下载"
                icon={<Download size={17} />}
                disabled={working}
                action={() => void run(() => download(ids))}
              />
              <Button label="删除" icon={<Trash2 size={17} />} disabled={working} action={() => show("trash", ids)} />
            </div>}
          </div>
        </>
      )}
      <button type="button" className="fl-icon-button" aria-label="取消选择" onClick={() => setSelected([])}>
        <X size={17} />
      </button>
    </div>
  );
  const imagePreview = Boolean(preview?.mime_type.startsWith("image/") || sources.find((item) => item.id === previewId)?.mime_type.startsWith("image/"));
  const viewer = preview && (
    <>
      <header className="fl-viewer-header">
        {full && <Button label="返回文件库" icon={<ArrowLeft size={19} />} action={closePreview} />}
        <FileTypeIcon source={preview} />
        <div>
          <h2 title={preview.title}>{preview.title}</h2>
          {!full && <small>{sizeLabel(preview)}</small>}
        </div>
        {full ? (
          <div className="fl-reader-actions">
            <Button
              label={sources.find((source) => source.id === preview.id)?.favorite ? "已收藏" : "收藏"}
              icon={<Star size={17} />}
              disabled={working}
              action={() =>
                void run(() =>
                  organize([preview.id], { favorite: !sources.find((source) => source.id === preview.id)?.favorite })
                )
              }
            />
            <Button
              label="下载"
              icon={<Download size={17} />}
              disabled={working}
              action={() => void run(() => download([preview.id]))}
            />
            <Button
              label="用于对话"
              primary
              icon={<Sparkles size={17} />}
              disabled={working || preview.parse_status !== "ready" || !preview.character_count}
              action={() => useChat([preview.id])}
            />
          </div>
        ) : (
          <button type="button" className="fl-icon-button" aria-label="关闭快速预览" onClick={closePreview}>
            <X size={20} />
          </button>
        )}
      </header>
      <nav className="fl-viewer-tabs" aria-label="文件内容">
        {(["original", "text"] as const).map((key) => (
          <button
            type="button"
            key={key}
            className={mode === key ? "active" : ""}
            onClick={() => {
              setMode(key);
              if (key === "original") setDraft(null);
            }}
          >
            {key === "original" ? "原文件" : preview.mime_type.startsWith("image/") ? "图片文字与说明" : preview.mime_type.startsWith("video/") ? "视频说明" : "AI 读取内容"}
          </button>
        ))}
        <span>
          <Info size={15} />
          {preview.privacy_mode === "original" ? "模型使用原始文字" : "模型使用脱敏文字"}
        </span>
      </nav>
      <div className="fl-preview-scroll">
        {props.documentReviewService && draft === null && preview.character_count > 0 ? <DocumentReviewPanel service={props.documentReviewService} source={preview} /> : null}
        {(preview.mime_type.startsWith("image/") || preview.mime_type.startsWith("video/")) && <p className="fl-media-notice" role="note">
          {preview.mime_type.startsWith("image/") ? "图片可预览；导入时会尝试在本机提取图片中的文字。用于对话时只提供提取或补充的文字，暂不直接分析画面。" : "视频暂不支持上传、播放或分析画面与声音。"}
        </p>}
        {draft !== null ? (
          <label className="fl-text-page">
            编辑用于问答的文字
            <textarea aria-label="编辑资料正文" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
        ) : (
          <FilePreview source={preview} mode={mode} loadOriginal={props.onLoadOriginal} loadAsset={props.onLoadAsset} />
        )}
      </div>
      <footer className={`fl-viewer-footer ${full ? "" : "is-pinned"}`}>
        <section className="fl-source-use" aria-label="资料使用范围">
          <label>
            长期使用
            <input type="checkbox" checked={preview.enabled} disabled={working || !hasReadableText(preview)}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(async () => { await props.onUpdateSource(preview.id, { enabled }); await reloadPreview(preview.id); });
              }} />
          </label>
          <p>{!hasReadableText(preview) ? (preview.mime_type.startsWith("image/") || preview.mime_type.startsWith("video/") ? "暂无可检索文字，可添加说明后用于文字检索。" : "暂无可检索正文，请先补充 AI 读取内容。") : preview.enabled ? "可在后续对话中检索，遵循资料记忆设置。" : "仅存档。手动用于对话不会开启长期使用。"}</p>
          {collections.some((item) => item.source_ids.includes(preview.id)) && <small>主题：{collections.filter((item) => item.source_ids.includes(preview.id)).map((item) => item.name).join("、")}</small>}
        </section>
        <details>
          <summary>隐私设置</summary>
          <label>
            <input type="checkbox" checked={preview.privacy_mode === "original"} disabled={working}
              onChange={(event) => {
                const checked = event.target.checked;
                void run(async () => {
                  await props.onUpdateSource(preview.id, { privacy_mode: checked ? "original" : "redacted" });
                  await reloadPreview(preview.id);
                });
              }} />
            允许模型使用原文
          </label>
        </details>
        <div>
          {mode === "text" &&
            (draft === null ? (
              <Button label={preview.mime_type.startsWith("image/") || preview.mime_type.startsWith("video/") ? "编辑文字说明" : "编辑正文"} action={() => setDraft(preview.content)} />
            ) : (
              <>
                <Button
                  label="保存正文"
                  primary
                  disabled={working || !draft.trim()}
                  action={() =>
                    void run(async () => {
                      await props.onUpdateSource(preview.id, { content: draft });
                      await reloadPreview(preview.id);
                      setDraft(null);
                    })
                  }
                />
                <Button label="取消" action={() => setDraft(null)} />
              </>
            ))}
          {!full && (
            <>
              <Button
                label="用于对话"
                primary
                icon={<Sparkles size={16} />}
                disabled={working || preview.parse_status !== "ready" || !preview.character_count}
                action={() => useChat([preview.id])}
              />
              <Button label="完整打开" icon={<Expand size={17} />} action={() => setFull(true)} />
            </>
          )}
        </div>
      </footer>
      {preview.metadata.content_edited ? (
        <small className="fl-original-note">正文已校正，原文件保持导入时版本。</small>
      ) : null}
    </>
  );
  return (
    <section
      className={`file-library ${full ? "fl-full" : ""}`}
      onClick={() => setMenu(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !dialog) { setMenu(null); closePreview(); }
      }}
    >
      {error && !dialog && (
        <p className="fl-error" role="alert">
          {error}
          <button type="button" aria-label="关闭文件错误" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </p>
      )}
      {!full && <header className="fl-header">
        <h1>文件库</h1>
        <nav className="fl-workspace-navigation" aria-label="文件类型">
          {([["all", "全部"], ["image", "图像"], ["document", "文档"], ["video", "视频"]] as const).map(([key, label]) => (
            <button type="button" key={key} aria-current={area === "files" && fileType === key ? "page" : undefined}
              onClick={() => { setArea("files"); setFileType(key); setSelected([]); closePreview(); setMenu(null); }}>{label}</button>
          ))}
        </nav>
        <div className="fl-header-actions">
          {area === "files" && <div className="fl-menu-wrap">
            <button type="button" className="fl-button primary" aria-expanded={menu === "new"} disabled={disabled}
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "new" ? null : "new"); }}>
              {props.sourceBusy ? <LoaderCircle className="spinning" size={17} /> : <Plus size={17} />}添加<ChevronDown size={14} />
            </button>
            {menu === "new" && <div className="fl-menu">
              <button type="button" onClick={() => { setMenu(null); input.current?.click(); }}><Upload size={16} />上传文件</button>
              <button type="button" disabled={!props.onCreateFolder} onClick={() => show("folder")}><Folder size={16} />新建文件夹</button>
              <button type="button" disabled={!props.onCreateCollection} onClick={() => show("collection")}><Sparkles size={16} />新建主题集合</button>
              <button type="button" onClick={() => show("note")}><Pencil size={16} />新建笔记</button>
            </div>}
          </div>}
          <div className="fl-menu-wrap">
            <button type="button" className="fl-icon-button" aria-label="文件库更多选项" title="更多选项" aria-expanded={menu === "workspace"}
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "workspace" ? null : "workspace"); }}><MoreHorizontal size={20} /></button>
            {menu === "workspace" && <div className="fl-menu">
              <button type="button" onClick={() => { setArea("files"); setToolsOpen(!toolsOpen); if (toolsOpen) { setQuery(""); resetFilters(); setCategory("all"); } setMenu(null); }}><Search size={16} />{toolsOpen ? "收起搜索与筛选" : "搜索与筛选"}</button>
              <button type="button" onClick={() => { closePreview(); setArea("knowledge"); setSelected([]); setMenu(null); }}>知识</button>
                {props.onOpenDocuments ? <button type="button" onClick={() => { setMenu(null); props.onOpenDocuments?.(); }}><FileText size={16} />文档成果</button> : null}
                <button type="button" onClick={() => show("preferences")}><Settings size={16} />文件库设置</button>
            </div>}
          </div>
        </div>
        <input ref={input} className="fl-hidden" type="file" aria-label="选择上传文件" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            void run(() => props.onImportFiles(files, folderId, collectionId));
          }} />
      </header>}
      {area === "knowledge" ? <LibraryKnowledgePanel
        sources={sources} pendingFacts={props.pendingFacts || []} confirmedFacts={props.confirmedFacts || []}
        working={working} reviewAvailable={Boolean(props.onReviewFact)}
        onShowSources={showKnowledgeSources} onReview={(id, action) => run(async () => {
          if (!props.onReviewFact) throw new Error("知识审核接口不可用");
          await props.onReviewFact(id, action);
        })}
      /> : full && !imagePreview && (preview || loading) ? (
        <section className="fl-reader" aria-label="文件阅读器">
          {preview ? (
            viewer
          ) : (
            <p role="status" className="fl-empty">
              正在读取文件…
              <button type="button" onClick={closePreview}>
                返回文件库
              </button>
            </p>
          )}
        </section>
      ) : (
          <div className={`fl-body ${!imagePreview && (preview || loading) ? "with-preview" : ""}`}>
            <section
              className="fl-browser"
              onDragOver={(event) => {
                if (!disabled && category !== "trash") {
                  event.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (!disabled && category !== "trash")
                  void run(() => props.onImportFiles(Array.from(event.dataTransfer.files), folderId, collectionId));
              }}
            >
              {toolsOpen && <><div className="fl-search-row">
                <label className="fl-search">
                  <Search size={16} />
                  <input aria-label="搜索文件名或内容" placeholder="搜索文件名或内容" value={query}
                    onChange={(event) => { setQuery(event.target.value); setSelected([]); }} />
                  {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={16} /></button>}
                </label>
              </div>
              <div className="fl-module-navigation">
                <div className="fl-scope-controls">
                  <label className="fl-scope-select">
                    <select aria-label="文件范围" value={category} onChange={(event) => { setCategory(event.target.value as Category); setSelected([]); closePreview(); }}>
                      {categories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </label>
                  <label className={`fl-scope-select${folderId !== null || unfiled ? " is-active" : ""}`} title="目录是存放位置，一份文件只属于一个目录">
                    <Folder size={14} />
                    <select aria-label="筛选目录" value={unfiled ? "unfiled" : folderId ?? "all"}
                      onChange={(event) => {
                        const value = event.target.value;
                        setFolderId(value === "all" || value === "unfiled" ? null : Number(value));
                        setUnfiled(value === "unfiled");
                        setSelected([]);
                        closePreview();
                      }}>
                      <option value="all">目录</option>
                      <option value="unfiled">未分类</option>
                      {folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <LibraryCollections collections={collections} selectedId={collectionId} busy={working}
                    onSelect={(id) => { setCollectionId(id); setSelected([]); closePreview(); }}
                    onRename={(id) => show("renameCollection", [id])} onDelete={(id) => show("deleteCollection", [id])} />
                  <LibraryFilters filters={filters} showKnowledge={!mediaLibrary} onChange={(next) => { setFilters(next); setSelected([]); }} />
                  <div className="fl-view-controls">
                    <button type="button" className="fl-sort" aria-pressed={ascending} aria-label={ascending ? "按时间从新到旧" : "按时间从旧到新"}
                      title={ascending ? "当前从旧到新，点击切换" : "当前从新到旧，点击切换"} onClick={() => setAscending(!ascending)}>
                      <ArrowDownUp size={15} /><span>{ascending ? "最早优先" : "最新优先"}</span>
                    </button>
                    <div className="fl-view-switch" role="group" aria-label="文件视图">
                      <button type="button" className="fl-icon-button" aria-label="列表视图" title="列表视图" aria-pressed={!grid} onClick={() => setGrid(false)}><List size={16} /></button>
                      <button type="button" className="fl-icon-button" aria-label="网格视图" title="网格视图" aria-pressed={grid} onClick={() => setGrid(true)}><LayoutGrid size={16} /></button>
                    </div>
                  </div>
                </div>
              </div>
              </>}
              {selected.length > 8 && category !== "trash" && <p className="fl-use-warning" role="status">一次对话最多带入 8 个文件，请减少选择。</p>}
              {selected.some((id) => !hasReadableText(sources.find((source) => source.id === id)!)) && category !== "trash" &&
                <p className="fl-use-warning" role="status">所选文件中有无可检索文字的文件。请先打开文件，补充文字或说明；图片与视频画面不会直接用于分析。</p>}
              {toolsOpen && <div className="fl-files-heading">
                <div className="fl-file-context">
                  <nav className="fl-breadcrumb" aria-label="文件路径">
                    {folder || unfiled ? <>
                      <button type="button" onClick={resetFilters}>全部文件</button>
                      <span aria-hidden="true">/</span><strong>{unfiled ? "未分类" : folder?.name}</strong>
                    </> : scopeLabel ? <strong>{scopeLabel}</strong> : null}
                  </nav>
                  <span>{visible.length} 个文件</span>
                  {searching && <small role="status">搜索中…</small>}
                </div>
                {filterActive && <button type="button" className="fl-filter-reset" onClick={resetFilters}>清除筛选</button>}
              </div>}
              {!visible.length ? (
                <div className="fl-empty">
                  <Folder size={36} />
                  <h3>
                    {query || filterActive
                      ? "没有找到匹配的文件"
                      : category === "trash"
                        ? "回收站是空的"
                        : category === "favorites"
                          ? "还没有收藏的文件"
                          : category === "recent"
                            ? "还没有最近打开的文件"
                            : "这里还没有文件"}
                  </h3>
                  <p>
                    {query || filterActive ? "试试其他关键词，或清除筛选扩大范围。" : category === "trash" ? "删除的文件会在这里保留，可以恢复。" : fileType === "video" ? "视频分类已准备好，当前暂不支持上传视频。" : "将文件拖入此处，开始整理资料。"}
                  </p>
                  {(query || filterActive) && <button type="button" className="fl-button" onClick={() => { setQuery(""); resetFilters(); }}>清除搜索和筛选</button>}
                </div>
              ) : (
                <>{[
                  { images: true, items: category === "trash" ? [] : visible.filter((source) => source.mime_type.startsWith("image/")) },
                  { images: false, items: visible.filter((source) => category === "trash" || !source.mime_type.startsWith("image/")) }
                ].filter((group) => group.items.length).map(({ images, items }) => (
                images ? <div key="images" className="fl-image-gallery" role="group" aria-label="图片列表">
                  {items.map((source) => <button key={source.id} type="button" className="fl-image-tile"
                    aria-label={`预览 ${source.title}`}
                    onClick={(event) => { if (event.detail < 2) void open(source.id); }}
                    onDoubleClick={() => void open(source.id, true)}>
                    <LibraryImageThumbnail source={source} loadOriginal={props.onLoadOriginal} />
                  </button>)}
                </div> :
                <table key="documents" className={`fl-table ${grid ? "fl-grid" : ""}`} aria-label="文件列表">
                  <thead>
                    <tr>
                      <th className="fl-check">
                        <input
                          type="checkbox"
                          aria-label="选择当前全部文件"
                          checked={items.every((source) => selected.includes(source.id))}
                          onChange={(event) =>
                            setSelected((current) => event.target.checked
                              ? [...new Set([...current, ...items.map((source) => source.id)])]
                              : current.filter((id) => !items.some((source) => source.id === id)))
                          }
                        />
                      </th>
                      <th>名称</th>
                      {!mediaLibrary && <th className="fl-status">AI 使用</th>}
                      <th className="fl-size">大小</th>
                      <th className="fl-date">修改时间</th>
                      <th className="fl-actions">
                        <span className="fl-hidden">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((source) => (
                      <tr
                        key={source.id}
                        tabIndex={0}
                        aria-selected={selected.includes(source.id)}
                        className={`${selected.includes(source.id) ? "selected" : ""} ${previewId === source.id ? "is-previewing" : ""}`}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey) select(source.id, true);
                          else if (category !== "trash" && event.detail < 2) void open(source.id);
                        }}
                        onDoubleClick={() => category !== "trash" && void open(source.id, true)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget || category === "trash") return;
                          if (event.key === "Enter" || event.code === "Space") {
                            event.preventDefault();
                            void open(source.id, event.key === "Enter");
                          }
                        }}
                      >
                        <td className="fl-check" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${source.title}`}
                            checked={selected.includes(source.id)}
                            onChange={() => select(source.id, true)}
                          />
                        </td>
                        <td>
                          <div className="fl-filename">
                            <FileTypeIcon source={source} />
                            <div>
                              <button type="button" className="fl-file-title" title={source.original_filename || source.title}
                                aria-label={category === "trash" ? undefined : `预览 ${source.title}`} disabled={category === "trash"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (category === "trash" || event.detail > 1) return;
                                  void open(source.id);
                                }}
                                onDoubleClick={(event) => {
                                  event.stopPropagation();
                                  if (category !== "trash") void open(source.id, true);
                                }}>
                                {source.title}
                              </button>
                              <small className="fl-origin">
                                {source.original_filename && source.original_filename !== source.title ? source.original_filename
                                  : source.source_uri.startsWith("chat:") ? "对话成果" : source.source_kind === "paste" ? "文本笔记" : "导入文件"}
                              </small>
                            </div>
                            {source.favorite && <Star size={14} className="fl-favorite" fill="currentColor" />}
                          </div>
                        </td>
                        {!mediaLibrary && <td className="fl-status"><span className={`fl-knowledge-badge ${source.trashed_at ? "archive" : knowledgeUse(source)}`}>{knowledgeLabel(source)}</span></td>}
                        <td className="fl-size">{sizeLabel(source)}</td>
                        <td className="fl-date" title={source.updated_at}>
                          {dateLabel(source.updated_at)}
                        </td>
                        <td className="fl-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                          {category === "trash" ? (
                            <button
                              type="button"
                              className="fl-icon-button"
                              aria-label={`恢复 ${source.title}`}
                              disabled={working}
                              onClick={() => void run(() => organize([source.id], { trashed: false }))}
                            >
                              <RotateCcw size={17} />
                            </button>
                          ) : (
                            <div className="fl-menu-wrap">
                              <button
                                type="button"
                                className="fl-icon-button"
                                aria-label={`操作 ${source.title}`}
                                aria-expanded={menu === source.id}
                                onClick={() => setMenu(menu === source.id ? null : source.id)}
                              >
                                <MoreHorizontal size={20} />
                              </button>
                              {menu === source.id && (
                                <div className="fl-menu">
                                  {[
                                    "快速预览",
                                    "完整打开",
                                    source.favorite ? "取消收藏" : "收藏",
                                    "重命名",
                                    "移动",
                                    "下载",
                                    "移入回收站"
                                  ].map((label) => (
                                    <button
                                      type="button"
                                      key={label}
                                      disabled={working}
                                      onClick={() => {
                                        setMenu(null);
                                        if (label === "快速预览" || label === "完整打开")
                                          void open(source.id, label === "完整打开");
                                        else if (label.includes("收藏"))
                                          void run(() => organize([source.id], { favorite: !source.favorite }));
                                        else if (label === "下载") void run(() => download([source.id]));
                                        else
                                          show(label === "重命名" ? "rename" : label === "移动" ? "move" : "trash", [
                                            source.id
                                          ]);
                                      }}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                ))}</>
              )}
              {selected.length > 0 && (
                <div className="fl-selection-dock" role="toolbar" aria-label="批量文件操作">
                  <span>已选 {selected.length} 个文件</span>
                  {actions(selected, category === "trash")}
                </div>
              )}
              <footer className="fl-browser-footer">
                <span>{selected.length ? "用于对话仅带入副本，不会开启长期使用" : "支持拖入文件，或通过「添加」新建笔记"}</span>
                <span>
                  <Info size={16} />
                  单击预览 · 双击完整打开
                </span>
              </footer>
              {dragging && (
                <div className="fl-drop">
                  <Upload size={38} />
                  松开即可添加文件
                </div>
              )}
            </section>
            {!imagePreview && (preview || loading) ? (
              <aside className="fl-preview" aria-label="文件快速预览">
                {preview ? (
                  viewer
                ) : (
                  <div className="fl-empty" role="status">
                    正在读取文件…
                    <button type="button" onClick={closePreview}>
                      取消
                    </button>
                  </div>
                )}
              </aside>
            ) : null}
          </div>
      )}
      {imagePreview && preview && <AttachmentPreviewDialog
        attachment={{ id: `library-${preview.id}`, kind: "image", original_filename: preview.original_filename || preview.title,
          parse_status: "parsed", content_type: preview.mime_type, size_bytes: preview.size_bytes }}
        loadOriginal={props.onLoadOriginal ? async (_attachment, signal) => ({ file: await props.onLoadOriginal!(preview, signal) }) : undefined}
        onClose={closePreview}
      />}
      {dialog && (
        <LibraryDialog title={titles[dialog.kind]} close={() => !working && setDialog(null)}>
          {error && (
            <p className="fl-dialog-error" role="alert">
              {error}
            </p>
          )}
          {dialog.kind === "preferences" ? (
            <div className="fl-preferences">
              <label>
                称呼（可选）
                <input
                  aria-label="称呼"
                  value={editor.name}
                  onChange={(event) => props.onChange({ ...editor, name: event.target.value })}
                />
              </label>
              <Button
                label="保存个性化信息"
                disabled={working || props.busy}
                action={() =>
                  void run(async () => {
                    if ((await props.onSave()) === false) throw new Error("保存失败，请重试");
                  })
                }
              />
              <label>
                <input
                  type="checkbox"
                  checked={props.enhancedParse}
                  onChange={(event) => props.onEnhancedParseChange(event.target.checked)}
                />
                复杂排版解析
              </label>
              <p className="fl-settings-hint">知识审核已移至“知识”入口。复杂排版解析仅影响后续导入。</p>
            </div>
          ) : (
            <form onSubmit={(event) => void save(event)}>
              {["folder", "note", "rename", "collection", "renameCollection"].includes(dialog.kind) && (
                <label className="fl-field">
                  {dialog.kind === "folder" ? "文件夹名称" : ["collection", "renameCollection"].includes(dialog.kind) ? "主题集合名称" : "文件名称"}
                  <input
                    aria-label={dialog.kind === "folder" ? "文件夹名称" : ["collection", "renameCollection"].includes(dialog.kind) ? "主题集合名称" : "文件名称"}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={180}
                  />
                </label>
              )}
              {dialog.kind === "collection" && <p className="fl-settings-hint">例如“面试准备”“阅读计划”。文件可以加入多个主题，无需复制原件。</p>}
              {dialog.kind === "joinCollection" && <>
                <label className="fl-field">主题集合
                  <select aria-label="目标主题集合" required value={target} onChange={(event) => setTarget(event.target.value)}>
                    {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    {props.onCreateCollection && <option value="new">新建主题集合…</option>}
                  </select>
                </label>
                {target === "new" && <label className="fl-field">主题集合名称
                  <input aria-label="主题集合名称" required maxLength={180} value={name} onChange={(event) => setName(event.target.value)} />
                </label>}
                <p className="fl-settings-hint">加入集合只整理文件，不会开启长期使用，也不会移动原件。</p>
              </>}
              {dialog.kind === "deleteCollection" && <p>删除“{collections.find((item) => item.id === dialog.ids[0])?.name}”集合？其中的文件和长期使用设置都会保留。</p>}
              {dialog.kind === "chat" && <>
                <p>将 {dialog.ids.length} 个文件带入新对话，填写问题后发送。</p>
                <ul className="fl-chat-files">{dialog.ids.map((id) => <li key={id}>{sources.find((item) => item.id === id)?.title}</li>)}</ul>
                <p className="fl-settings-hint">仅在这段对话中使用导入时的副本，不会开启长期使用。其他长期资料仍按记忆设置使用。</p>
              </>}
              {dialog.kind === "note" && (
                <label className="fl-field">
                  笔记内容
                  <textarea
                    aria-label="笔记内容"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    required
                    rows={7}
                  />
                </label>
              )}
              {dialog.kind === "move" && (
                <label className="fl-field">
                  移动到
                  <select aria-label="目标文件夹" value={target} onChange={(event) => setTarget(event.target.value)}>
                    <option value="">未分类（根目录）</option>
                    {folders.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {dialog.kind === "trash" && (
                <p>将 {dialog.ids.length} 个文件移入回收站，可以恢复。回收站文件不再作为资料依据。</p>
              )}
              {dialog.kind === "permanent" && <p>永久删除 {dialog.ids.length} 个文件及原件？此操作无法恢复。</p>}
              <footer>
                <Button label="取消" disabled={working} action={() => setDialog(null)} />
                <button
                  type="submit"
                  className={`fl-button ${dialog.kind === "permanent" ? "danger" : "primary"}`}
                  disabled={working || (dialog.kind === "joinCollection" && !props.onCreateCollection && !collections.length)}
                >
                  {working
                    ? "处理中…"
                    : dialog.kind === "folder"
                      ? "创建"
                      : dialog.kind === "note"
                        ? "创建笔记"
                        : dialog.kind === "rename"
                          ? "保存"
                          : dialog.kind === "chat" ? "创建对话" : titles[dialog.kind]}
                </button>
              </footer>
            </form>
          )}
        </LibraryDialog>
      )}
    </section>
  );
}
