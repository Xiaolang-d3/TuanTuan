import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Download, FileText, Presentation } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { createImageStudioApi, type StudioWork } from "./imageStudioApi";
import { readCreationRecords, type CreationRecord } from "./creationRecordsApi";
import type { DocumentSummary } from "../chat/document-service";
import type { ChatAttachment } from "../chat/types";
import { createFinalWorksApi, type FinalWork } from "./finalWorksApi";
import { downloadBlob } from "../chat/result-files";
import { StudioDialog, StudioOriginal, StudioThumb, useStudioBlob } from "./StudioMedia";
import { failureMessage, type StudioApi } from "./useImageWorkspace";
import type { StudioConnection } from "./ImageWorkspacePage";
import "./ImageWorkspace.css";
import "./WorksPage.css";

const filters = { all: "全部", image: "图片", document: "文档", presentation: "演示文稿" } as const;
type WorkFilter = keyof typeof filters;
/** 作品来源：archived 为手动存档的定稿，generated 为生成图片，record 为对话中产出的文档或演示文稿。 */
type GalleryWork = (FinalWork & { origin: "archived" })
  | { origin: "archived"; id: string; kind: "image"; filename: string; created_at: string; image: StudioWork }
  | { origin: "generated"; id: string; kind: "image"; filename: string; created_at: string; asset: ChatAttachment }
  | { origin: "record"; id: string; kind: "document" | "presentation"; filename: string; created_at: string; conversation_id: number | null };
type WorkSource = "images" | "files" | "generated" | "documents" | "presentations";
const sources: WorkSource[] = ["images", "files", "generated", "documents", "presentations"];
const sourceKinds: Record<WorkSource, WorkFilter> = { images: "image", files: "all", generated: "image", documents: "document", presentations: "presentation" };
const idle = () => Object.fromEntries(sources.map(key => [key, ""])) as Record<WorkSource, string>;
const busy = () => Object.fromEntries(sources.map(key => [key, true])) as Record<WorkSource, boolean>;

function WorkDetail({ id, name, load, close }: { id: string; name: string; load: StudioApi["workFile"]; close: () => void }) {
  const image = useStudioBlob(id, load);
  return <StudioDialog title="作品详情" onClose={close}><div className="studio-work-preview"><StudioOriginal image={image} name={name}/><h3>{name}</h3><button className="studio-primary" disabled={!image.file} onClick={() => { if (image.file) downloadBlob(image.file.blob, name); }}><Download size={15}/>下载原图</button></div></StudioDialog>;
}

function FileDetail({ work, api, close }: { work: FinalWork; api: ReturnType<typeof createFinalWorksApi>; close: () => void }) {
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const blob = await api.file(work.id, controller.signal);
      if (!controller.signal.aborted) downloadBlob(blob, work.filename);
    } catch (caught) {
      if (!controller.signal.aborted) setError(failureMessage(caught));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }

  return <StudioDialog title="作品详情" onClose={close}>
    <div className="studio-work-preview final-work-detail">
      <h3>{work.filename}</h3>
      <p>{filters[work.kind]} · {work.created_at.slice(0, 10)} · {new Intl.NumberFormat("zh-CN").format(work.size)} 字节</p>
      <p>此定稿独立保存；来源的后续编辑不会改变它。</p>
      {error && <p className="studio-error" role="alert">{error}</p>}
      <ActionButton variant="primary" disabled={busy} onClick={() => void download()}><Download size={15} aria-hidden="true"/>{busy ? "正在下载…" : "下载定稿"}</ActionButton>
    </div>
  </StudioDialog>;
}

function dimensions(work: GalleryWork) {
  const asset = work.origin === "generated" ? work.asset : work.origin === "archived" && work.kind === "image" ? work.image.asset : null;
  return asset?.width && asset.height ? `${asset.width} × ${asset.height} · ` : null;
}

/**
 * 我的作品：集中展示生成的图片、文档、演示文稿与手动存档的定稿。
 * onOpenRecord 打开对话中产出的文档或演示文稿的来源。
 */
