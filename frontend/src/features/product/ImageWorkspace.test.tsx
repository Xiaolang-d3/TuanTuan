import { cleanup,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { ImageWorkspace } from "./ImageWorkspace";
import type { StudioModel,StudioTask } from "./imageStudioApi";
import type { StudioApi } from "./useImageWorkspace";
import { downloadBlob } from "../chat/result-files";
vi.mock("../chat/result-files",()=>({downloadBlob:vi.fn()}));
const model:StudioModel={id:"p1",name:"海报模型",sizes:["auto","1536x1024"]};
const task:StudioTask={id:"job-1",prompt:"海边画面",size:"1536x1024",profile_id:model.id,model_name:model.name,status:"done",created_at:"2026-11-19T11:00:00Z",conversation_id:42,assets:[{id:"image-1",origin:"generated",kind:"image",original_filename:"海报.png",parse_status:"parsed",width:1536,height:1024}]};
const blob=new Blob(["pic"],{type:"image/png"});
function setup(items:StudioTask[]=[], models=[model], more=false, canEdit=true){
  const api={options:vi.fn().mockResolvedValue({models,default_profile_id:models[0]?.id,can_edit:canEdit}),history:vi.fn(async(query:{status?:string;q?:string;offset?:number}={})=>({items:items.filter(x=>(!query.status||x.status===query.status)&&(!query.q||x.prompt.includes(query.q))),has_more:more&&!query.offset})),
    task:vi.fn().mockResolvedValue(task),works:vi.fn().mockResolvedValue({items:[]}),archive:vi.fn().mockResolvedValue({id:"w1",asset:task.assets[0]}),generate:vi.fn().mockResolvedValue({id:"job"}),
    assetFile:vi.fn().mockResolvedValue(blob),thumbnail:vi.fn().mockResolvedValue(blob),edit:vi.fn().mockImplementation(async()=>({assets:task.assets,conversation_id:42,message_id:12}))};
  const props={api:api as unknown as StudioApi,enabled:true, accountKey:"a",onOpenSettings:vi.fn(),onOpenWorks:vi.fn(),onOpenConversation:vi.fn(),refreshConversations:vi.fn().mockResolvedValue(null),onLibraryChanged:vi.fn().mockResolvedValue(null)};
  const view=render(<ImageWorkspace {...props}/>);return {api,props,view};
}
beforeEach(()=>{vi.stubGlobal("URL",Object.assign(class extends URL{},{createObjectURL:vi.fn().mockReturnValue("blob:pic"),revokeObjectURL:vi.fn()}));});
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
describe("图片工作台",()=>{
  it("真实空态示例只回填，选择每轮支持的模型和画幅后才提交",async()=>{
    const {api}=setup([], [{id:"auto",name:"自动模型",sizes:["auto"]},model]);
    fireEvent.click(await screen.findByRole("button",{name:"商品封面"}));expect(api.generate).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox",{name:"生成画幅"})).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("图片模型"),{target:{value:"p1"}});fireEvent.change(screen.getByLabelText("生成画幅"),{target:{value:"1536x1024"}});
    fireEvent.change(screen.getByLabelText("画面描述"),{target:{value:"  夏日海报  "}});fireEvent.click(screen.getByRole("button",{name:"生成图片"}));
    await waitFor(()=>expect(api.generate).toHaveBeenCalledWith({prompt:"夏日海报",size:"1536x1024",profile_id:"p1",request_id:expect.stringMatching(/^[0-9a-f-]{36}$/i)}));
  });
  it("历史分页、搜索和筛选可组合，且不会发生成请求",async()=>{
    const {api}=setup([task],[model],true);await screen.findByRole("button",{name:"查看 海边画面"});fireEvent.click(screen.getByRole("button",{name:"下一页"}));
    await waitFor(()=>expect(api.history).toHaveBeenCalledWith(expect.objectContaining({offset:18})));fireEvent.change(screen.getByLabelText("搜索创作记录"),{target:{value:"海边"}});
    fireEvent.change(screen.getByLabelText("任务状态"),{target:{value:"done"}});await waitFor(()=>expect(api.history).toHaveBeenCalledWith(expect.objectContaining({offset:0,q:"海边",status:"done"})));expect(api.generate).not.toHaveBeenCalled();
  });
  it("复用设置先保护已有草稿，并恢复支持的模型和尺寸",async()=>{
    const {api}=setup([task]);const open=await screen.findByRole("button",{name:"查看 海边画面"});
    const prompt=screen.getByLabelText("画面描述");fireEvent.change(prompt,{target:{value:"新草稿"}});fireEvent.click(open);
    const confirm=vi.spyOn(window,"confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByText("复用设置"));expect(prompt).toHaveValue("新草稿");fireEvent.click(screen.getByText("复用设置"));
    expect(confirm).toHaveBeenCalledTimes(2);expect(prompt).toHaveValue(task.prompt);expect(screen.getByLabelText("生成画幅")).toHaveValue(task.size);expect(api.generate).not.toHaveBeenCalled();
  });
  it("不能编辑的配置不展示可提交的编辑操作",async()=>{
    setup([task],[model],false,false);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));
    expect(within(screen.getByRole("dialog")).getByRole("button",{name:"编辑图片"})).toBeDisabled();
    expect(screen.getByText("请在模型设置中配置支持图片编辑的模型。")).toBeVisible();
  });
  it("模型已删除的历史不静默改用默认模型",async()=>{
    setup([{...task,profile_id:"gone"}]);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));fireEvent.click(screen.getByText("复用设置"));
    expect(screen.getByText(/原模型已不可用/)).toBeInTheDocument();expect(screen.getByRole("button",{name:"生成图片"})).toBeDisabled();expect(screen.getByLabelText("画面描述")).toHaveValue(task.prompt);
  });
  it("详情使用受保护原文件，下载与归档仅针对选中的输出",async()=>{
    const a={...task.assets[0],id:"image-2",original_filename:"第二张.png"};const {api,props,view}=setup([{...task,assets:[task.assets[0],a]}]);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));
    fireEvent.click(screen.getByRole("button",{name:"第 2 张"}));const dialog=screen.getByRole("dialog");await within(dialog).findByRole("img",{name:"第二张.png"});expect(api.assetFile).toHaveBeenLastCalledWith("image-2",expect.any(AbortSignal));
    expect(within(dialog).getByText("1536 × 1024",{exact:true})).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"下载原图"}));expect(downloadBlob).toHaveBeenCalledWith(blob,"第二张.png");
    fireEvent.click(screen.getByRole("button",{name:"归档到我的作品"}));fireEvent.click(await screen.findByText("已归档 · 查看作品"));expect(api.archive).toHaveBeenCalledWith("image-2");expect(props.onOpenWorks).toHaveBeenCalledOnce();view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it("文字编辑使用独立操作号、明确来源，不污染下轮画面描述",async()=>{
    const {api}=setup([task]);await screen.findByRole("button",{name:"查看 海边画面"});const prompt=screen.getByLabelText("画面描述");fireEvent.change(prompt,{target:{value:"下一轮草稿"}});
    fireEvent.click(screen.getByRole("button",{name:"编辑图片 海边画面"}));await screen.findByRole("img",{name:"原图：海报.png"});fireEvent.change(screen.getByLabelText("修改要求"),{target:{value:"换成橙色，保持构图"}});
    fireEvent.click(screen.getByRole("button",{name:"生成新版本"}));await waitFor(()=>expect(api.edit).toHaveBeenCalledWith("image-1",expect.objectContaining({operation_id:expect.any(String),mode:"edit",prompt:"换成橙色，保持构图"})));
    expect(api.generate).not.toHaveBeenCalled();expect(prompt).toHaveValue("下一轮草稿");
  });
});
