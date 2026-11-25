import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, Download, FileText, Presentation } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { createImageStudioApi, type StudioWork } from "./imageStudioApi";
import { createFinalWorksApi, type FinalWork } from "./finalWorksApi";
import { downloadBlob } from "../chat/result-files";
import { StudioDialog, StudioOriginal, StudioThumb, useStudioBlob } from "./StudioMedia";
import { failureMessage, type StudioApi } from "./useImageWorkspace";
import type { StudioConnection } from "./ImageWorkspacePage";
import "./ImageWorkspace.css";
import "./WorksPage.css";

const filters = { all: "全部", image: "图片", document: "文档", presentation: "演示文稿" } as const;
type WorkFilter = keyof typeof filters;
type GalleryWork = FinalWork | { id: string; kind: "image"; filename: string; created_at: string; image: StudioWork };

function WorkDetail({ work, api, close }: { work: StudioWork; api: StudioApi; close: () => void }) {
  const image = useStudioBlob(work.id, api.workFile);
  return <StudioDialog title="作品详情" onClose={close}><div className="studio-work-preview"><StudioOriginal image={image} name={work.asset.original_filename}/><h3>{work.asset.original_filename}</h3><button className="studio-primary" disabled={!image.file} onClick={() => { if (image.file) downloadBlob(image.file.blob, work.asset.original_filename); }}><Download size={15}/>下载原图</button></div></StudioDialog>;
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

export function WorksPage({ apiBase, accessToken, fetchJson, ready, active = true, onOpenImages, linkedWork, onCloseLinkedWork }: StudioConnection & {
  onOpenImages: () => void; linkedWork?: string; onCloseLinkedWork?: () => void;
}) {
  const api = useMemo(() => createImageStudioApi(apiBase, accessToken, fetchJson), [apiBase, accessToken, fetchJson]);
  const finalApi = useMemo(() => createFinalWorksApi(apiBase, accessToken, fetchJson), [apiBase, accessToken, fetchJson]);
  const [images, setImages] = useState<StudioWork[]>([]);
  const [files, setFiles] = useState<FinalWork[]>([]);
  const [loading, setLoading] = useState({ images: true, files: true });
  const [errors, setErrors] = useState({ images: "", files: "" });
  const [selected, setSelected] = useState<GalleryWork | null>(null);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [count, setCount] = useState(24);

  useEffect(() => {
    if (!active || !ready) return;
    const controller = new AbortController();
    setLoading({ images: true, files: true });
    setErrors({ images: "", files: "" });
    function load<T>(key: "images" | "files", promise: Promise<{ items: T[] }>, apply: (items: T[]) => void) {
      void promise.then(result => { if (!controller.signal.aborted) apply(result.items); })
        .catch(caught => { if (!controller.signal.aborted) setErrors(current => ({ ...current, [key]: failureMessage(caught) })); })
        .finally(() => { if (!controller.signal.aborted) setLoading(current => ({ ...current, [key]: false })); });
    }
    load("images", api.works(controller.signal), setImages);
    load("files", finalApi.list(controller.signal), setFiles);
    return () => controller.abort();
  }, [active, ready, api, finalApi, retry]);

  const items: GalleryWork[] = [
    ...images.map(image => ({ id: image.id, kind: "image" as const, filename: image.asset.original_filename, created_at: image.created_at, image })),
    ...files,
  ];
  const linked = linkedWork && items.find(work => `${work.kind === "image" ? "image_work" : "final_work"}:${work.id}` === linkedWork);
  const opened = selected ?? (linked || null);
  function closeWork() {
    setSelected(null);
    if (linkedWork) onCloseLinkedWork?.();
  }
  const visible = items.filter(item => filter === "all" || item.kind === filter).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const pending = (filter !== "image" && loading.files) || ((filter === "all" || filter === "image") && loading.images);
  const failed = (filter !== "image" && errors.files) || ((filter === "all" || filter === "image") && errors.images);

  return <section className="studio" aria-label="我的作品">
    <header className="studio-head"><div><p className="studio-kicker">创作空间</p><h1>我的作品</h1><p>你主动保存的定稿，独立于来源保存。</p></div><button onClick={onOpenImages}>去图片创作<ArrowRight size={15}/></button></header>
    <div className="studio-scroll" aria-busy={pending}>
      <div className="final-work-filters" role="group" aria-label="作品类型">
        {(Object.keys(filters) as WorkFilter[]).map(value => <ActionButton key={value} variant="secondary" aria-pressed={filter === value} onClick={() => { setFilter(value); setCount(24); }}>{filters[value]}</ActionButton>)}
      </div>
      {linkedWork && !linked && !loading.images && !loading.files && !errors.images && !errors.files && <p role="status">关联的作品已不存在。</p>}
      {failed && <p role="alert" className="studio-error">部分作品未能读取。 <button onClick={() => setRetry(value => value + 1)}>重新加载</button></p>}
      {pending && !visible.length ? <p role="status">正在读取作品…</p> : !failed && !visible.length ? <div className="studio-empty"><Archive/><h2>还没有{filter === "all" ? "已保存的作品" : `已保存的${filters[filter]}`}</h2><p>在图片详情、保存后的文档或已完成的 PPT 中，将定稿保存到我的作品。</p></div> : null}
      <div className="studio-grid">{visible.slice(0, count).map(work => <article className="studio-card" key={`${work.kind}:${work.id}`}>
        <button className={`studio-card-cover${work.kind === "image" ? "" : " final-work-cover"}`} onClick={() => setSelected(work)} aria-label={`打开 ${work.filename}`}>
          {work.kind === "image" ? <StudioThumb id={work.id} load={api.workThumbnail}/> : <>{work.kind === "document" ? <FileText size={34} aria-hidden="true"/> : <Presentation size={34} aria-hidden="true"/>}<span>{work.kind === "document" ? "Markdown" : "PPTX"}</span></>}
        </button>
        <div className="studio-card-body"><strong>{work.filename}</strong><p>{work.kind === "image" && work.image.asset.width && work.image.asset.height ? `${work.image.asset.width} × ${work.image.asset.height} · ` : `${filters[work.kind]} · `}{work.created_at.slice(0, 10)}</p><button onClick={() => setSelected(work)}>查看作品</button></div>
      </article>)}</div>
      {visible.length > count && <button onClick={() => setCount(value => value + 24)}>加载更多作品</button>}
    </div>
    {active && opened && (opened.kind === "image" ? <WorkDetail key={opened.id} api={api} work={opened.image} close={closeWork}/> : <FileDetail key={`${opened.kind}:${opened.id}`} api={finalApi} work={opened} close={closeWork}/>)}
  </section>;
}
