import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePage, VideoPage, WorksPage } from "./ProductPages";

afterEach(cleanup);

function callbacks() {
  return { onOpenChat: vi.fn(), onOpenLibrary: vi.fn(), onOpenSettings: vi.fn() };
}

describe("product pages", () => {
  it("describes available image features and opens chat or settings", () => {
    const props = callbacks();
    render(<ImagePage {...props} />);
    expect(screen.getByRole("heading", { name: "图片" })).toBeInTheDocument();
    expect(screen.getByText("可以在对话中生成图片，也可以编辑对话中生成的图片。")).toBeInTheDocument();
    expect(screen.getByText("上传任意图片后直接编辑尚未支持。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入对话" }));
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(props.onOpenChat).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onOpenLibrary).not.toHaveBeenCalled();
  });

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

  it("explains works management is unavailable and opens existing destinations", () => {
    const props = callbacks();
    render(<WorksPage {...props} />);
    expect(screen.getByRole("region", { name: "我的作品" }).querySelector(".product-page-icon .lucide-gallery-thumbnails")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开文件库" }).querySelector(".lucide-library")).toBeInTheDocument();
    expect(screen.getByText("集中作品管理尚未接入。")).toBeInTheDocument();
    expect(screen.getByText("可以前往文件库查看已保存的文件，或返回对话继续工作。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开文件库" }));
    fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
    expect(props.onOpenLibrary).toHaveBeenCalledTimes(1);
    expect(props.onOpenChat).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).not.toHaveBeenCalled();
  });
});
