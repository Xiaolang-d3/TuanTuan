import { cleanup,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { ImageWorkspace } from "./ImageWorkspace";
import type { StudioModel, StudioPreviewRequest, StudioTask } from "./imageStudioApi";
import { ApiError } from "../../api/client";
import type { StudioApi } from "./useImageWorkspace";
import { downloadBlob } from "../chat/result-files";
vi.mock("../chat/result-files",()=>({downloadBlob:vi.fn()}));
const model:StudioModel={id:"p1",name:"海报模型",sizes:["auto","1536x1024"]};
const task:StudioTask={id:"job-1",prompt:"海边画面",size:"1536x1024",profile_id:model.id,model_name:model.name,status:"done",created_at:"2026-11-19T11:00:00Z",conversation_id:42,assets:[{id:"image-1",origin:"generated",kind:"image",original_filename:"海报.png",parse_status:"parsed",width:1536,height:1024}]};
const blob=new Blob(["pic"],{type:"image/png"});
function setup(items:StudioTask[]=[], models=[model], more=false, canEdit=true, unavailable: string[] = [], defaultProfileId = models[0]?.id){
  const preview = vi.fn(async ({ profile_id, operation }: StudioPreviewRequest) => {
    const candidates = models.map((item, index) => ({
      profile_id: item.id, model_name: item.name, service_name: `服务 ${index + 1}`, eligible: !unavailable.includes(item.id),
    }));
    const eligible = models.filter(item => !unavailable.includes(item.id));
    const resolved = profile_id == null
      ? eligible.find(item => item.id === defaultProfileId) ?? eligible[0]
      : eligible.find(item => item.id === profile_id);
    const candidate = candidates.find(item => item.profile_id === resolved?.id);
    return {
      eligible: !!resolved,
      selection: candidate && resolved ? { ...candidate, sizes: resolved.sizes, reason: "automatic" } : null,
      comparison_key: resolved ? `${operation}:${resolved.id}` : null,
      candidates,
      requires_confirmation: false,
      reason: resolved ? undefined : "原模型已不可用",
    };
  });
  const api={preview,options:vi.fn().mockResolvedValue({models,default_profile_id:models[0]?.id,can_edit:canEdit}),history:vi.fn(async(query:{status?:string;q?:string;offset?:number}={})=>({items:items.filter(x=>(!query.status||x.status===query.status)&&(!query.q||x.prompt.includes(query.q))),has_more:more&&!query.offset})),
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
    fireEvent.change(screen.getByLabelText("图片模型"), { target: { value: "p1" } });
    const size = await screen.findByLabelText("生成画幅");
    expect(screen.getByLabelText("图片模型")).toHaveDisplayValue("海报模型");
    fireEvent.change(size, { target: { value: "1536x1024" } });
    fireEvent.change(screen.getByLabelText("画面描述"),{target:{value:"  夏日海报  "}});fireEvent.click(screen.getByRole("button",{name:"生成图片"}));
    await waitFor(()=>expect(api.generate).toHaveBeenCalledWith({prompt:"夏日海报",size:"1536x1024",profile_id:"p1",comparison_key:"image.generate:p1",request_id:expect.stringMatching(/^[0-9a-f-]{36}$/i)}));
  });
  it("下拉框显示当前模型，只列出可用且不重复的模型名称", async () => {
    setup([], [{ ...model, id: "duplicate" }, model, { ...model, id: "p2", name: "插画模型" }, { ...model, id: "disabled", name: "停用模型" }], false, true, ["disabled"], model.id);
    const picker = screen.getByRole("combobox", { name: "图片模型" });
    await waitFor(() => expect(picker).toHaveDisplayValue("海报模型"));
    expect(within(picker).getAllByRole("option").map(option => option.textContent)).toEqual(["海报模型", "插画模型"]);
    expect(picker).toHaveValue("p1");
    expect(screen.queryByText(/本次使用|服务 1/)).not.toBeInTheDocument();
  });
  it("出图配置变化时保留草稿，等待新预览并再次提交", async () => {
    const { api } = setup();
    await waitFor(() => expect(screen.getByLabelText("图片模型")).toHaveDisplayValue("海报模型"));
    await screen.findByRole("button", { name: "商品封面" });
    const originalPreview = await api.preview({ operation: "image.generate", profile_id: null });
    let resolvePreview!: (value: typeof originalPreview) => void;
    api.preview.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve; }));
    api.generate.mockRejectedValueOnce(new ApiError("模型配置已变化", 409, 0, { code: "model_selection_changed" }));
    const draft = screen.getByLabelText("画面描述");
    fireEvent.change(draft, { target: { value: "秋日市集" } });
    const submit = screen.getByRole("button", { name: "生成图片" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(await screen.findByText("模型配置已变化")).toBeVisible();
    expect(draft).toHaveValue("秋日市集");
    expect(submit).toBeDisabled();
    expect(api.task).not.toHaveBeenCalled();
    await waitFor(() => expect(resolvePreview).toBeTypeOf("function"));
    resolvePreview({ ...originalPreview, comparison_key: "new-preview" });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(api.generate).toHaveBeenCalledTimes(1);
    fireEvent.click(submit);
    await waitFor(() => expect(api.generate).toHaveBeenLastCalledWith(expect.objectContaining({ comparison_key: "new-preview", profile_id: null, prompt: "秋日市集" })));
  });
  it("历史分页、搜索和筛选可组合，且不会发生成请求",async()=>{
    const {api}=setup([task],[model],true);await screen.findByRole("button",{name:"查看 海边画面"});fireEvent.click(screen.getByRole("button",{name:"下一页"}));
    await waitFor(()=>expect(api.history).toHaveBeenCalledWith(expect.objectContaining({offset:18})));fireEvent.change(screen.getByLabelText("搜索创作记录"),{target:{value:"海边"}});
    fireEvent.change(screen.getByLabelText("任务状态"),{target:{value:"done"}});await waitFor(()=>expect(api.history).toHaveBeenCalledWith(expect.objectContaining({offset:0,q:"海边",status:"done"})));expect(api.generate).not.toHaveBeenCalled();
  });
  it("复用描述生图先保护已有草稿，并恢复支持的模型和尺寸",async()=>{
    const {api}=setup([task]);const open=await screen.findByRole("button",{name:"查看 海边画面"});
    const prompt=screen.getByLabelText("画面描述");fireEvent.change(prompt,{target:{value:"新草稿"}});fireEvent.click(open);
    const confirm=vi.spyOn(window,"confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const reuse = within(screen.getByRole("dialog", { name: "图片详情" })).getByRole("button", { name: "复用描述生图" });
    fireEvent.click(reuse);expect(prompt).toHaveValue("新草稿");fireEvent.click(reuse);
    expect(confirm).toHaveBeenCalledTimes(2);expect(prompt).toHaveValue(task.prompt);expect(await screen.findByLabelText("生成画幅")).toHaveValue(task.size);expect(api.generate).not.toHaveBeenCalled();
  });
  it("不能编辑的配置不展示可提交的编辑操作",async()=>{
    setup([task],[model],false,false);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));
    expect(within(screen.getByRole("dialog")).getByRole("button",{name:"编辑图片"})).toBeDisabled();
    expect(screen.getByText("请在模型设置中配置支持图片编辑的模型。")).toBeVisible();
  });
  it("完成卡片仅展示图片和描述，从图片详情进入编辑或复用描述", async () => {
    setup([{ ...task, source_asset_id: "original-image" }]);
    const card = await screen.findByRole("article");
    await within(card).findByAltText("");
    expect(card).toHaveTextContent(/^海边画面$/);
    expect(within(card).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(within(card).getByRole("button", { name: "查看 海边画面" }));
    const detail = screen.getByRole("dialog", { name: "图片详情" });
    expect(within(detail).getByRole("button", { name: "复用描述生图" })).toBeEnabled();
    fireEvent.click(within(detail).getByRole("button", { name: /^编辑图片$/ }));
    expect(screen.getByRole("dialog", { name: "编辑图片" })).toBeVisible();
  });
  it("模型已删除的历史不静默改用默认模型",async()=>{
    setup([{...task,profile_id:"gone"}]);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));fireEvent.click(screen.getByRole("button",{name:"复用描述生图"}));
    expect(await screen.findByText(/原模型已不可用/)).toBeInTheDocument();expect(screen.getByRole("button",{name:"生成图片"})).toBeDisabled();expect(screen.getByLabelText("画面描述")).toHaveValue(task.prompt);
  });
  it("详情使用受保护原文件，下载与归档仅针对选中的输出",async()=>{
    const a={...task.assets[0],id:"image-2",original_filename:"第二张.png"};const {api,props,view}=setup([{...task,assets:[task.assets[0],a]}]);fireEvent.click(await screen.findByRole("button",{name:"查看 海边画面"}));
    fireEvent.click(screen.getByRole("button",{name:"第 2 张"}));const dialog=screen.getByRole("dialog");await within(dialog).findByRole("img",{name:"第二张.png"});expect(api.assetFile).toHaveBeenLastCalledWith("image-2",expect.any(AbortSignal));
    expect(within(dialog).getByText("1536 × 1024",{exact:true})).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"下载原图"}));expect(downloadBlob).toHaveBeenCalledWith(blob,"第二张.png");
    fireEvent.click(screen.getByRole("button",{name:"归档到我的作品"}));fireEvent.click(await screen.findByText("已归档 · 查看作品"));expect(api.archive).toHaveBeenCalledWith("image-2");expect(props.onOpenWorks).toHaveBeenCalledOnce();view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it("跨服务改图确认只适用于当前预览，409 后保留修改要求", async () => {
    const { api } = setup([task], [model, { ...model, id: "p2", name: "插画模型" }]);
    const original = api.preview.getMockImplementation()!;
    let keyVersion = 1;
    api.preview.mockImplementation(async request => {
      const result = await original(request);
      return request.operation === "image.edit" ? {
        ...result, comparison_key: `edit:${request.profile_id ?? "automatic"}:${keyVersion}`, requires_confirmation: true,
      } : result;
    });
    api.edit.mockImplementationOnce(async () => {
      keyVersion++;
      throw new ApiError("发送原图前，请确认目标模型服务", 409, 0, { code: "image_data_boundary_confirmation_required" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "查看 海边画面" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "图片详情" })).getByRole("button", { name: "编辑图片" }));
    const dialog = screen.getByRole("dialog");
    const draft = within(dialog).getByLabelText("修改要求");
    fireEvent.change(draft, { target: { value: "改成暖色系" } });
    const submit = within(dialog).getByRole("button", { name: "生成新版本" });
    const first = await within(dialog).findByRole("checkbox", { name: /服务 1/ });
    const picker = within(dialog).getByLabelText("编辑模型");
    expect(picker).toHaveDisplayValue("海报模型");
    expect(submit).toBeDisabled();
    fireEvent.click(first);
    fireEvent.change(picker, { target: { value: "p2" } });
    const second = await within(dialog).findByRole("checkbox", { name: /服务 2/ });
    expect(picker).toHaveDisplayValue("插画模型");
    expect(second).not.toBeChecked();
    expect(submit).toBeDisabled();
    fireEvent.click(second);
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(await within(dialog).findByText("发送原图前，请确认目标模型服务")).toBeVisible();
    expect(draft).toHaveValue("改成暖色系");
    const renewed = await within(dialog).findByRole("checkbox", { name: /服务 2/ });
    expect(renewed).not.toBeChecked();
    expect(submit).toBeDisabled();
    expect(api.task).not.toHaveBeenCalled();
    expect(api.edit).toHaveBeenCalledWith("image-1", expect.objectContaining({ profile_id: "p2", comparison_key: "edit:p2:1", confirm_data_boundary: true }));
    fireEvent.click(renewed);
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(api.edit).toHaveBeenLastCalledWith("image-1", expect.objectContaining({ profile_id: "p2", comparison_key: "edit:p2:2", confirm_data_boundary: true })));
  });
  it("文字编辑使用独立操作号、明确来源，不污染下轮画面描述",async()=>{
    const {api}=setup([task]);await screen.findByRole("button",{name:"查看 海边画面"});const prompt=screen.getByLabelText("画面描述");fireEvent.change(prompt,{target:{value:"下一轮草稿"}});
    fireEvent.click(screen.getByRole("button",{name:"查看 海边画面"}));
    fireEvent.click(within(screen.getByRole("dialog", { name: "图片详情" })).getByRole("button", { name: "编辑图片" }));
    await screen.findByRole("img",{name:"原图：海报.png"});fireEvent.change(screen.getByLabelText("修改要求"),{target:{value:"换成橙色，保持构图"}});
    const submit = screen.getByRole("button", { name: "生成新版本" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(api.edit).toHaveBeenCalledWith("image-1", expect.objectContaining({
      operation_id: expect.any(String), mode: "edit", prompt: "换成橙色，保持构图",
      profile_id: null, comparison_key: "image.edit:p1", confirm_data_boundary: false,
    })));
    expect(api.generate).not.toHaveBeenCalled();expect(prompt).toHaveValue("下一轮草稿");
  });
});
