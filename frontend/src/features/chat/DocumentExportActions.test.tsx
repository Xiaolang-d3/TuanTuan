import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { DocumentExportActions } from "./DocumentExportActions";
import type { DocumentExportService } from "./document-export-service";

function service(): DocumentExportService {
  return { capabilities: vi.fn().mockResolvedValue({ formats: { docx: { available: true, reason: "" }, pdf: { available: true, reason: "" } } }),
    list: vi.fn().mockResolvedValue({ exports: [] }), start: vi.fn().mockResolvedValue({ format: "pdf", job: { id: "job1", status: "queued" }, artifact: null }),
    cancel: vi.fn().mockResolvedValue({}), resume: vi.fn().mockResolvedValue({}), file: vi.fn().mockResolvedValue(new Blob()) };
}
describe("saved version exports", () => {
  afterEach(cleanup);
  it("reads status without starting work, then explicitly exports the selected version", async () => {
    const api = service();
    render(<DocumentExportActions service={api} documentId="saved-doc" version={3} disabled={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "导出 PDF v3" })).toBeEnabled());
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导出 PDF v3" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("saved-doc", 3, "pdf", expect.any(AbortSignal)));
    expect(await screen.findByRole("button", { name: "取消 PDF 导出" })).toBeInTheDocument();
  });
  it("disables export for unsaved text and unavailable deployment formats", async () => {
    const api = service();
    render(<DocumentExportActions service={api} documentId="doc" version={1} disabled />);
    expect(await screen.findByRole("button", { name: "导出 DOCX v1" })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("cancels a queued job without creating another export", async () => {
    const api = service();
    vi.mocked(api.list).mockResolvedValue({ exports: [{ format: "pdf", job: { id: "queued", status: "queued" }, artifact: null }] });
    render(<DocumentExportActions service={api} documentId="doc" version={1} disabled={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消 PDF 导出" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("queued", expect.any(AbortSignal)));
    expect(api.start).not.toHaveBeenCalled();
  });
  it("shows unavailable format reasons without starting work", async () => {
    const api = service();
    vi.mocked(api.capabilities).mockResolvedValue({ formats: { docx: { available: true, reason: "" }, pdf: { available: false, reason: "当前部署不支持 PDF" } } });
    render(<DocumentExportActions service={api} documentId="doc" version={1} disabled={false} />);
    expect(await screen.findByText("当前部署不支持 PDF")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 PDF v1" })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });
});