export function WorksPage({ apiBase, accessToken, fetchJson, ready, active = true, onOpenImages, onOpenRecord, linkedWork, onCloseLinkedWork }: StudioConnection & {
  onOpenImages: () => void; onOpenRecord?: (record: Pick<CreationRecord, "kind" | "id" | "conversation_id">) => void;
  linkedWork?: string; onCloseLinkedWork?: () => void;
}) {
  const api = useMemo(() => createImageStudioApi(apiBase, accessToken, fetchJson), [apiBase, accessToken, fetchJson]);
  const finalApi = useMemo(() => createFinalWorksApi(apiBase, accessToken, fetchJson), [apiBase, accessToken, fetchJson]);
  const [images, setImages] = useState<StudioWork[]>([]);
  const [files, setFiles] = useState<FinalWork[]>([]);
  const [generated, setGenerated] = useState<GalleryWork[]>([]);
  const [records, setRecords] = useState<{ documents: GalleryWork[]; presentations: GalleryWork[] }>({ documents: [], presentations: [] });
  const [loading, setLoading] = useState(busy);
  const [errors, setErrors] = useState(idle);
  const [selected, setSelected] = useState<GalleryWork | null>(null);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [count, setCount] = useState(24);

  useEffect(() => {
    if (!active || !ready) return;
    const controller = new AbortController();
    setLoading(busy());
    setErrors(idle());
    function load<T>(key: WorkSource, read: () => Promise<T>, apply: (result: T) => void) {
      void Promise.resolve().then(read).then(result => { if (!controller.signal.aborted) apply(result); })
        .catch(caught => { if (!controller.signal.aborted) setErrors(current => ({ ...current, [key]: failureMessage(caught) })); })
        .finally(() => { if (!controller.signal.aborted) setLoading(current => ({ ...current, [key]: false })); });
    }
    load("images", () => api.works(controller.signal), result => setImages(result.items));
    load("files", () => finalApi.list(controller.signal), result => setFiles(result.items));
    // 生成图片按任务展开为单张，已完成的任务才有可用图片。
    load("generated", () => api.history({ limit: 100, status: "done", signal: controller.signal }), result => setGenerated(result.items.flatMap(task => task.assets
      .filter(asset => asset.kind === "image")
      .map(asset => ({ origin: "generated" as const, id: asset.id, kind: "image" as const, filename: asset.original_filename, created_at: task.created_at, asset })))));
    load("documents", () => fetchJson<{ documents?: DocumentSummary[] }>("/documents", { signal: controller.signal, cache: "no-store" }), result => setRecords(current => ({ ...current,
      documents: (result.documents ?? []).map(item => ({ origin: "record" as const, id: item.document_id, kind: "document" as const, filename: item.title || "未命名文档", created_at: item.created_at, conversation_id: item.conversation_id })) })));
    load("presentations", () => readCreationRecords(fetchJson, { kind: "presentation", limit: 50, signal: controller.signal }), result => setRecords(current => ({ ...current,
      presentations: result.items.filter(item => item.status === "succeeded").map(item => ({ origin: "record" as const, id: item.id, kind: "presentation" as const, filename: item.title || "未命名演示文稿", created_at: item.updated_at, conversation_id: item.conversation_id })) })));
    return () => controller.abort();
  }, [active, ready, api, finalApi, fetchJson, retry]);

  // 已存档的图片与其生成原图是同一张，只保留存档版本，避免重复。
  const archivedAssets = new Set(images.map(image => image.asset.id));
  const items: GalleryWork[] = [
    ...images.map(image => ({ origin: "archived" as const, id: image.id, kind: "image" as const, filename: image.asset.original_filename, created_at: image.created_at, image })),
    ...files.map(file => ({ ...file, origin: "archived" as const })),
    ...generated.filter(work => !archivedAssets.has(work.id)),
    ...records.documents,
    ...records.presentations,
  ];
  const linked = linkedWork && items.find(work => work.origin === "archived" && `${work.kind === "image" ? "image_work" : "final_work"}:${work.id}` === linkedWork);
  const opened = selected ?? (linked || null);
  function closeWork() {
    setSelected(null);
    if (linkedWork) onCloseLinkedWork?.();
  }
  function openWork(work: GalleryWork) {
    if (work.origin === "record") onOpenRecord?.({ kind: work.kind, id: work.id, conversation_id: work.conversation_id });
    else setSelected(work);
  }
  const visible = items.filter(item => filter === "all" || item.kind === filter).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const relevant = sources.filter(key => filter === "all" || sourceKinds[key] === "all" || sourceKinds[key] === filter);
  const pending = relevant.some(key => loading[key]);
  const failed = relevant.some(key => errors[key]);
  const settled = sources.every(key => !loading[key] && !errors[key]);

  return <section className="studio" aria-label="我的作品">
    <header className="studio-head"><div><p className="studio-kicker">创作空间</p><h1>我的作品</h1><p>生成的图片、文档和演示文稿都在这里；存档的定稿独立于来源保存。</p></div><button onClick={onOpenImages}>去图片创作<ArrowRight size={15}/></button></header>
    <div className="studio-scroll" aria-busy={pending}>
      <div className="final-work-filters" role="group" aria-label="作品类型">
        {(Object.keys(filters) as WorkFilter[]).map(value => <ActionButton key={value} variant="secondary" aria-pressed={filter === value} onClick={() => { setFilter(value); setCount(24); }}>{filters[value]}</ActionButton>)}
      </div>
      {linkedWork && !linked && settled && <p role="status">关联的作品已不存在。</p>}
      {failed && <p role="alert" className="studio-error">部分作品未能读取。 <button onClick={() => setRetry(value => value + 1)}>重新加载</button></p>}
      {pending && !visible.length ? <p role="status">正在读取作品…</p> : !failed && !visible.length ? <div className="studio-empty"><Archive/><h2>还没有{filter === "all" ? "作品" : filters[filter]}</h2><p>在工作台生成图片、文档或 PPT 后，会自动出现在这里。</p></div> : null}
      <div className="studio-grid">{visible.slice(0, count).map(work => <article className="studio-card" key={`${work.origin}:${work.kind}:${work.id}`}>
        <button className={`studio-card-cover${work.kind === "image" ? "" : " final-work-cover"}`} onClick={() => openWork(work)} aria-label={`打开 ${work.filename}`}>
          {work.kind === "image" ? <StudioThumb id={work.id} load={work.origin === "generated" ? api.thumbnail : api.workThumbnail}/> : <>{work.kind === "document" ? <FileText size={34} aria-hidden="true"/> : <Presentation size={34} aria-hidden="true"/>}<span>{work.origin === "record" ? filters[work.kind] : work.kind === "document" ? "Markdown" : "PPTX"}</span></>}
        </button>
        <div className="studio-card-body"><strong>{work.filename}</strong><p>{dimensions(work) ?? `${filters[work.kind]} · `}{work.created_at.slice(0, 10)}{work.origin === "archived" ? " · 已存档" : ""}</p><button onClick={() => openWork(work)}>{work.origin === "record" ? "打开来源" : "查看作品"}</button></div>
      </article>)}</div>
      {visible.length > count && <button onClick={() => setCount(value => value + 24)}>加载更多作品</button>}
    </div>
    {active && opened && (opened.origin === "generated" ? <WorkDetail key={`generated:${opened.id}`} id={opened.id} name={opened.filename} load={api.assetFile} close={closeWork}/>
      : opened.origin === "archived" && opened.kind === "image" ? <WorkDetail key={opened.id} id={opened.id} name={opened.filename} load={api.workFile} close={closeWork}/>
      : opened.origin === "archived" ? <FileDetail key={`${opened.kind}:${opened.id}`} api={finalApi} work={opened} close={closeWork}/> : null)}
  </section>;
}
