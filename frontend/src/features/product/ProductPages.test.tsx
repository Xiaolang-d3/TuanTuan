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

  it("only lists archived works and opens/downloads the independent file", async () => {
    vi.stubGlobal("URL",Object.assign(class extends URL{},{createObjectURL:vi.fn().mockReturnValue("blob:work"),revokeObjectURL:vi.fn()}));
    const file=new Blob(["independent bytes"]);const api={works:vi.fn().mockResolvedValue({items:[{id:"work1",created_at:"2026-11-19",asset:{id:"source",original_filename:"定稿.png"}}]}),workFile:vi.fn().mockResolvedValue(file),workThumbnail:vi.fn().mockResolvedValue(new Blob())};
    vi.spyOn(imageApi,"createImageStudioApi").mockReturnValue(api as unknown as imageApi.ImageStudioApi);
    render(<WorksPage apiBase="/api" accessToken="" ready fetchJson={vi.fn() as ReturnType<typeof createApiClient>} onOpenImages={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button",{name:"查看作品"}));const dlg=screen.getByRole("dialog",{name:"作品详情"});
    await waitFor(()=>expect(within(dlg).getByText("下载原图")).toBeEnabled());fireEvent.click(within(dlg).getByText("下载原图"));expect(api.workFile).toHaveBeenCalledWith("work1",expect.any(AbortSignal));expect(downloadBlob).toHaveBeenCalledWith(file,"定稿.png");
  });
});
