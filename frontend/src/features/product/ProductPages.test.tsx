import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoPage, WorksPage } from "./ProductPages";

import type { createApiClient } from "../../api/client";
import { downloadBlob } from "../chat/result-files";
import * as imageApi from "./imageStudioApi";
vi.mock("../chat/result-files",()=>({downloadBlob:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function callbacks() {
  return { onOpenChat: vi.fn(), onOpenLibrary: vi.fn(), onOpenSettings: vi.fn() };
}

describe("product pages", () => {
  it("states video limitations without presenting a generation action", () => {
    const props = callbacks();
    render(<VideoPage {...props} />);
    expect(screen.getByText("视频生成尚未接入。")).toBeInTheDocument();
    expect(screen.getByText("图生视频的首版范围待定，目前还不能在这里生成视频。")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /生成视频/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(props.onOpenChat).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onOpenLibrary).not.toHaveBeenCalled();
  });

  it("opens and downloads an archived image work", async () => {
    vi.stubGlobal("URL",Object.assign(class extends URL{},{createObjectURL:vi.fn().mockReturnValue("blob:work"),revokeObjectURL:vi.fn()}));
    const file=new Blob(["independent bytes"]);const api={works:vi.fn().mockResolvedValue({items:[{id:"work1",created_at:"2026-11-19",asset:{id:"source",original_filename:"定稿.png"}}]}),workFile:vi.fn().mockResolvedValue(file),workThumbnail:vi.fn().mockResolvedValue(new Blob())};
    vi.spyOn(imageApi,"createImageStudioApi").mockReturnValue(api as unknown as imageApi.ImageStudioApi);
    render(<WorksPage apiBase="/api" accessToken="" ready fetchJson={vi.fn().mockResolvedValue({items:[]}) as ReturnType<typeof createApiClient>} onOpenImages={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button",{name:"查看作品"}));const dlg=screen.getByRole("dialog",{name:"作品详情"});
    await waitFor(()=>expect(within(dlg).getByText("下载原图")).toBeEnabled());fireEvent.click(within(dlg).getByText("下载原图"));expect(api.workFile).toHaveBeenCalledWith("work1",expect.any(AbortSignal));expect(downloadBlob).toHaveBeenCalledWith(file,"定稿.png");
  });

  it("lists generated images, saved documents and finished presentations without archiving", async () => {
    vi.stubGlobal("URL",Object.assign(class extends URL{},{createObjectURL:vi.fn().mockReturnValue("blob:gen"),revokeObjectURL:vi.fn()}));
    const original=new Blob(["generated"]);
    const api={works:vi.fn().mockResolvedValue({items:[{id:"work1",created_at:"2026-11-19",asset:{id:"archived-asset",original_filename:"定稿.png"}}]}),workFile:vi.fn(),workThumbnail:vi.fn().mockResolvedValue(new Blob()),
      history:vi.fn().mockResolvedValue({items:[{id:"task1",created_at:"2026-11-22",assets:[{id:"archived-asset",kind:"image",original_filename:"定稿.png"},{id:"gen-asset",kind:"image",original_filename:"海报.png",width:1024,height:768}]}],has_more:false}),
      thumbnail:vi.fn().mockResolvedValue(new Blob()),assetFile:vi.fn().mockResolvedValue(original)};
    vi.spyOn(imageApi,"createImageStudioApi").mockReturnValue(api as unknown as imageApi.ImageStudioApi);
    const fetchJson=vi.fn().mockImplementation((endpoint:string)=>Promise.resolve(endpoint==="/documents"?{documents:[{document_id:"doc1",title:"周报",latest_version:2,conversation_id:7,message_id:null,created_at:"2026-11-23"}]}
      :endpoint.startsWith("/creation-records")?{items:[{kind:"presentation",id:"job1",title:"路演",updated_at:"2026-11-24",conversation_id:9,status:"succeeded"},{kind:"presentation",id:"job2",title:"草稿",updated_at:"2026-11-24",conversation_id:9,status:"running"}],has_more:false}:{items:[]}));
    const onOpenRecord=vi.fn();
    render(<WorksPage apiBase="/api" accessToken="" ready fetchJson={fetchJson as ReturnType<typeof createApiClient>} onOpenImages={vi.fn()} onOpenRecord={onOpenRecord}/>);
    expect(await screen.findByText("海报.png")).toBeVisible();
    expect(await screen.findByText("周报")).toBeVisible();
    expect(await screen.findByText("路演")).toBeVisible();
    expect(screen.queryByText("草稿")).not.toBeInTheDocument();
    expect(screen.getAllByText("定稿.png")).toHaveLength(1);
    expect(api.history).toHaveBeenCalledWith(expect.objectContaining({status:"done"}));
    fireEvent.click(screen.getByRole("button",{name:"打开 周报"}));
    expect(onOpenRecord).toHaveBeenCalledWith({kind:"document",id:"doc1",conversation_id:7});
    fireEvent.click(screen.getByRole("button",{name:"打开 路演"}));
    expect(onOpenRecord).toHaveBeenCalledWith({kind:"presentation",id:"job1",conversation_id:9});
    fireEvent.click(screen.getByRole("button",{name:"打开 海报.png"}));
    const dlg=screen.getByRole("dialog",{name:"作品详情"});
    await waitFor(()=>expect(within(dlg).getByText("下载原图")).toBeEnabled());fireEvent.click(within(dlg).getByText("下载原图"));
    expect(api.assetFile).toHaveBeenCalledWith("gen-asset",expect.any(AbortSignal));expect(downloadBlob).toHaveBeenCalledWith(original,"海报.png");
  });

  it("filters finalized document and presentation files and downloads from the works endpoint", async () => {
    const file = new Blob(["archived copy"]);
    const fetchFile = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(file) });
    vi.stubGlobal("fetch", fetchFile);
    const fetchJson = vi.fn().mockImplementation((endpoint: string) => Promise.resolve({ items: endpoint === "/works/final" ? [
      { id: "doc-work", kind: "document", filename: "报告.md", created_at: "2026-11-20", size: 14 },
      { id: "slides-work", kind: "presentation", filename: "路演.pptx", created_at: "2026-11-21", size: 96 },
    ] : [] }));
    render(<WorksPage apiBase="/api" accessToken="session" ready fetchJson={fetchJson as ReturnType<typeof createApiClient>} onOpenImages={vi.fn()}/>);
    expect(await screen.findByText("路演.pptx")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    expect(screen.queryByText("路演.pptx")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 报告.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "作品详情" })).getByRole("button", { name: "下载定稿" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(file, "报告.md"));
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith("/api/works/final/doc-work/file", expect.objectContaining({ headers: { Authorization: "Bearer session" } }));
  });
});
