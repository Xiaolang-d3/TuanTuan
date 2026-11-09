import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), render: vi.fn(), cancel: vi.fn(), destroy: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {}, getDocument: mocks.getDocument }));
import PdfReader from "./PdfReader";

describe("PDF original reader", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it("starts at the cited page and bounds an out-of-range target", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const page = { getViewport: () => ({ width: 595, height: 842 }), render: mocks.render };
    mocks.render.mockReturnValue({ promise: Promise.resolve(), cancel: mocks.cancel });
    const pdf = { numPages: 3, getPage: vi.fn().mockResolvedValue(page) };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: mocks.destroy });
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const view = render(<PdfReader bytes={bytes} title="来源" initialPage={3} />);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(3));
    view.rerender(<PdfReader bytes={bytes} title="来源" initialPage={99} />);
    expect(screen.getByText("3 / 3")).toBeVisible();
    view.rerender(<PdfReader bytes={bytes} title="来源" initialPage={2} />);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2));
  });
  it("renders the original, bounds pages and cancels superseded renders", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
      render: mocks.render
    };
    mocks.render.mockReturnValue({ promise: Promise.resolve(), cancel: mocks.cancel });
    const pdf = { numPages: 2, getPage: vi.fn().mockResolvedValue(page) };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: mocks.destroy });
    const view = render(<PdfReader bytes={new Uint8Array([37, 80, 68, 70])} title="资料" />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    expect(mocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ data: new Uint8Array([37, 80, 68, 70]), useWorkerFetch: false })
    );
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2));
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "放大 PDF" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "适应宽度" })).toHaveTextContent("125%"));
    expect(mocks.cancel).toHaveBeenCalled();
    view.unmount();
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it("shows a recoverable message for malformed originals", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    mocks.getDocument.mockReturnValue({ promise: Promise.reject(new Error("broken PDF")), destroy: mocks.destroy });
    render(<PdfReader bytes={new Uint8Array([0])} title="损坏文件" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("请下载原文件检查");
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });
});
