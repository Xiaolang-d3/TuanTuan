import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, GalleryHorizontalEnd, Image as ImageIcon, Pencil, RefreshCw, Settings2 } from "lucide-react";
import type { ChatAttachment } from "../chat/types";
import type { ImagePageActions } from "./ImageWorkspacePage";
import type { StudioModel, StudioTask } from "./imageStudioApi";
import { StudioThumb } from "./StudioMedia";
import { StudioTaskDetail } from "./StudioTaskDetail";
import { failureMessage, sizeText, statusText, useImageWorkspace, useStudioHistory, type StudioApi, type StatusFilter } from "./useImageWorkspace";
import "./ImageWorkspace.css";

const examples=[['活动海报','为夏日音乐节画一张海报，以紫色行星为主视觉，顶部留出标题位置。'],['商品封面','拍一张陶瓷咖啡杯的产品照，木质桌面，窗边柔光。'],['绘本插画','小狐狸在雨后的森林里散步，植物挂着水珠，温暖的绘本风格。']];
function defaultSize(m?:StudioModel){return m?.sizes.includes("auto")?"auto":m?.sizes[0]||"";}
function atTime(raw:string){const d=new Date(raw);return isNaN(d.valueOf())?raw:d.toLocaleString(undefined,{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function storedDraft(key:string){try{return sessionStorage.getItem(key)||"";}catch{return "";}}
export function ImageWorkspace({api,enabled,accountKey,onOpenSettings,onOpenWorks,onOpenConversation,refreshConversations,onLibraryChanged}:ImagePageActions & {api:StudioApi;enabled:boolean}) {
  const storageKey=`tuantuan:image-studio:draft:${accountKey}`;
  const [draft,setDraft]=useState(()=>storedDraft(storageKey));const input=useRef<HTMLTextAreaElement>(null);
  const [canEdit,setCanEdit]=useState(true);
  const [models,setModels]=useState<StudioModel[]>([]),[selection,setSelection]=useState({profile:"",size:""});
  const [optionsBusy,setOptionsBusy]=useState(true),[optionError,setOptionError]=useState("");
  const [refresh,setRefresh]=useState(0),[retryOptions,setRetryOptions]=useState(0),[notice,setNotice]=useState("");
  const [focus,setFocus]=useState<{task:StudioTask;edit:boolean}|null>(null),[detailError,setDetailError]=useState("");
  const [saved,setSaved]=useState<ReadonlySet<string>>(new Set());
  const detailQuery=useRef<AbortController|null>(null);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;detailQuery.current?.abort();};},[]);
  useEffect(()=>{if(!enabled){detailQuery.current?.abort();setFocus(null);}},[enabled]);
  const selected=models.find(m=>m.id===selection.profile);
  const history=useStudioHistory(api,enabled,refresh);
  const refreshHistory=useCallback(()=>setRefresh(r=>r+1),[]);
  const run=useImageWorkspace(api,enabled,accountKey,()=>{refreshHistory();void refreshConversations().catch(()=>{});});
  useEffect(()=>{
    if(!enabled)return;const c=new AbortController();setOptionsBusy(true);setOptionError("");
    api.options(c.signal).then(result=>{
      if(c.signal.aborted)return;
      setModels(result.models);setCanEdit(result.can_edit!==false);setSelection(old=>{
        const preferred=result.models.find(m=>m.id===old.profile)||result.models.find(m=>m.id===result.default_profile_id)||result.models[0];
        if(!preferred)return {profile:"",size:""};return {profile:preferred.id,size:old.profile===preferred.id&&preferred.sizes.includes(old.size)?old.size:defaultSize(preferred)};
      });
    }).catch(e=>{if(!c.signal.aborted)setOptionError(failureMessage(e));}).finally(()=>{if(!c.signal.aborted)setOptionsBusy(false);});
    api.works(c.signal).then(({items})=>{if(!c.signal.aborted)setSaved(new Set(items.map(x=>x.asset.id)));}).catch(()=>{/* Archive remains idempotent if works cannot be preloaded. */});
    return ()=>c.abort();
  },[api,enabled,retryOptions]);
  useEffect(()=>{try{if(draft)sessionStorage.setItem(storageKey,draft);else sessionStorage.removeItem(storageKey);}catch{/* optional local draft */}},[storageKey,draft]);
  function fillDraft(prompt:string,task?:StudioTask){
    if(draft.trim()&&draft!==prompt&&!window.confirm("替换当前草稿？尚未提交的文字将被替换。"))return;
    setDraft(prompt);setFocus(null);setDetailError("");let message="已填入创作栏，尚未生成。";
    if(task){const m=models.find(x=>x.id===task.profile_id);
      if(!m) {setSelection({profile:"",size:""});message="原模型已不可用或未记录。已复用描述，请重新选择模型和画幅。";}
      else if(!m.sizes.includes(task.size)){setSelection({profile:m.id,size:""});message="原画幅不可用或未记录。已复用模型和描述，请重新选择画幅。";}
      else setSelection({profile:m.id,size:task.size});}
    setNotice(message);requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));
  }
  const canGenerate=enabled&&!run.busy&&!optionsBusy&&!optionError&&!!selected?.sizes.includes(selection.size)&&!!draft.trim();
  async function generate(e:FormEvent){e.preventDefault();if(!canGenerate||!selected)return;setNotice("");
    const original=draft, values={prompt:original.trim(),profile_id:selected.id,size:selection.size};
    const ok=await run.submit(values,selected.name,id=>api.generate({...values,request_id:id}));
    if(ok&&mounted.current)setDraft(current=>current===original?"":current);
  }
  async function edit(task:StudioTask,asset:ChatAttachment,prompt:string){
    const ok=await run.submit({prompt,profile_id:null,size:"auto"},"",async id=>{
      await api.edit(asset.id,{operation_id:id,mode:"edit",prompt,strokes:[],comments:[],rotation:0,flip:false,width:asset.width||1024,height:asset.height||1024});
      if(mounted.current)setFocus(old=>old?.task.id===task.id?{task:{...task,id,prompt,source_asset_id:asset.id,assets:[],status:"running",size:"auto",profile_id:null,model_name:""},edit:false}:old);
    },asset.id);
    if(mounted.current){setNotice(ok?"已提交新版本，原图已保留。":"请先核对当前任务状态，不会自动重新提交。");}
    return ok;
  }
  function show(t:StudioTask,edit=false){detailQuery.current?.abort();setDetailError("");setFocus({task:t,edit});}
  async function queryDetail(t:StudioTask){detailQuery.current?.abort();const c=new AbortController();detailQuery.current=c;setDetailError("");
    try{const updated=await api.task(t.id,c.signal);if(!c.signal.aborted){setFocus(old=>old?.task.id===t.id?{...old,task:updated}:old);refreshHistory();}}
    catch(e){if(!c.signal.aborted)setDetailError(`查询未完成：${failureMessage(e)}`);}
  }
  const current=focus?(focus.task.status==="running"&&run.recent?.id===focus.task.id?run.recent:focus.task):null;
  const outstanding=run.recent;
  const matchesRecent=outstanding&&(!history.status||history.status===outstanding.status)&&(!history.query.trim()||outstanding.prompt.toLowerCase().includes(history.query.trim().toLowerCase()));
  const tasks=history.items.map(t=>outstanding?.id===t.id?outstanding:t).filter(t=>!history.status||history.status===t.status);
  if(matchesRecent&&outstanding&&history.offset===0&&!tasks.some(t=>t.id===outstanding.id)&&(run.locked||run.receipt===outstanding.id))tasks.unshift(outstanding);
  return <section className="studio" aria-label="图片创作工作台"><header className="studio-head"><div><p className="studio-kicker">创作空间</p><h1>图片创作</h1></div><button onClick={onOpenWorks}><GalleryHorizontalEnd size={16}/>我的作品</button></header>
    <div className="studio-tools"><input type="search" role="textbox" aria-label="搜索创作记录" placeholder="搜索创作描述…" value={history.query} onChange={e=>history.search(e.target.value)}/><select value={history.status} aria-label="任务状态" onChange={e=>history.filter(e.target.value as StatusFilter)}><option value="">全部状态</option>{Object.entries(statusText).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select><button onClick={()=>{refreshHistory();run.check();}} aria-label="刷新创作记录"><RefreshCw size={16}/></button></div>
    <div className="studio-scroll" aria-label="创作历史" aria-busy={history.loading}>
    {history.error&&<p role="alert" className="studio-error">无法读取历史：{history.error}</p>}
    {!tasks.length&&!history.error&&(history.loading?<p className="studio-muted">正在读取历史…</p>:<div className="studio-empty"><ImageIcon size={28} aria-hidden="true"/><h2>{history.query||history.status?"没有匹配的任务":"还没有创作记录"}</h2><p>{history.query||history.status?"换个关键词，或调整任务状态。":"写下画面描述，或从一个示例开始。"}</p><div className="studio-actions">{history.query||history.status?<button onClick={()=>{history.search("");history.filter("");}}>清除筛选</button>:examples.map(([label,text])=><button key={label} onClick={()=>fillDraft(text)}>{label}</button>)}</div></div>)}
    <div className="studio-grid">{tasks.map(t=><article className="studio-card" key={t.id}><button className="studio-card-cover" aria-label={`查看 ${t.prompt}`} onClick={()=>show(t)}>{t.assets[0]?<StudioThumb id={t.assets[0].id} load={api.thumbnail}/>:<span className="studio-placeholder"><ImageIcon/>{statusText[t.status]}</span>}<span className={`studio-state ${t.status}`}>{statusText[t.status]}</span></button><div className="studio-card-body"><strong title={t.prompt}>{t.prompt}</strong><p>{atTime(t.created_at)}{t.source_asset_id?" · 编辑版本":""}{t.assets.length>1?` · ${t.assets.length} 张`:""}</p>{t.assets[0]&&<button disabled={!canEdit||optionsBusy||!!optionError} title={canEdit?undefined:"请先配置支持编辑的图片模型"} onClick={()=>show(t,true)} aria-label={`编辑图片 ${t.prompt}`}><Pencil size={14}/>编辑图片</button>}</div></article>)}</div>
    {(history.page>1||history.hasMore)&&<nav className="studio-pager" aria-label="创作历史分页"><button disabled={history.loading||history.page===1} onClick={history.prev}>上一页</button><span>第 {history.page} 页</span><button disabled={history.loading||!history.hasMore} onClick={history.next}>下一页</button></nav>}</div>
    <footer className="studio-bottom"><div className="studio-feedback" aria-live="polite">{outstanding&&<><span>最近任务 · {statusText[outstanding.status]}</span><button onClick={()=>show(outstanding)}>查看任务</button></>}{notice&&<span>{notice}</span>}{run.issue&&<span className="studio-error">{run.issue} <button onClick={run.check}>查询结果</button>{run.notFound&&<button onClick={()=>{if(window.confirm("已在服务记录中核对结果？再次创建任务可能重新计费。"))run.acknowledgeMissing();}}>已核对，解除限制</button>}</span>}</div>
    <form className="studio-composer" onSubmit={generate}><label htmlFor="studio-prompt">想生成什么图片？</label><textarea id="studio-prompt" ref={input} aria-label="画面描述" value={draft} maxLength={4000} rows={2} onChange={e=>setDraft(e.target.value)} placeholder="例如：紫色音乐节海报，顶部留出标题位置。" onKeyDown={e=>{if(!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
    <div className="studio-controls"><div className="studio-parameters">{models.length===1&&selected?<span aria-label="当前图片模型">{selected.name}</span>:models.length>0?<label>模型 <select aria-label="图片模型" value={selection.profile} onChange={e=>{const m=models.find(x=>x.id===e.target.value);setSelection({profile:m?.id||"",size:defaultSize(m)});}}>{!selected&&<option value="">请选择模型</option>}{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>:<span>{optionsBusy?"正在读取模型…":"未配置图片模型"}</span>}
    {selected&&<label>画幅 {selected.sizes.length===1&&selection.size?<span>{sizeText(selection.size)}</span>:<select aria-label="生成画幅" value={selection.size} onChange={e=>setSelection(old=>({...old,size:e.target.value}))}>{!selection.size&&<option value="">请选择画幅</option>}{selected.sizes.map(s=><option key={s} value={s}>{sizeText(s)}</option>)}</select>}</label>}<button type="button" aria-label="设置图片模型" onClick={onOpenSettings}><Settings2 size={16}/></button></div>
    <button className="studio-primary" disabled={!canGenerate} type="submit"><ArrowUp size={16}/>{run.receipt||run.locked?"任务处理中":"生成图片"}</button></div>{optionError&&<p role="alert">模型配置读取失败：{optionError} <button type="button" onClick={()=>setRetryOptions(n=>n+1)}>重新读取</button></p>}</form></footer>
    {current&&focus&&enabled&&<StudioTaskDetail key={`${current.id}:${focus.edit}`} api={api} task={current} editInitially={focus.edit} canEdit={canEdit&&!optionsBusy&&!optionError} busy={run.busy} archived={saved} onEdit={edit} onClose={()=>setFocus(null)} onArchive={async id=>{await api.archive(id);if(mounted.current){setSaved(prev=>new Set([...prev,id]));void onLibraryChanged().catch(()=>{});}}} onReuse={t=>fillDraft(t.prompt,t)} onWorks={onOpenWorks} onConversation={onOpenConversation} onQuery={()=>{run.check();void queryDetail(current);}} issue={detailError||run.issue}/>}
    </section>;
}
