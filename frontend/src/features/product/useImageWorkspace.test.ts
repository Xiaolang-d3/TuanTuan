import { act,cleanup,renderHook,waitFor } from "@testing-library/react";
import { afterEach,describe,expect,it,vi } from "vitest";
import { ApiError } from "../../api/client";
import { sizeText,useImageWorkspace,type StudioApi } from "./useImageWorkspace";
import type { StudioTask } from "./imageStudioApi";
const original={prompt:"海报",size:"1536x1024",profile_id:"p1"};
const result:StudioTask={...original,id:"job",created_at:"2026-11-19",model_name:"Images",assets:[],conversation_id:42,status:"done"};
function mockApi(task=vi.fn().mockResolvedValue(result)){return {history:vi.fn().mockResolvedValue({items:[],has_more:false}),task} as unknown as StudioApi;}
afterEach(()=>{cleanup();sessionStorage.clear();});

describe("工作台读取与付费请求边界",()=>{
  it("同一时刻只发送一次，收到回执后查询实际状态",async()=>{
    let accept!:()=>void;const send=vi.fn(()=>new Promise<void>(r=>{accept=r;}));const api=mockApi();const settled=vi.fn();
    const {result:r}=renderHook(()=>useImageWorkspace(api,true,1,settled));await waitFor(()=>expect(r.current.busy).toBe(false));
    let submission!:Promise<boolean>;
    act(()=>{submission=r.current.submit(original,"Images",send);void r.current.submit(original,"Images",send);});
    expect(send).toHaveBeenCalledTimes(1);const id=send.mock.calls[0] as unknown as string[];expect(id[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sessionStorage.getItem("tuantuan:image-studio:receipt:1")).toBe(id[0]);
    expect(r.current.recent?.status).toBe("running");await act(async()=>{accept();await submission;});
    await waitFor(()=>expect(r.current.recent?.status).toBe("done"));expect(api.task).toHaveBeenCalledWith(id[0],expect.any(AbortSignal));expect(send).toHaveBeenCalledTimes(1);
  });
  it("断流仅查回执，刷新后可继续核对；不会重新付费",async()=>{
    const task=vi.fn().mockRejectedValue(new Error("连接中断"));const api=mockApi(task);const send=vi.fn().mockRejectedValue(new Error("连接中断"));
    const hook=renderHook(()=>useImageWorkspace(api,true,1,vi.fn()));await waitFor(()=>expect(hook.result.current.busy).toBe(false));
    await act(()=>hook.result.current.submit(original,"Images",send));await waitFor(()=>expect(hook.result.current.issue).toContain("查询原任务"));
    const receipt=hook.result.current.receipt;hook.unmount();task.mockResolvedValue({...result,id:receipt,status:"uncertain"});
    const again=renderHook(()=>useImageWorkspace(api,true,1,vi.fn()));await waitFor(()=>expect(again.result.current.recent?.status).toBe("uncertain"));
    expect(task).toHaveBeenLastCalledWith(receipt,expect.any(AbortSignal));expect(send).toHaveBeenCalledTimes(1);
  });
  it("拒绝非法画幅时保留错误并不制造查询死锁",async()=>{
    const api=mockApi();const hook=renderHook(()=>useImageWorkspace(api,true,1,vi.fn()));await waitFor(()=>expect(hook.result.current.busy).toBe(false));
    await act(()=>hook.result.current.submit(original,"Images",vi.fn().mockRejectedValue(new ApiError("模型不支持画幅",422))));await waitFor(()=>expect(hook.result.current.busy).toBe(false));
    expect(hook.result.current.issue).toContain("不支持");expect(api.task).not.toHaveBeenCalled();
  });
  it("不把不同模型的尺寸强行归一",()=>{expect(sizeText("1536x1024")).toBe("横图 · 1536 × 1024");expect(sizeText("512x512")).toMatch(/方图/);expect(sizeText("auto")).toBe("自动");});
});
