import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, GalleryHorizontalEnd, Image as ImageIcon, RefreshCw, Settings2 } from "lucide-react";
import type { ChatAttachment } from "../chat/types";
import type { ImagePageActions } from "./ImageWorkspacePage";
import type { StudioTask } from "./imageStudioApi";
import { StudioModelPicker, studioPreviewReason, useStudioModelPreview } from "./StudioModelPicker";
import { StudioThumb } from "./StudioMedia";
import { StudioTaskDetail, type StudioEditBinding } from "./StudioTaskDetail";
import { failureMessage, sizeText, statusText, useImageWorkspace, useStudioHistory, type StudioApi, type StatusFilter } from "./useImageWorkspace";
import { layoutImageHistory } from "./imageHistoryLayout";
import "./ImageWorkspace.css";

const examples=[['活动海报','为夏日音乐节画一张海报，以紫色行星为主视觉，顶部留出标题位置。'],['商品封面','拍一张陶瓷咖啡杯的产品照，木质桌面，窗边柔光。'],['绘本插画','小狐狸在雨后的森林里散步，植物挂着水珠，温暖的绘本风格。']];
function defaultSize(sizes: string[]) { return sizes.includes("auto") ? "auto" : sizes[0] || ""; }
function storedDraft(key:string){try{return sessionStorage.getItem(key)||"";}catch{return "";}}
export function ImageWorkspace({api,enabled,accountKey,onOpenSettings,onOpenWorks,onOpenConversation,refreshConversations,onLibraryChanged}:ImagePageActions & {api:StudioApi;enabled:boolean}) {
  const storageKey=`tuantuan:image-studio:draft:${accountKey}`;
  const [draft,setDraft]=useState(()=>storedDraft(storageKey));const input=useRef<HTMLTextAreaElement>(null);
  const [canEdit,setCanEdit]=useState(true);
  const [selection, setSelection] = useState<{ profile: string | null | undefined; size: string | null }>({ profile: null, size: null });
  const preview = useStudioModelPreview(api, enabled, { operation: "image.generate", profile_id: selection.profile });
  const [optionsBusy,setOptionsBusy]=useState(true),[optionError,setOptionError]=useState("");
  const [refresh,setRefresh]=useState(0),[retryOptions,setRetryOptions]=useState(0),[notice,setNotice]=useState("");
  const [focusedTask,setFocusedTask]=useState<StudioTask|null>(null),[detailError,setDetailError]=useState("");
  const [generationId,setGenerationId]=useState<string|null>(null);
  const [editId,setEditId]=useState<string|null>(null);
  const [saved,setSaved]=useState<ReadonlySet<string>>(new Set());
  const detailQuery=useRef<AbortController|null>(null);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;detailQuery.current?.abort();};},[]);
  useEffect(()=>{if(!enabled){detailQuery.current?.abort();setFocusedTask(null);setGenerationId(null);}},[enabled]);
  const selected = preview.data?.selection;
  const sizes = selected?.sizes ?? [];
  const size = selection.size ?? defaultSize(sizes);
  const history=useStudioHistory(api,enabled,refresh);
  const refreshHistory=useCallback(()=>setRefresh(r=>r+1),[]);
  const run=useImageWorkspace(api,enabled,accountKey,()=>{refreshHistory();void refreshConversations().catch(()=>{});});
  useEffect(()=>{
    if(!enabled)return;const c=new AbortController();setOptionsBusy(true);setOptionError("");
    api.options(c.signal).then(result=>{
      if(c.signal.aborted)return;
      setCanEdit(result.can_edit !== false);
    }).catch(e=>{if(!c.signal.aborted)setOptionError(failureMessage(e));}).finally(()=>{if(!c.signal.aborted)setOptionsBusy(false);});
    api.works(c.signal).then(({items})=>{if(!c.signal.aborted)setSaved(new Set(items.map(x=>x.asset.id)));}).catch(()=>{/* Archive remains idempotent if works cannot be preloaded. */});
    return ()=>c.abort();
  },[api,enabled,retryOptions]);
  useEffect(()=>{try{if(draft)sessionStorage.setItem(storageKey,draft);else sessionStorage.removeItem(storageKey);}catch{/* optional local draft */}},[storageKey,draft]);
  function fillDraft(prompt:string,task?:StudioTask){
    if(draft.trim()&&draft!==prompt&&!window.confirm("替换当前草稿？尚未提交的文字将被替换。"))return;
    setDraft(prompt);setFocusedTask(null);setGenerationId(null);setDetailError("");let message="已填入创作栏，尚未生成。";
    if (task) {
      setSelection({ profile: task.profile_id ?? undefined, size: task.size });
      if (!task.profile_id) message = "未记录原模型。已复用描述，请重新选择模型和画幅。";
    }
    setNotice(message);requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));
  }
  const comparisonKey = preview.data?.comparison_key;
  const canGenerate = enabled && !run.busy && selection.profile !== undefined &&
    !!preview.data?.eligible && !!comparisonKey && !!selected?.service_name && sizes.includes(size) && !!draft.trim();
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!canGenerate || !selected || !comparisonKey) return;
    setNotice("");
    const original = draft;
    const values = { prompt: original.trim(), profile_id: selection.profile ?? null, size };
    const ok = await run.submit({ ...values, profile_id: selected.profile_id }, selected.model_name,
      id => {
        setGenerationId(id);
        return api.generate({ ...values, request_id: id, comparison_key: comparisonKey });
      }, undefined, preview.refresh);
    if (ok && mounted.current) setDraft(current => current === original ? "" : current);
  }
  async function edit(task: StudioTask, asset: ChatAttachment, prompt: string, binding: StudioEditBinding, onConflict: (message: string) => void) {
    const values = { prompt, profile_id: binding.selection.profile_id, size: "auto" };
    const ok = await run.submit(values, binding.selection.model_name, async id => {
      await api.edit(asset.id, {
        operation_id: id, mode: "edit", prompt, strokes: [], comments: [], rotation: 0, flip: false,
        width: asset.width || 1024, height: asset.height || 1024, profile_id: binding.profileId,
        comparison_key: binding.comparisonKey, confirm_data_boundary: binding.confirmed,
      });
      if (mounted.current) setFocusedTask(old => old?.id === task.id ? {
        ...task, ...values, id, source_asset_id: asset.id, assets: [], status: "running", model_name: binding.selection.model_name,
      } : old);
    }, asset.id, onConflict);
    if (ok && mounted.current) setNotice("已提交新版本，原图已保留。");
    return ok;
  }
  function show(task:StudioTask,edit=false){setEditId(edit ? task.id : null);detailQuery.current?.abort();setDetailError("");setFocusedTask(task);}
  async function queryDetail(t:StudioTask){detailQuery.current?.abort();const c=new AbortController();detailQuery.current=c;setDetailError("");
    try{const updated=await api.task(t.id,c.signal);if(!c.signal.aborted){setFocusedTask(old=>old?.id===t.id?updated:old);refreshHistory();}}
    catch(e){if(!c.signal.aborted)setDetailError(`查询未完成：${failureMessage(e)}`);}
  }
  const current=focusedTask?.status==="running"&&run.recent?.id===focusedTask.id?run.recent:focusedTask;
  const outstanding=run.recent;
  const matchesRecent=outstanding&&(!history.status||history.status===outstanding.status)&&(!history.query.trim()||outstanding.prompt.toLowerCase().includes(history.query.trim().toLowerCase()));
  const tasks=history.items.map(t=>outstanding?.id===t.id?outstanding:t).filter(t=>!history.status||history.status===t.status);
  const modelSetupNeeded = preview.data && !preview.data.eligible && !preview.data.candidates.some(model => model.eligible);
  const modelNotConfigured = modelSetupNeeded && (preview.data?.reason_code === "not_configured" ||
    (!preview.data?.reason_code && preview.data?.candidates.length === 0));
  const hasHistoryFilter = Boolean(history.query || history.status);
  if(matchesRecent&&outstanding&&history.offset===0&&!tasks.some(t=>t.id===outstanding.id)&&(run.locked||run.receipt===outstanding.id))tasks.unshift(outstanding);
  const generation = enabled && outstanding?.id === generationId ? outstanding : null;
  const historyGrid = useRef<HTMLDivElement>(null);
  const [historyWidth, setHistoryWidth] = useState(0);
  useEffect(() => {
    const grid = historyGrid.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHistoryWidth(Math.floor(entry.contentRect.width)));
    observer.observe(grid);
    return () => observer.disconnect();
  }, [!!generation]);
  const layout = historyWidth >= 100 ? layoutImageHistory(tasks.map(task => {
    const asset = task.assets[0];
    return asset?.width && asset.height ? asset.width / asset.height : 0;
  }), historyWidth) : null;
  const cards = layout ? layout.tiles.map(tile => ({ task: tasks[tile.index], tile }))
    : tasks.map(task => ({ task, tile: null }));
  const detailProps = {
    api, canEdit: canEdit && !optionsBusy && !optionError, busy: run.busy, archived: saved, onEdit: edit,
    onArchive: async (id: string) => {
      await api.archive(id);
      if (mounted.current) { setSaved(prev => new Set([...prev, id])); void onLibraryChanged().catch(() => {}); }
    },
    onReuse: (task: StudioTask) => fillDraft(task.prompt, task), onWorks: onOpenWorks, onConversation: onOpenConversation,
  };
  function leaveGeneration() {
    setGenerationId(null);
    requestAnimationFrame(() => input.current?.focus({preventScroll:true}));
  }
  return <section className="studio" aria-label="图片创作工作台">
    {generation ? <StudioTaskDetail key={generation.id} {...detailProps} task={generation} editInitially={false}
      onStartEdit={task => { setGenerationId(null); show(task, true); }} onClose={leaveGeneration}
      onQuery={run.receipt === generation.id && !run.locked ? run.check : undefined} issue={run.issue}/>
    : <><header className="studio-head"><div><p className="studio-kicker">创作空间</p><h1>图片创作</h1></div><button onClick={onOpenWorks}><GalleryHorizontalEnd size={16}/>我的作品</button></header>
    <div className="studio-tools"><input type="search" role="textbox" aria-label="搜索创作记录" placeholder="搜索创作描述…" value={history.query} onChange={e=>history.search(e.target.value)}/><select value={history.status} aria-label="任务状态" onChange={e=>history.filter(e.target.value as StatusFilter)}><option value="">全部状态</option>{Object.entries(statusText).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select><button onClick={()=>{refreshHistory();run.check();}} aria-label="刷新创作记录"><RefreshCw size={16}/></button></div>
    <div className="studio-scroll" aria-label="创作历史" aria-busy={history.loading}>
    {modelSetupNeeded && <section className="studio-model-onboarding" aria-labelledby="studio-model-onboarding-title">
      <div className="studio-model-onboarding-copy">
        <h2 id="studio-model-onboarding-title">{modelNotConfigured ? "尚未配置模型" : "请检查图片模型配置"}</h2>
        {modelNotConfigured ? <>
          <p>还没有可用的图片模型</p>
          <p>团团暂不提供免费图片模型，请配置自己的模型服务后开始创作。</p>
        </> : <p>{studioPreviewReason(preview.data)}</p>}
      </div>
      <div className="studio-model-onboarding-actions">
        <button type="button" className="studio-primary" onClick={onOpenSettings}><Settings2 size={16} aria-hidden="true"/>{modelNotConfigured ? "配置图片模型" : "管理图片模型"}</button>
        <details>
          <summary>模型接入说明和配置教程</summary>
          <ol>
            <li>进入模型管理，选择服务商或兼容 API，并填写服务地址与 API Key。</li>
            <li>测试连接，然后添加支持图片生成的模型，可从服务商发现或手动填写模型名称。</li>
            <li>保存模型并确认图片生成能力，返回图片创作选择模型。</li>
          </ol>
        </details>
      </div>
    </section>}
    {history.error&&<p role="alert" className="studio-error">无法读取历史：{history.error}</p>}
    {!tasks.length && !history.error && (history.loading ? <p className="studio-muted">正在读取历史…</p> :
      (!modelSetupNeeded || hasHistoryFilter) && <div className="studio-empty">
        <ImageIcon size={28} aria-hidden="true" />
        <h2>{hasHistoryFilter ? "没有匹配的任务" : "还没有创作记录"}</h2>
        <p>{hasHistoryFilter ? "换个关键词，或调整任务状态。" : "写下画面描述，或从一个示例开始。"}</p>
        <div className="studio-actions">
          {hasHistoryFilter ? <button onClick={() => { history.search(""); history.filter(""); }}>清除筛选</button> :
            examples.map(([label, text]) => <button key={label} onClick={() => fillDraft(text)}>{label}</button>)}
        </div>
      </div>)}
    <div ref={historyGrid} className={`studio-grid studio-history-grid${layout ? " studio-history-packed" : ""}`}
      style={layout ? { height: layout.height } : undefined}>{cards.map(({ task, tile }) => {
      const asset = task.assets[0];
      const status = statusText[task.status];
      return <article className="studio-card" key={task.id} style={tile ? {
        insetInlineStart: tile.x, top: tile.y, width: tile.width, height: tile.height,
      } : undefined}>
        <button className="studio-card-cover" aria-label={`查看 ${task.prompt}`} onClick={() => show(task)}>
          {asset ? <StudioThumb id={asset.id} load={api.thumbnail} width={asset.width} height={asset.height} /> : <span className="studio-placeholder"><ImageIcon aria-hidden="true" />{task.status === "done" ? "预览不可用" : status}</span>}
          {asset && task.status !== "done" && <span className={`studio-state ${task.status}`}>{status}</span>}
        </button>
        <div className="studio-card-body">
          <strong title={task.prompt}>{task.prompt}</strong>
          {task.assets.length > 1 && <p>{task.assets.length} 张</p>}
        </div>
      </article>;
    })}</div>
    {(history.page>1||history.hasMore)&&<nav className="studio-pager" aria-label="创作历史分页"><button disabled={history.loading||history.page===1} onClick={history.prev}>上一页</button><span>第 {history.page} 页</span><button disabled={history.loading||!history.hasMore} onClick={history.next}>下一页</button></nav>}</div>
    <footer className="studio-bottom"><div className="studio-feedback" aria-live="polite">{outstanding&&<><span>最近任务 · {statusText[outstanding.status]}</span><button onClick={()=>outstanding.source_asset_id ? show(outstanding) : setGenerationId(outstanding.id)}>查看任务</button></>}{notice&&<span>{notice}</span>}{run.issue&&<span className="studio-error">{run.issue} <button onClick={run.check}>查询结果</button>{run.notFound&&<button onClick={()=>{if(window.confirm("已在服务记录中核对结果？再次创建任务可能重新计费。"))run.acknowledgeMissing();}}>已核对，解除限制</button>}</span>}</div>
    <form className="studio-composer" onSubmit={generate}><label htmlFor="studio-prompt">想生成什么图片？</label><textarea id="studio-prompt" ref={input} aria-label="画面描述" value={draft} maxLength={4000} rows={2} onChange={e=>setDraft(e.target.value)} placeholder="例如：紫色音乐节海报，顶部留出标题位置。" onKeyDown={e=>{if(!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
    <StudioModelPicker label="图片模型" profileId={selection.profile} preview={preview} busy={run.locked}
      onChange={profile => { preview.refresh(); setSelection({ profile, size: null }); }} />
    <div className="studio-controls"><div className="studio-parameters">
    {selected && selection.profile !== undefined && <label>画幅 {sizes.length === 1 && sizes.includes(size) ? <span>{sizeText(size)}</span> : <select aria-label="生成画幅" value={sizes.includes(size) ? size : ""} onChange={event => setSelection(old => ({ ...old, size: event.target.value }))}><option value="" disabled>请选择画幅</option>{sizes.map(option => <option key={option} value={option}>{sizeText(option)}</option>)}</select>}</label>}
    <button type="button" aria-label="设置图片模型" onClick={onOpenSettings}><Settings2 size={16}/></button></div>
    <button className="studio-primary" disabled={!canGenerate} type="submit"><ArrowUp size={16}/>{run.receipt||run.locked?"任务处理中":"生成图片"}</button></div>{optionError&&<p role="alert">模型配置读取失败：{optionError} <button type="button" onClick={()=>setRetryOptions(n=>n+1)}>重新读取</button></p>}</form></footer></>}
    {current&&enabled&&<StudioTaskDetail key={current.id} {...detailProps} task={current} editInitially={editId===current.id} onClose={()=>setFocusedTask(null)} onQuery={()=>{run.check();void queryDetail(current);}} issue={detailError||run.issue}/>}
    </section>;
}
