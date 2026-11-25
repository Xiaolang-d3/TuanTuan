import { cleanup,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { ImageWorkspace } from "./ImageWorkspace";
import { ImageWorkspacePage } from "./ImageWorkspacePage";
import type { StudioModel, StudioPreviewRequest, StudioTask } from "./imageStudioApi";
import { ApiError, type createApiClient } from "../../api/client";
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
  it("仅在已登录、就绪且激活时回填草稿，同一交接 ID 不重复处理或生成", async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/image-studio/options") return { models: [] };
      if (path === "/agent/model-selection/preview") return { eligible: false, candidates: [], reason_code: "not_configured" };
      return { items: [] };
    });
    const consume = vi.fn();
    const props = {
      apiBase: "http://example.test", fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>, accountKey: "a",
      onOpenSettings: vi.fn(), onOpenWorks: vi.fn(), onOpenConversation: vi.fn(),
      refreshConversations: vi.fn().mockResolvedValue(null), onLibraryChanged: vi.fn().mockResolvedValue(undefined),
      creationDraft: { id: "handoff-1", content: "  晚霞下的书店\n街角留白  " }, onCreationDraftConsumed: consume,
    };
    const page = (accessToken: string, ready: boolean, active: boolean) => <StrictMode>
      <ImageWorkspacePage {...props} accessToken={accessToken} ready={ready} active={active}/>
    </StrictMode>;
    const view = render(page("", true, true));
    view.rerender(page("token", false, true));
    view.rerender(page("token", true, false));
    expect(screen.getByLabelText("画面描述")).toHaveValue("");
    expect(consume).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();

    view.rerender(page("token", true, true));
    expect(await screen.findByRole("heading", { name: "尚未配置模型" })).toBeVisible();
    expect(screen.getByLabelText("画面描述")).toHaveValue(props.creationDraft.content);
    expect(consume).toHaveBeenCalledExactlyOnceWith("handoff-1");
    expect(fetchJson.mock.calls.map(([path]) => path)).not.toContain("/image-studio/generate");

    fireEvent.change(screen.getByLabelText("画面描述"), { target: { value: "" } });
    view.rerender(page("token", true, false));
    view.rerender(page("token", true, true));
    await screen.findByRole("heading", { name: "尚未配置模型" });
    expect(screen.getByLabelText("画面描述")).toHaveValue("");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("已有描述时明确询问，不因清空文本而自动覆盖，并支持保留或接受", async () => {
    const { api, props, view } = setup();
    const consume = vi.fn();
    const prompt = screen.getByLabelText("画面描述");
    fireEvent.change(prompt, { target: { value: "我自己写的草稿" } });
    const handoff = (id: string, content: string) => view.rerender(<ImageWorkspace {...props}
      creationDraft={{ id, content }} onCreationDraftConsumed={consume}/>);

    handoff("declined", "被保留现稿所拒绝的描述");
    const choice = screen.getByRole("group", { name: "处理新创作草稿" });
    expect(prompt).toHaveValue("我自己写的草稿");
    expect(consume).not.toHaveBeenCalled();
    fireEvent.change(prompt, { target: { value: "" } });
    expect(prompt).toHaveValue("");
    expect(consume).not.toHaveBeenCalled();
    fireEvent.change(prompt, { target: { value: "修订后的草稿" } });
    fireEvent.click(within(choice).getByRole("button", { name: "保留当前描述" }));
    handoff("declined", "被保留现稿所拒绝的描述");
    expect(prompt).toHaveValue("修订后的草稿");
    expect(prompt).toHaveFocus();
    expect(screen.queryByRole("group", { name: "处理新创作草稿" })).not.toBeInTheDocument();
    expect(consume).toHaveBeenCalledExactlyOnceWith("declined");

    handoff("accepted", "来自首页的新草稿");
    fireEvent.click(screen.getByRole("button", { name: "使用新草稿" }));
    expect(prompt).toHaveValue("来自首页的新草稿");
    expect(prompt).toHaveFocus();
    expect(consume.mock.calls).toEqual([["declined"], ["accepted"]]);
    await waitFor(() => expect(screen.getByRole("button", { name: "生成图片" })).toBeEnabled());
    expect(api.generate).not.toHaveBeenCalled();
  });

  it("账号切换不会继承未处理的交接或另一个账号的现稿", async () => {
    sessionStorage.setItem("tuantuan:image-studio:draft:b", "乙账号原有草稿");
    const { api, props, view } = setup();
    const consume = vi.fn();
    const firstOffer = { id: "a-draft", content: "仅甲账号的交接草稿" };
    const firstProps = { ...props, enabled: false, creationDraft: firstOffer, onCreationDraftConsumed: consume };
    view.rerender(<ImageWorkspace {...firstProps}/>);
    view.rerender(<ImageWorkspace {...firstProps} enabled accountKey="b"/>);
    expect(screen.getByLabelText("画面描述")).toHaveValue("乙账号原有草稿");
    expect(screen.queryByRole("group", { name: "处理新创作草稿" })).not.toBeInTheDocument();
    expect(screen.queryByText(firstOffer.content)).not.toBeInTheDocument();
    expect(consume).not.toHaveBeenCalled();

    const secondOffer = { id: "b-draft", content: "仅乙账号的交接草稿" };
    view.rerender(<ImageWorkspace {...firstProps} enabled accountKey="b" creationDraft={secondOffer}/>);
    fireEvent.click(screen.getByRole("button", { name: "使用新草稿" }));
    expect(screen.getByLabelText("画面描述")).toHaveValue(secondOffer.content);
    expect(consume).toHaveBeenCalledExactlyOnceWith("b-draft");
    view.rerender(<ImageWorkspace {...firstProps} enabled/>);
    expect(screen.getByLabelText("画面描述")).toHaveValue(firstOffer.content);
    expect(consume.mock.calls).toEqual([["b-draft"], ["a-draft"]]);
    await waitFor(() => expect(screen.getByRole("button", { name: "生成图片" })).toBeEnabled());
    expect(api.generate).not.toHaveBeenCalled();
  });

  it("去模型设置后重新打开图片工作区仍保留未提交的描述", async () => {
    const { api, props, view } = setup();
    const consume = vi.fn();
    const creationDraft = { id: "settings-draft", content: "夜晚的城市公园" };
    view.rerender(<ImageWorkspace {...props} creationDraft={creationDraft} onCreationDraftConsumed={consume}/>);
    expect(screen.getByLabelText("画面描述")).toHaveValue(creationDraft.content);
    fireEvent.change(screen.getByLabelText("画面描述"), { target: { value: "有星光的城市公园" } });
    fireEvent.click(screen.getByRole("button", { name: "设置图片模型" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    view.unmount();
    render(<ImageWorkspace {...props}/>);
    expect(screen.getByLabelText("画面描述")).toHaveValue("有星光的城市公园");
    expect(consume).toHaveBeenCalledExactlyOnceWith("settings-draft");
    await waitFor(() => expect(screen.getByRole("button", { name: "生成图片" })).toBeEnabled());
    expect(api.generate).not.toHaveBeenCalled();
  });

  it("没有可用图片模型时显示明确引导并跳转配置，不展示生成示例", async () => {
    const { api, props } = setup([], []);
    expect(await screen.findByRole("heading", { name: "尚未配置模型" })).toBeVisible();
    const guide = screen.getByRole("region", { name: "尚未配置模型" });
    expect(within(guide).getByText("还没有可用的图片模型")).toBeVisible();
    expect(within(guide).getByText("团团暂不提供免费图片模型，请配置自己的模型服务后开始创作。")).toBeVisible();
    fireEvent.click(within(guide).getByText("模型接入说明和配置教程"));
    expect(within(guide).getByText(/测试连接，然后添加支持图片生成的模型/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "商品封面" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "配置图片模型" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(api.generate).not.toHaveBeenCalled();
  });
  it("存在可用图片模型时不显示未配置引导", async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText("图片模型")).toHaveDisplayValue("海报模型"));
    expect(screen.queryByRole("heading", { name: "尚未配置模型" })).not.toBeInTheDocument();
  });
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
  it("提交即离开广场，返回不中断任务，结果留在本次生成视图", async () => {
    const { api } = setup([task]);
    let finish!: () => void;
    api.generate.mockImplementationOnce(request => new Promise(resolve => {
      api.task.mockResolvedValueOnce({ ...task, id: request.request_id, prompt: request.prompt });
      finish = () => resolve({ id: request.request_id });
    }));
    const previous = await screen.findByRole("button", { name: "查看 海边画面" });
    fireEvent.change(screen.getByLabelText("画面描述"), { target: { value: "新的风景" } });
    const submit = screen.getByRole("button", { name: "生成图片" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    const stage = screen.getByRole("region", { name: "本次图片生成" });
    expect(within(stage).getByRole("heading", { name: "生成中" })).toHaveFocus();
    expect(within(stage).getByText("新的风景")).toBeVisible();
    expect(previous).not.toBeInTheDocument();
    fireEvent.click(within(stage).getByRole("button", { name: "返回创作广场" }));
    expect(screen.getByRole("button", { name: "查看 海边画面" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看任务" }));
    finish();
    const result = screen.getByRole("region", { name: "本次图片生成" });
    expect(await within(result).findByRole("heading", { name: "图片已生成" })).toBeVisible();
    expect(await within(result).findByRole("img", { name: "海报.png" })).toBeVisible();
    expect(within(result).queryByText(/正在根据描述生成/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看 海边画面" })).not.toBeInTheDocument();
    expect(api.generate).toHaveBeenCalledTimes(1);
  });
  it("生成失败后停止动画并在当前视图显示原因", async () => {
    const { api } = setup();
    api.generate.mockImplementationOnce(async request => {
      api.task.mockResolvedValueOnce({ ...task, id: request.request_id, prompt: request.prompt,
        status: "failed", assets: [], error: "图片服务暂时不可用" });
      return { id: request.request_id };
    });
    fireEvent.change(screen.getByLabelText("画面描述"), { target: { value: "新的风景" } });
    const submit = screen.getByRole("button", { name: "生成图片" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    const stage = screen.getByRole("region", { name: "本次图片生成" });
    expect(await within(stage).findByRole("heading", { name: "生成失败" })).toBeVisible();
    expect(within(stage).getByRole("alert")).toHaveTextContent("图片服务暂时不可用");
    expect(stage.querySelector(".studio-generation-animation")).not.toBeInTheDocument();
    expect(api.generate).toHaveBeenCalledTimes(1);
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
    expect(screen.getByLabelText("画面描述")).toHaveValue("秋日市集");
    const retry = screen.getByRole("button", { name: "生成图片" });
    expect(retry).toBeDisabled();
    expect(api.task).not.toHaveBeenCalled();
    await waitFor(() => expect(resolvePreview).toBeTypeOf("function"));
    resolvePreview({ ...originalPreview, comparison_key: "new-preview" });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(api.generate).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
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
