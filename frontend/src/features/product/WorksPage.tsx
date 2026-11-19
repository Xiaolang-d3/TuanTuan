import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowRight, Download } from "lucide-react";
import { createImageStudioApi, type StudioWork } from "./imageStudioApi";
import { downloadBlob } from "../chat/result-files";
import { StudioDialog, StudioOriginal, StudioThumb, useStudioBlob } from "./StudioMedia";
import { failureMessage, type StudioApi } from "./useImageWorkspace";
import type { StudioConnection } from "./ImageWorkspacePage";
import "./ImageWorkspace.css";

function WorkDetail({work,api,close}:{work:StudioWork;api:StudioApi;close:()=>void}) {
  const image=useStudioBlob(work.id,api.workFile);
  return <StudioDialog title="作品详情" onClose={close}><div className="studio-work-preview"><StudioOriginal image={image} name={work.asset.original_filename}/><h3>{work.asset.original_filename}</h3><button className="studio-primary" disabled={!image.file} onClick={()=>{if(image.file)downloadBlob(image.file.blob,work.asset.original_filename);}}><Download size={15}/>下载原图</button></div></StudioDialog>;
}
export function WorksPage({apiBase,accessToken,fetchJson,ready,active=true,onOpenImages}:StudioConnection & {onOpenImages:()=>void}) {
  const api=useMemo(()=>createImageStudioApi(apiBase,accessToken,fetchJson),[apiBase,accessToken,fetchJson]);
  const [items,setItems]=useState<StudioWork[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [selected,setSelected]=useState<StudioWork|null>(null),[retry,setRetry]=useState(0);
  const [count,setCount]=useState(24);
  useEffect(()=>{if(!active||!ready)return;const c=new AbortController();setLoading(true);setError("");api.works(c.signal).then(r=>{if(!c.signal.aborted)setItems(r.items);}).catch(e=>{if(!c.signal.aborted)setError(failureMessage(e));}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[active,ready,api,retry]);
  return <section className="studio" aria-label="我的作品"><header className="studio-head"><div><p className="studio-kicker">创作空间</p><h1>我的作品</h1><p>你主动归档的定稿，独立于来源对话保存。</p></div><button onClick={onOpenImages}>去图片创作<ArrowRight size={15}/></button></header><div className="studio-scroll" aria-busy={loading}>
    {error&&<p role="alert" className="studio-error">{error} <button onClick={()=>setRetry(v=>v+1)}>重新加载</button></p>}
    {loading&&!items.length?<p>正在读取作品…</p>:!error&&!items.length?<div className="studio-empty"><Archive/><h2>还没有已归档的图片</h2><p>在图片详情中选择「归档到我的作品」，定稿就会出现在这里。</p></div>:null}
    <div className="studio-grid">{items.slice(0,count).map(w=><article className="studio-card" key={w.id}><button className="studio-card-cover" onClick={()=>setSelected(w)} aria-label={`打开 ${w.asset.original_filename}`}><StudioThumb id={w.id} load={api.workThumbnail}/></button><div className="studio-card-body"><strong>{w.asset.original_filename}</strong><p>{w.asset.width&&w.asset.height?`${w.asset.width} × ${w.asset.height} · `:""}{w.created_at.slice(0,10)}</p><button onClick={()=>setSelected(w)}>查看作品</button></div></article>)}</div>{items.length>count&&<button onClick={()=>setCount(n=>n+24)}>加载更多作品</button>}</div>
    {active&&selected&&<WorkDetail key={selected.id} api={api} work={selected} close={()=>setSelected(null)}/>}</section>;
}
