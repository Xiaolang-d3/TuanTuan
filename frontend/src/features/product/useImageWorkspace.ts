import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import type { StudioTask, createImageStudioApi } from "./imageStudioApi";

export type StudioApi = ReturnType<typeof createImageStudioApi>;
export type StatusFilter = StudioTask["status"] | "";
export type GenerateInput = Pick<StudioTask, "prompt" | "size" | "profile_id">;
export const statusText: Record<StudioTask["status"], string> = { running: "生成中", done: "已完成", failed: "生成失败", uncertain: "结果待确认" };
export const failureMessage = (e: unknown) => e instanceof Error ? e.message : "操作未完成，请检查连接";
export function sizeText(size: string) {
  if (!size || size === "auto") return "自动";
  const dimensions = /^(\d+)[x×](\d+)$/i.exec(size);
  if (!dimensions) return size;
  const [, w, h] = dimensions;
  return `${+w === +h ? "方图" : +w > +h ? "横图" : "竖图"} · ${w} × ${h}`;
}

const LIMIT = 18;
export function useStudioHistory(api: StudioApi, enabled: boolean, refresh: number) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<StudioTask[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = window.setTimeout(async () => {
      try {
        const page = await api.history({ offset, limit: LIMIT, q: query.trim() || undefined, status: status || undefined, signal: controller.signal });
        if (!controller.signal.aborted) {setItems(page.items); setHasMore(page.has_more);}
      } catch (e) { if (!controller.signal.aborted) setError(failureMessage(e)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, query.trim() ? 200 : 0);
    return () => {clearTimeout(timer); controller.abort();};
  }, [api, enabled, offset, query, refresh, status]);
  return { items, hasMore, loading, error, query, status, offset,
    search: (v: string) => { setQuery(v); setOffset(0); }, filter: (v: StatusFilter) => { setStatus(v); setOffset(0); },
    page: Math.floor(offset / LIMIT) + 1, next: () => setOffset(x => x + LIMIT), prev: () => setOffset(x => Math.max(0, x - LIMIT)) };
}

function getReceipt(key: string) { try { return sessionStorage.getItem(key); } catch { return null; } }
function saveReceipt(key: string, id: string | null) { try { if (id) sessionStorage.setItem(key,id); else sessionStorage.removeItem(key); } catch { /* Session storage may be disabled. */ } }

/** Only reads may be repeated. The in-flight id is remembered before sending any paid POST. */
export function useImageWorkspace(api: StudioApi, enabled: boolean, accountKey: string | number, onSettled: () => void) {
  const key = `tuantuan:image-studio:receipt:${accountKey}`;
  const [receipt,setReceipt] = useState<string | null>(() => getReceipt(key));
  const [recent, setRecent] = useState<StudioTask | null>(null);
  const [locked, setLocked] = useState(false);
  const [checked, setChecked] = useState(false);
  const [issue, setIssue] = useState("");
  const [check, setCheck] = useState(0);
  const [notFound,setNotFound] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const settled = useRef(onSettled); settled.current=onSettled;
  useEffect(() => {mounted.current=true;return () => {mounted.current=false;};},[]);
  const remember = useCallback((id: string | null) => {saveReceipt(key,id);setReceipt(id);},[key]);
  useEffect(() => {
    if (!enabled) { setChecked(false); return; }
    if (receipt || busy.current) return;
    const c = new AbortController();
    setChecked(false);
    api.history({ status:"running",limit:1,signal:c.signal }).then(({items}) => {
      if(c.signal.aborted) return;
      if(items[0]) {setRecent(items[0]);remember(items[0].id);} setChecked(true);
    }).catch(e => { if(!c.signal.aborted)setIssue(`无法确认是否有任务在途：${failureMessage(e)}`); });
    return () => c.abort();
  },[api,enabled,check,receipt,remember,locked]);
  useEffect(() => {
    if (!enabled || !receipt || locked) return;
    const c = new AbortController(); let timer: number | undefined;
    async function read() {
      try {
        const task = await api.task(receipt!,c.signal);
        if(c.signal.aborted)return;
        setRecent(task);setNotFound(false);setIssue(task.status==="failed"||task.status==="uncertain"?task.error||statusText[task.status]:"");setChecked(true);
        if(task.status==="running") timer=window.setTimeout(read,2000);
        else {remember(null);settled.current();}
      } catch(e) {
        if(c.signal.aborted)return;
        // A dropped response is not proof that the upstream did not receive the request.
        setNotFound(e instanceof ApiError && e.status===404);
        setIssue(`暂未确认生成结果。${failureMessage(e)}。请先查询原任务，系统不会自动重新提交。`);
      }
    }
    void read();return () => {c.abort();clearTimeout(timer);};
  },[api,enabled,receipt,locked,check,remember]);
  async function submit<T>(snapshot: GenerateInput, modelName: string, send: (id: string) => Promise<T>, source?:string) {
    if(!enabled || !checked || receipt || busy.current)return false;
    busy.current=true;setLocked(true);setIssue("");setNotFound(false);
    try {
      const id=crypto.randomUUID(); remember(id);
      setRecent({id, ...snapshot, model_name:modelName, source_asset_id:source || null, created_at:new Date().toISOString(),conversation_id:null,status:"running",assets:[]});
      await send(id);
      if(mounted.current)settled.current();
      return true;
    } catch(e) {
      if(!mounted.current)return false;
      if(e instanceof ApiError && [400,401,403,404,422].includes(e.status)) {
        // Validation and authorization errors occur before admission.
        remember(null);setRecent(null);setIssue(failureMessage(e));
      } else {
        setRecent(x=>x?{...x,status:"uncertain"}:null);
        setIssue(`暂未确认生成结果。${failureMessage(e)}。不会自动重发。`);
      }
      return false;
    } finally {busy.current=false;if(mounted.current)setLocked(false);}
  }
  return {submit, recent, locked, checked, receipt, issue, notFound,
    check: () => {setIssue("");setCheck(x=>x+1);},
    acknowledgeMissing: () => {if(!locked && notFound){remember(null);setIssue("");setRecent(null);setNotFound(false);}},
    busy: locked || !!receipt || !checked };
}
