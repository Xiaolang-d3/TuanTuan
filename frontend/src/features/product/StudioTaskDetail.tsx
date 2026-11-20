import { useState } from "react";
import { Archive, Download, Pencil, RotateCcw } from "lucide-react";
import type { StudioPreview, StudioTask } from "./imageStudioApi";
import { StudioDialog, StudioOriginal, useStudioBlob } from "./StudioMedia";
import { StudioModelPicker, useStudioModelPreview } from "./StudioModelPicker";
import { downloadBlob } from "../chat/result-files";
import type { ChatAttachment } from "../chat/types";
import { statusText,sizeText,failureMessage,type StudioApi } from "./useImageWorkspace";

export type StudioEditBinding = {
  selection: NonNullable<StudioPreview["selection"]>;
  profileId: string | null;
  comparisonKey: string;
  confirmed: boolean;
};

type Props={api:StudioApi;task:StudioTask;editInitially:boolean;canEdit:boolean;busy:boolean;archived:ReadonlySet<string>;
  issue:string;onEdit:(task:StudioTask,asset:ChatAttachment,prompt:string,binding:StudioEditBinding,onConflict:(message:string)=>void)=>Promise<boolean>;onClose:()=>void;
  onArchive:(id:string)=>Promise<void>;onReuse:(t:StudioTask)=>void;onWorks:()=>void;onConversation:(id:number)=>void;onQuery:()=>void};
export function StudioTaskDetail({api,task,issue,editInitially,canEdit,busy,archived,onEdit,onArchive,onReuse,onWorks,onConversation,onQuery,onClose}:Props){
  const [index,setIndex]=useState(0),[editing,setEditing]=useState(editInitially),[instruction,setInstruction]=useState("");
  const [saving,setSaving]=useState(false),[error,setError]=useState(""),[compare,setCompare]=useState(false);
  const asset=task.assets[index]||task.assets[0];const image=useStudioBlob(asset?.id,api.assetFile);
  const source=useStudioBlob(compare?task.source_asset_id||undefined:undefined,api.assetFile);
  const [editProfile, setEditProfile] = useState<string | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const preview = useStudioModelPreview(api, editing && !!asset, {
    operation: "image.edit", profile_id: editProfile, asset_id: asset?.id,
  });
  const resolved = preview.data?.selection;
  const comparisonKey = preview.data?.comparison_key;
  const needsConfirmation = !!preview.data?.requires_confirmation;
  const confirmed = needsConfirmation && !!comparisonKey && confirmedKey === comparisonKey;
  const canSubmit = !busy && canEdit && !!instruction.trim() && !!image.file &&
    !!preview.data?.eligible && !!resolved?.service_name && !!comparisonKey && (!needsConfirmation || confirmed);
  function close(){if(editing&&instruction.trim()&&!window.confirm("放弃尚未提交的修改要求？"))return;onClose();}
  async function save(){if(!asset||saving||archived.has(asset.id))return;setSaving(true);setError("");try{await onArchive(asset.id);}catch(e){setError(failureMessage(e));}finally{setSaving(false);}}
  return <StudioDialog title={editing ? "编辑图片" : "图片详情"} onClose={close} editing={editing}>
    {editing&&asset?<div className="studio-edit"><figure><StudioOriginal name={`原图：${asset.original_filename}`} image={image}/><figcaption>原图 · {asset.original_filename}</figcaption></figure>
      <form onSubmit={async event => {
        event.preventDefault();
        if (!canSubmit || !resolved || !comparisonKey) return;
        await onEdit(task, asset, instruction.trim(), { selection: resolved, profileId: editProfile, comparisonKey, confirmed }, message => {
          setConfirmedKey(null);
          preview.refresh(message);
        });
      }}>
        <label>你想改哪里？<textarea aria-label="修改要求" maxLength={4000} value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="例如：主色换成暖橙色，保留标题和构图。" rows={4}/></label><p className="studio-muted">修改会生成新版本，原图不变。</p>
        <StudioModelPicker label="编辑模型" profileId={editProfile} preview={preview} busy={busy}
          onChange={profile => { setConfirmedKey(null); preview.refresh(); setEditProfile(profile); }} />
        {needsConfirmation && comparisonKey && resolved && <label className="studio-boundary-confirmation">
          <input type="checkbox" checked={confirmed} disabled={busy}
            onChange={event => setConfirmedKey(event.target.checked ? comparisonKey : null)} />
          我同意将原图发送到「{resolved.service_name}」用于此次编辑。
        </label>}
        <div className="studio-actions"><button type="button" onClick={()=>{if(instruction.trim()&&!window.confirm("放弃尚未提交的修改要求？"))return;setEditing(false);setInstruction("");setEditProfile(null);setConfirmedKey(null);preview.refresh();}}>取消</button><button type="submit" className="studio-primary" disabled={!canSubmit}>{busy?"有任务进行中":"生成新版本"}</button></div></form>
      </div>:<div className="studio-detail-content">
      {asset&&<div><StudioOriginal image={compare?source:image} name={compare?"来源原图":asset.original_filename}/>
        {task.assets.length>1&&<div className="studio-actions" aria-label="选择本轮图片">{task.assets.map((a,i)=><button key={a.id} aria-pressed={i===index} onClick={()=>{setIndex(i);setCompare(false);}}>第 {i+1} 张</button>)}</div>}
        {task.source_asset_id&&<button onClick={()=>setCompare(v=>!v)}>{compare?"返回当前版本":"与原图对比"}</button>}</div>}
      <div className="studio-detail-info"><span className={`studio-state ${task.status}`}>{statusText[task.status]}</span>
      <h3>{task.source_asset_id?"修改要求":"画面描述"}</h3><p className="studio-prompt-text">{task.prompt}</p>
      <dl><dt>图片模型</dt><dd>{task.model_name || "未记录"}</dd>
       {task.service_name && <><dt>模型服务</dt><dd>{task.service_name}</dd></>}
       {task.selection_reason && <><dt>选择依据</dt><dd>{task.selection_reason}</dd></>}
       <dt>请求画幅</dt><dd>{task.size?sizeText(task.size):"未记录"}</dd>
      {asset&&<><dt>实际尺寸</dt><dd>{asset.width&&asset.height?`${asset.width} × ${asset.height}`:"未记录"}</dd></>}</dl>
      {task.status==="uncertain"&&<p role="status">暂未确认生成结果，请先查询。不会自动重新提交。</p>}{task.error&&<p role="alert">{task.error}</p>}
      <div className="studio-actions">{asset&&!compare&&<><button className="studio-primary" disabled={!canEdit} onClick={()=>setEditing(true)}><Pencil size={15}/>编辑图片</button>{!canEdit&&<span className="studio-muted">请在模型设置中配置支持图片编辑的模型。</span>}<button disabled={!image.file} onClick={()=>{if(image.file)downloadBlob(image.file.blob,asset.original_filename);}}><Download size={15}/>下载原图</button>{archived.has(asset.id)?<button onClick={onWorks}>已归档 · 查看作品</button>:<button onClick={()=>void save()} disabled={saving}><Archive size={15}/>{saving?"正在归档…":"归档到我的作品"}</button>}</>}
      {!compare&&<button onClick={()=>onReuse(task)}><RotateCcw size={15}/>复用设置</button>}{task.conversation_id!=null&&<button onClick={()=>onConversation(task.conversation_id!)}>查看所属对话</button>}
      {task.status!=="done"&&<button onClick={onQuery}>查询任务状态</button>}</div>{error&&<p role="alert">{error}</p>}</div></div>}
    {issue&&<p className="studio-error" role="alert">{issue}</p>}</StudioDialog>;
}
