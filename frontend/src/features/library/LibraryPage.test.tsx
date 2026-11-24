import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySource, LibrarySourceDetail } from "../../types";
import { LibraryPage } from "./LibraryPage";
import type { DocumentReviewService } from "../chat/document-review-service";
const source: LibrarySource = {
  id: 7,
  source_kind: "paste",
  title: "读书笔记",
  original_filename: "",
  mime_type: "text/plain",
  source_uri: "",
  privacy_mode: "redacted",
  enabled: true,
  parse_status: "ready",
  character_count: 120,
  file_available: false,
  created_at: "2026-09-21T00:00:00Z",
  updated_at: "2026-09-21T00:00:00Z"
};
const detail: LibrarySourceDetail = {
  ...source,
  content: "问题 reader@example.com",
  redacted_content: "问题 [邮箱已隐藏]",
  metadata: {}
};
function props() {
  return {
    editor: { name: "", privacyMode: "redacted" as const },
    sources: [source],
    folders: [{ id: 3, name: "项目资料" }],
    busy: false,
    sourceBusy: false,
    enhancedParse: false,
    onChange: vi.fn(),
    onEnhancedParseChange: vi.fn(),
    onImportFiles: vi.fn(),
    onCreateText: vi.fn().mockResolvedValue(undefined),
    onLoadSource: vi.fn().mockResolvedValue(detail),
    onUpdateSource: vi.fn().mockResolvedValue(undefined),
    onDownloadSource: vi.fn().mockResolvedValue(undefined),
    onDeleteSource: vi.fn().mockResolvedValue(undefined),
    onSave: vi.fn().mockResolvedValue(true),
    onOrganizeSource: vi.fn().mockResolvedValue(undefined),
    onCreateFolder: vi.fn().mockResolvedValue(undefined),
    onCreateCollection: vi.fn().mockResolvedValue(undefined),
    onRenameCollection: vi.fn().mockResolvedValue(undefined),
    onDeleteCollection: vi.fn().mockResolvedValue(undefined),
    onUpdateCollectionSources: vi.fn().mockResolvedValue(undefined),
    onUseForChat: vi.fn().mockResolvedValue(undefined)
  };
}
function renderWithTools(ui: ReactElement) {
  const view = render(ui);
  const more = screen.queryByRole("button", { name: "文件库更多选项" });
  if (more) {
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "搜索与筛选" }));
  }
  return view;
}
async function preview() {
  fireEvent.click(screen.getByRole("button", { name: "预览 读书笔记" }));
  return screen.findByRole("complementary", { name: "文件快速预览" });
}
describe("file library", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("offers explicit full review in file preview without enabling long-term use", async () => {
    const target = { source_kind: "library" as const, source_id: 7, source_revision: "a".repeat(64) };
    const service = { list: vi.fn().mockResolvedValue({ jobs: [] }), create: vi.fn().mockResolvedValue({ id: "review", kind: "document.review", status: "queued", revision: 1, request: { target }, checkpoint: {}, cancel_requested: false }) } as unknown as DocumentReviewService;
    const p = props();
    p.onLoadSource.mockResolvedValue({ ...detail, source_revision: target.source_revision, enabled: false });
    render(<LibraryPage {...p} documentReviewService={service} />);
    await preview();
    fireEvent.click(await screen.findByText("全文审阅"));
    fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
    await waitFor(() => expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ target })));
    expect(p.onUpdateSource).not.toHaveBeenCalled();
    expect(p.onUseForChat).not.toHaveBeenCalled();
  });
  it("accepts dropped files in the empty page without an upload button", async () => {
    const p = props();
    const view = render(<LibraryPage {...p} sources={[]} />);
    expect(screen.queryByRole("button", { name: "上传文件" })).not.toBeInTheDocument();
    expect(screen.getByText("将文件拖入此处，开始整理资料。")).toBeInTheDocument();
    const browser = view.container.querySelector(".fl-browser")!;
    const file = new File(["example"], "笔记.txt", { type: "text/plain" });
    fireEvent.dragOver(browser, { dataTransfer: { files: [file] } });
    expect(screen.getByText("松开即可添加文件")).toBeInTheDocument();
    fireEvent.drop(browser, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(p.onImportFiles).toHaveBeenCalledWith([file], null, null));
    expect(screen.queryByText("松开即可添加文件")).not.toBeInTheDocument();
  });
  it("uses just four header tabs and hides the search/filter toolbar by default", () => {
    render(<LibraryPage {...props()} />);
    const tabs = screen.getByRole("navigation", { name: "文件类型" });
    expect(within(tabs).getAllByRole("button").map((button) => button.textContent)).toEqual(["全部", "图像", "文档", "视频"]);
    expect(tabs.closest("header")).toHaveClass("fl-header");
    expect(screen.queryByRole("button", { name: "文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "知识" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索文件名或内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "筛选" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("筛选目录")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("选择主题集合")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "文件视图" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加" })).toBeInTheDocument();
  });
  it("shows only pictures in the gallery and keeps document controls in the list", async () => {
    const image = { ...source, id: 8, title: "海边照片", mime_type: "image/png" };
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[source, image]} />);
    const gallery = screen.getByRole("group", { name: "图片列表" });
    expect(gallery).toHaveClass("fl-image-gallery");
    expect(within(gallery).getByRole("button", { name: "预览 海边照片" })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "文件列表" })).getByRole("button", { name: "预览 读书笔记" })).toBeInTheDocument();
    expect(within(gallery).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(gallery).queryByRole("button", { name: "操作 海边照片" })).not.toBeInTheDocument();
    expect(within(gallery).queryByText("海边照片")).not.toBeInTheDocument();
    expect(gallery.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("选择当前全部文件"));
    expect(screen.getByText("已选 1 个文件")).toBeInTheDocument();
    expect(screen.getByLabelText("选择 读书笔记")).toBeChecked();
    expect(screen.queryByLabelText("选择 海边照片")).not.toBeInTheDocument();
    expect(p.onLoadSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(gallery).toHaveClass("fl-image-gallery");
    expect(screen.getByRole("table", { name: "文件列表" })).not.toHaveClass("fl-grid");
    fireEvent.click(within(gallery).getByRole("button", { name: "预览 海边照片" }));
    await waitFor(() => expect(p.onLoadSource).toHaveBeenCalledWith(8));
  });
  it("reveals secondary controls only when requested and keeps active filters visible", () => {
    renderWithTools(<LibraryPage {...props()} />);
    expect(screen.queryByRole("button", { name: "上传文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "文件库设置" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("筛选来源")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByRole("button", { name: "上传文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建笔记" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "添加" }), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "上传文件" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.change(screen.getByLabelText("筛选来源"), { target: { value: "chat" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.queryByLabelText("筛选来源")).not.toBeInTheDocument();
    expect(screen.getByText("对话成果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选" })).toHaveClass("is-filtered");
    expect(screen.getByLabelText("1 个筛选条件")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: "筛选" })).not.toHaveClass("is-filtered");
    expect(screen.queryByLabelText("1 个筛选条件")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "AI 使用" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "文件列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "列表视图" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
    expect(screen.getByRole("table")).toHaveClass("fl-grid");
    expect(screen.getByRole("button", { name: "网格视图" })).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps directory and collection selection visible until filters are cleared", () => {
    renderWithTools(<LibraryPage {...props()}
      collections={[{ id: 10, name: "阅读", source_ids: [7], file_count: 1 }]} />);
    const directory = screen.getByLabelText("筛选目录");
    const collection = screen.getByLabelText("选择主题集合");
    expect(directory.closest("label")).not.toHaveClass("is-active");
    fireEvent.change(directory, { target: { value: "unfiled" } });
    expect(directory.closest("label")).toHaveClass("is-active");
    expect(screen.getByRole("button", { name: "预览 读书笔记" })).toBeInTheDocument();
    fireEvent.change(directory, { target: { value: "3" } });
    expect(directory.closest("label")).toHaveClass("is-active");
    expect(screen.queryByRole("button", { name: "预览 读书笔记" })).not.toBeInTheDocument();
    fireEvent.change(collection, { target: { value: "10" } });
    expect(collection.closest("label")).toHaveClass("is-active");
    expect(directory).toHaveValue("3");
    expect(screen.getByText("没有找到匹配的文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(directory).toHaveValue("all");
    expect(collection).toHaveValue("all");
    expect(directory.closest("label")).not.toHaveClass("is-active");
    expect(collection.closest("label")).not.toHaveClass("is-active");
  });
  it("shows the selected time order and sorts files accordingly", () => {
    renderWithTools(<LibraryPage {...props()} sources={[source,
      { ...source, id: 8, title: "最新笔记", updated_at: "2026-10-19T00:00:00Z" }]} />);
    const titles = () => within(screen.getByRole("table", { name: "文件列表" }))
      .getAllByRole("button", { name: /^预览 / }).map((button) => button.getAttribute("aria-label"));
    const sort = screen.getByRole("button", { name: "按时间从旧到新" });
    expect(sort).toHaveTextContent("最新优先");
    expect(sort).toHaveAttribute("aria-pressed", "false");
    expect(titles()).toEqual(["预览 最新笔记", "预览 读书笔记"]);
    fireEvent.click(sort);
    expect(sort).toHaveTextContent("最早优先");
    expect(sort).toHaveAttribute("aria-pressed", "true");
    expect(titles()).toEqual(["预览 读书笔记", "预览 最新笔记"]);
    fireEvent.click(sort);
    expect(sort).toHaveTextContent("最新优先");
    expect(titles()).toEqual(["预览 最新笔记", "预览 读书笔记"]);
  });
  it("previews filenames without selecting and opens the reader without loading the file twice", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    const row = screen.getByRole("button", { name: "预览 读书笔记" }).closest("tr")!;
    const pane = await preview();
    expect(within(pane).getByRole("heading", { name: "读书笔记" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 读书笔记" })).not.toBeChecked();
    expect(screen.queryByRole("toolbar", { name: "批量文件操作" })).not.toBeInTheDocument();
    expect(row).toHaveClass("is-previewing");
    fireEvent.doubleClick(row);
    expect(screen.getByRole("region", { name: "文件阅读器" })).toBeInTheDocument();
    expect(p.onLoadSource).toHaveBeenCalledOnce();
  });
  it("keeps checkbox and file actions separate from reading and exposes batch actions directly", () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    const checkbox = screen.getByRole("checkbox", { name: "选择 读书笔记" });
    fireEvent.click(checkbox);
    fireEvent.doubleClick(checkbox);
    const toolbar = screen.getByRole("toolbar", { name: "批量文件操作" });
    expect(within(toolbar).getByRole("button", { name: "加入主题集合" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "移动" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "操作 读书笔记" }));
    expect(screen.getByRole("button", { name: "快速预览" })).toBeInTheDocument();
    expect(p.onLoadSource).not.toHaveBeenCalled();
  });
  it("supports keyboard preview and full reading without changing file selections", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    const row = screen.getByRole("button", { name: "预览 读书笔记" }).closest("tr")!;
    fireEvent.keyDown(row, { key: " ", code: "Space" });
    await screen.findByRole("complementary", { name: "文件快速预览" });
    expect(screen.getByRole("checkbox", { name: "选择 读书笔记" })).not.toBeChecked();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByRole("region", { name: "文件阅读器" })).toBeInTheDocument();
    expect(p.onLoadSource).toHaveBeenCalledOnce();
  });
  it("closes the filter popover with Escape without closing the reading panel", async () => {
    renderWithTools(<LibraryPage {...props()} />);
    await preview();
    const trigger = screen.getByRole("button", { name: "筛选" });
    fireEvent.click(trigger);
    const origin = screen.getByLabelText("筛选来源");
    fireEvent.keyDown(origin, { key: "Escape" });
    expect(screen.queryByLabelText("筛选来源")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("complementary", { name: "文件快速预览" })).toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("heading", { name: "文件库" }));
    expect(screen.queryByLabelText("筛选来源")).not.toBeInTheDocument();
  });
  it("opens a saved result directly and consumes the initial source once", async () => {
    const p = props(), consumed = vi.fn();
    const view = renderWithTools(<LibraryPage {...p} initialSourceId={7} onInitialSourceConsumed={consumed} />);
    await screen.findByText("问题 reader@example.com");
    expect(screen.getByRole("button", { name: "返回文件库" })).toBeInTheDocument();
    expect(p.onLoadSource).toHaveBeenCalledWith(7);
    expect(consumed).toHaveBeenCalledOnce();
    view.rerender(<LibraryPage {...p} initialSourceId={null} onInitialSourceConsumed={consumed} />);
    expect(p.onLoadSource).toHaveBeenCalledOnce();
  });
  it("keeps categories in the module and protects AI text", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    expect(screen.getByRole("navigation", { name: "文件类型" })).toHaveTextContent(/全部.*图像.*文档.*视频/);
    const pane = await preview();
    await waitFor(() => expect(p.onOrganizeSource).toHaveBeenCalledWith(7, { opened: true }));
    fireEvent.click(within(pane).getByRole("button", { name: "AI 读取内容" }));
    expect(pane).toHaveTextContent("[邮箱已隐藏]");
    expect(pane).not.toHaveTextContent("reader@example.com");
    fireEvent.click(screen.getByRole("button", { name: "编辑正文" }));
    fireEvent.change(screen.getByLabelText("编辑资料正文"), { target: { value: "校正内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存正文" }));
    await waitFor(() => expect(p.onUpdateSource).toHaveBeenCalledWith(7, { content: "校正内容" }));
  });
  it("filters files by type", () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[source, { ...source, id: 8, title: "照片", mime_type: "image/png" }, { ...source, id: 9, title: "影片", mime_type: "video/mp4" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "图像" }));
    expect(screen.getByRole("button", { name: "预览 照片" })).toBeInTheDocument();
    expect(screen.queryByText("影片")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    expect(screen.getByText("影片")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览 照片" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    expect(screen.getByText("读书笔记")).toBeInTheDocument();
    expect(screen.queryByText("影片")).not.toBeInTheDocument();
  });
  it("hides text-use controls in media libraries without applying a hidden filter", () => {
    const image = { ...source, id: 8, title: "照片", mime_type: "image/png", enabled: false };
    renderWithTools(<LibraryPage {...props()} sources={[source, image]} />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.change(screen.getByLabelText("筛选 AI 使用"), { target: { value: "ready" } });
    fireEvent.click(screen.getByRole("button", { name: "图像" }));
    expect(screen.queryByRole("columnheader", { name: "AI 使用" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("筛选 AI 使用")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览 照片" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    expect(screen.getByRole("columnheader", { name: "AI 使用" })).toBeInTheDocument();
    expect(screen.getByLabelText("筛选 AI 使用")).toHaveValue("ready");
  });
  it("preserves search and directory when changing file type and clears empty results", () => {
    renderWithTools(<LibraryPage {...props()} />);
    fireEvent.change(screen.getByLabelText("筛选目录"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("搜索文件名或内容"), { target: { value: "笔记" } });
    fireEvent.click(screen.getByRole("button", { name: "图像" }));
    expect(screen.getByLabelText("筛选目录")).toHaveValue("3");
    expect(screen.getByLabelText("搜索文件名或内容")).toHaveValue("笔记");
    fireEvent.click(screen.getByRole("button", { name: "清除搜索和筛选" }));
    expect(screen.getByLabelText("筛选目录")).toHaveValue("all");
    expect(screen.getByLabelText("搜索文件名或内容")).toHaveValue("");
    expect(screen.getByRole("button", { name: "图像" })).toHaveAttribute("aria-current", "page");
  });
  it("opens images in a large viewer instead of the document side panel", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:library-cat"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const image = { ...source, title: "小猫", original_filename: "小猫.png", mime_type: "image/png", file_available: true };
    const p = props();
    p.onLoadSource.mockResolvedValue({ ...detail, ...image });
    const loadOriginal = vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    render(<LibraryPage {...p} sources={[image]} onLoadOriginal={loadOriginal} />);
    fireEvent.click(screen.getByRole("button", { name: "预览 小猫" }));
    expect(screen.queryByRole("complementary", { name: "文件快速预览" })).not.toBeInTheDocument();
    const viewer = await screen.findByRole("dialog", { name: "小猫.png 预览" });
    expect(await within(viewer).findByRole("img")).toHaveAttribute("src", "blob:library-cat");
    expect(within(viewer).queryByRole("checkbox", { name: "长期使用" })).not.toBeInTheDocument();
    expect(within(viewer).queryByText("图片文字与说明")).not.toBeInTheDocument();
    expect(within(viewer).getByRole("button", { name: "放大图片" })).toBeInTheDocument();
    expect(loadOriginal).toHaveBeenCalledWith(expect.objectContaining({ id: image.id }), expect.any(AbortSignal));
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole("button", { name: "预览 小猫" }));
    await screen.findByRole("dialog", { name: "小猫.png 预览" });
    expect(screen.queryByRole("region", { name: "文件阅读器" })).not.toBeInTheDocument();
  });
  it("creates redacted notes in the current folder", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    fireEvent.change(screen.getByLabelText("筛选目录"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "新建笔记" }));
    fireEvent.change(screen.getByLabelText("文件名称"), { target: { value: "会议纪要" } });
    fireEvent.change(screen.getByLabelText("笔记内容"), { target: { value: "检索评测" } });
    fireEvent.click(screen.getByRole("button", { name: "创建笔记" }));
    await waitFor(() => expect(p.onCreateText).toHaveBeenCalledWith("会议纪要", "检索评测", "redacted", 3, null));
  });
  it("trashes reversibly and leaves the permanent deletion confirmation open until success", async () => {
    const p = props();
    let failDeletion!: (error: Error) => void;
    p.onDeleteSource.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { failDeletion = reject; }));
    const view = renderWithTools(<LibraryPage {...p} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(p.onDeleteSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(p.onOrganizeSource).toHaveBeenCalledWith(7, { trashed: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    view.rerender(<LibraryPage {...p} sources={[{ ...source, trashed_at: "2026-10-06T08:00:00Z" }]} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("文件范围"), { target: { value: "trash" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复 读书笔记" }));
    await waitFor(() => expect(p.onOrganizeSource).toHaveBeenCalledWith(7, { trashed: false }));
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复 读书笔记" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(p.onDeleteSource).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", { name: "永久删除" });
    expect(confirmation).toHaveAccessibleDescription("永久删除 1 个文件及原件？此操作无法恢复。");
    const close = within(confirmation).getByRole("button", { name: "关闭弹窗" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(within(confirmation).getByRole("button", { name: "永久删除" }));
    expect(p.onDeleteSource).toHaveBeenCalledExactlyOnceWith(7);
    expect(close).toBeDisabled();
    expect(within(confirmation).getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(confirmation).toBeInTheDocument();

    failDeletion(new Error("永久删除失败"));
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent("永久删除失败");
    expect(close).toBeEnabled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(p.onDeleteSource.mock.calls).toEqual([[7], [7]]);
  });
  it("moves selected files and uses selected IDs for chat", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[source, { ...source, id: 8, title: "会议笔记" }]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前全部文件" }));
    fireEvent.click(screen.getByRole("button", { name: "用于对话" }));
    expect(p.onUseForChat).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "用于新对话" })).toHaveTextContent("不会开启长期使用");
    fireEvent.click(screen.getByRole("button", { name: "创建对话" }));
    await waitFor(() => expect(p.onUseForChat).toHaveBeenCalledWith([8, 7]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前全部文件" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "移动" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "移动" }));
    fireEvent.change(screen.getByLabelText("目标文件夹"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "移动文件" }));
    await waitFor(() => expect(p.onOrganizeSource).toHaveBeenCalledWith(7, { folder_id: 3 }));
    expect(p.onOrganizeSource).toHaveBeenCalledWith(8, { folder_id: 3 });
  });
  it("ignores stale search results", async () => {
    let complete!: (value: LibrarySource[]) => void;
    const search = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      )
      .mockResolvedValue([]);
    renderWithTools(<LibraryPage {...props()} onSearchSources={search} />);
    fireEvent.change(screen.getByLabelText("搜索文件名或内容"), { target: { value: "正文" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("正文"));
    fireEvent.change(screen.getByLabelText("搜索文件名或内容"), { target: { value: "不存在" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("不存在"));
    complete([source]);
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
  });
  it("retains pending knowledge and failure feedback", async () => {
    renderWithTools(
      <LibraryPage
        {...props()}
        pendingFacts={[{ id: 21, statement: "主导过检索评测", category: "project" }]}
        onReviewFact={vi.fn().mockRejectedValue(new Error("offline"))}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "文件库更多选项" }));
    fireEvent.click(screen.getByRole("button", { name: "知识" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByLabelText("待确认内容")).toHaveTextContent("主导过检索评测");
    expect(screen.queryByLabelText("称呼")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文件库更多选项" }));
    fireEvent.click(screen.getByRole("button", { name: "文件库设置" }));
    expect(screen.getByLabelText("称呼")).not.toBeRequired();
  });
  it("does not reopen cancelled previews", async () => {
    let complete!: (value: LibrarySourceDetail) => void;
    renderWithTools(
      <LibraryPage
        {...props()}
        onLoadSource={() =>
          new Promise((resolve) => {
            complete = resolve;
          })
        }
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "操作 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "快速预览" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    complete(detail);
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  });
  it("combines directory, origin, knowledge status and content search", async () => {
    const p = props();
    const files: LibrarySource[] = [
      { ...source, folder_id: 3 },
      { ...source, id: 8, title: "对话纪要", folder_id: 3, source_kind: "upload", source_uri: "chat:1:2", enabled: false },
      { ...source, id: 9, title: "其他目录", folder_id: null, source_kind: "upload", source_uri: "chat:1:3", enabled: false }
    ];
    const search = vi.fn().mockResolvedValue(files);
    renderWithTools(<LibraryPage {...p} sources={files} onSearchSources={search} />);
    fireEvent.change(screen.getByLabelText("筛选目录"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.change(screen.getByLabelText("筛选来源"), { target: { value: "chat" } });
    fireEvent.change(screen.getByLabelText("筛选 AI 使用"), { target: { value: "archive" } });
    fireEvent.change(screen.getByLabelText("搜索文件名或内容"), { target: { value: "正文关键词" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("正文关键词"));
    expect(await screen.findByText("对话纪要")).toBeInTheDocument();
    expect(screen.queryByText("读书笔记")).not.toBeInTheDocument();
    expect(screen.queryByText("其他目录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("读书笔记")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索文件名或内容")).toHaveValue("正文关键词");
  });
  it("clears selections when a filter hides their files", () => {
    renderWithTools(<LibraryPage {...props()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.change(screen.getByLabelText("筛选来源"), { target: { value: "chat" } });
    expect(screen.queryByText("已选 1 个文件")).not.toBeInTheDocument();
    expect(screen.getByText("没有找到匹配的文件")).toBeInTheDocument();
  });
  it("keeps files without text archived and blocks text-dependent batch actions", () => {
    renderWithTools(<LibraryPage {...props()} sources={[{ ...source, character_count: 0, text_parse_status: "not_required", enabled: false }]} />);
    expect(within(screen.getByRole("table", { name: "文件列表" })).getByText("无可检索正文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    expect(screen.getByRole("button", { name: "用于对话" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    expect(screen.getByRole("button", { name: "开启长期使用" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("补充文字或说明");
    expect(screen.getByRole("button", { name: "下载" })).not.toBeDisabled();
  });
  it("enables selected readable archives as knowledge sources explicitly", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[{ ...source, enabled: false }]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    fireEvent.click(screen.getByRole("button", { name: "开启长期使用" }));
    await waitFor(() => expect(p.onUpdateSource).toHaveBeenCalledWith(7, { enabled: true }));
  });
  it("separates confirmed knowledge from pending proposals and links to usable files", async () => {
    const p = props();
    const confirmed = [{ id: 30, category: "knowledge", statement: "已确认的阅读偏好", status: "confirmed" as const }];
    renderWithTools(<LibraryPage {...p} confirmedFacts={confirmed} pendingFacts={[{ id: 21, statement: "待确认偏好" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "文件库更多选项" }));
    fireEvent.click(screen.getByRole("button", { name: "知识" }));
    expect(screen.getByLabelText("已确认知识")).toHaveTextContent("已确认的阅读偏好");
    expect(screen.getByLabelText("待确认内容")).toHaveTextContent("待确认偏好");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看长期资料" }));
    expect(screen.getByText("长期使用", { selector: ".fl-filter-summary span" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByLabelText("筛选 AI 使用")).toHaveValue("ready");
    expect(screen.getByText("读书笔记")).toBeInTheDocument();
  });

  it("filters shared files by topic and removes membership without deleting or disabling", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[source, { ...source, id: 8, title: "集合外文件" }]}
      collections={[{ id: 10, name: "阅读", source_ids: [7], file_count: 1 }, { id: 11, name: "研究", source_ids: [7], file_count: 1 }]} />);
    fireEvent.change(screen.getByLabelText("选择主题集合"), { target: { value: "10" } });
    expect(screen.queryByText("集合外文件")).not.toBeInTheDocument();
    expect(screen.getByText("读书笔记")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "更多文件操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移出当前集合" }));
    await waitFor(() => expect(p.onUpdateCollectionSources).toHaveBeenCalledWith(10, [7], "remove"));
    expect(p.onDeleteSource).not.toHaveBeenCalled();
    expect(p.onUpdateSource).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("选择主题集合"), { target: { value: "11" } });
    expect(screen.getByText("读书笔记")).toBeInTheDocument();
    expect(screen.queryByText("已选 1 个文件")).not.toBeInTheDocument();
  });

  it("creates collections and joins selected archives without enabling AI use", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} sources={[{ ...source, enabled: false }]}
      collections={[{ id: 10, name: "阅读", source_ids: [], file_count: 0 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "新建主题集合" }));
    fireEvent.change(screen.getByLabelText("主题集合名称"), { target: { value: "研究资料" } });
    fireEvent.click(screen.getByRole("button", { name: "新建主题集合" }));
    await waitFor(() => expect(p.onCreateCollection).toHaveBeenCalledWith("研究资料"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "加入主题集合" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "加入主题集合" }));
    await waitFor(() => expect(p.onUpdateCollectionSources).toHaveBeenCalledWith(10, [7], "add"));
    expect(p.onUpdateSource).not.toHaveBeenCalled();
  });

  it("retains selections and error feedback when collection membership fails", async () => {
    const p = props();
    p.onUpdateCollectionSources.mockRejectedValue(new Error("集合保存失败"));
    renderWithTools(<LibraryPage {...p} collections={[{ id: 10, name: "阅读", source_ids: [], file_count: 0 }]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "加入主题集合" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "加入主题集合" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("集合保存失败");
    const dialog = screen.getByRole("dialog", { name: "加入主题集合" });
    expect(screen.queryByRole("checkbox", { name: "选择 读书笔记" })).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 读书笔记" })).toBeChecked();
  });

  it("creates a first collection with selected files in one step", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 读书笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "加入主题集合" }));
    expect(screen.getByLabelText("目标主题集合")).toHaveValue("new");
    fireEvent.change(screen.getByLabelText("主题集合名称"), { target: { value: "我的阅读" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "加入主题集合" }));
    await waitFor(() => expect(p.onCreateCollection).toHaveBeenCalledWith("我的阅读", [7]));
    expect(p.onUpdateSource).not.toHaveBeenCalled();
    expect(p.onUpdateCollectionSources).not.toHaveBeenCalled();
  });

  it("deletes only the selected collection after explaining that files remain", async () => {
    const p = props();
    renderWithTools(<LibraryPage {...p} collections={[{ id: 10, name: "阅读", source_ids: [7], file_count: 1 }]} />);
    fireEvent.change(screen.getByLabelText("选择主题集合"), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText("主题集合操作"));
    fireEvent.click(screen.getByRole("button", { name: "删除集合" }));
    const confirmation = screen.getByRole("alertdialog", { name: "删除主题集合" });
    expect(confirmation).toHaveAccessibleDescription("删除“阅读”集合？其中的文件和长期使用设置都会保留。");
    expect(p.onDeleteCollection).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "删除主题集合" }));
    await waitFor(() => expect(p.onDeleteCollection).toHaveBeenCalledWith(10));
    expect(p.onDeleteSource).not.toHaveBeenCalled();
    expect(p.onUpdateSource).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("选择主题集合")).toHaveValue("all"));
  });

  it("blocks chat batches beyond the send limit and exposes long-term use in preview", async () => {
    const p = props();
    const view = renderWithTools(<LibraryPage {...p} sources={Array.from({ length: 9 }, (_, i) => ({ ...source, id: i + 7, title: `资料${i}` }))} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前全部文件" }));
    expect(screen.getByRole("button", { name: "用于对话" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("最多带入 8 个文件");
    view.rerender(<LibraryPage {...p} sources={[source]} />);
    const pane = await preview();
    fireEvent.click(within(pane).getByRole("checkbox", { name: "长期使用" }));
    await waitFor(() => expect(p.onUpdateSource).toHaveBeenCalledWith(7, { enabled: false }));
  });

});
