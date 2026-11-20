import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image as ImageIcon, X } from "lucide-react";
import { failureMessage } from "./useImageWorkspace";

type BlobLoader = (id: string, signal?: AbortSignal) => Promise<Blob>;
export function useStudioBlob(id: string | undefined, load: BlobLoader) {
  const [file,setFile] = useState<{ id:string; blob:Blob; url:string } | null>(null);
  const [error,setError] = useState("");
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController(); let url = "";
    setFile(null);setError("");
    if(id) load(id,c.signal).then(blob => {
      if(c.signal.aborted)return;
      url=URL.createObjectURL(blob);setFile({id,blob,url});
    }).catch(e => {if(!c.signal.aborted)setError(failureMessage(e));});
    return () => {c.abort();if(url)URL.revokeObjectURL(url);};
  },[id,load,attempt]);
  return { file:file?.id===id?file:null, error, retry:()=>setAttempt(v=>v+1), invalid:()=>setError("图片无法显示") };
}
export function StudioThumb({ id, load }: {id:string; load:BlobLoader}) {
  const ref=useRef<HTMLSpanElement>(null);
  const [visible,setVisible]=useState(()=>typeof IntersectionObserver==="undefined");
  useEffect(()=>{if(visible||!ref.current)return;const io=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);io.disconnect();}},{rootMargin:"160px"});io.observe(ref.current);return()=>io.disconnect();},[visible]);
  const image=useStudioBlob(visible?id:undefined,load);
  return <span className="studio-thumb" ref={ref}>{image.file && !image.error ? <img src={image.file.url} alt="" onError={image.invalid}/> : <span className="studio-placeholder"><ImageIcon aria-hidden="true"/>{image.error?"预览不可用":"加载预览…"}</span>}</span>;
}
export function StudioOriginal({image,name}:{image:ReturnType<typeof useStudioBlob>;name:string}) {
  return <div className="studio-original">{image.error?<div><p role="alert">{image.error}</p><button onClick={image.retry}>重新加载图片</button></div>:image.file?<img src={image.file.url} alt={name} onError={image.invalid}/>:<p role="status">正在读取原图…</p>}</div>;
}
export function StudioDialog({title,children,onClose,editing=false}:{title:string;children:ReactNode;onClose:()=>void;editing?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{
    const d=ref.current!;const opener=document.activeElement as HTMLElement|null;
    if(typeof d.showModal==="function")d.showModal();else d.setAttribute("open","");
    d.querySelector<HTMLButtonElement>("button")?.focus();
    return ()=>{if(d.open&&typeof d.close==="function")d.close();if(opener?.isConnected)opener.focus({preventScroll:true});};
  },[]);
  return <dialog ref={ref} className={`studio-dialog${editing ? " studio-dialog-editing" : ""}`} aria-label={title} onCancel={e=>{e.preventDefault();closeRef.current();}}><div className="studio-dialog-inner"><header className="studio-dialog-head"><h2>{title}</h2><button aria-label="关闭详情" onClick={onClose}><X size={16}/></button></header>{children}</div></dialog>;
}
