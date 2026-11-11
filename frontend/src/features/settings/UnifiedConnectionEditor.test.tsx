import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConnection } from "../../types";
import { UnifiedConnectionEditor } from "./UnifiedConnectionEditor";

const connection: ModelConnection = {
  id: "one", name: "服务甲", model_base_url: "https://one.test/v1", model_protocol: "auto",
  api_key_configured: true, enabled: true, revision: 2
};
function props() {
  return { busy: false, onCancel: vi.fn(), onSave: vi.fn().mockResolvedValue(true) };
}
function fill(baseUrl: string, apiKey: string) {
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: baseUrl } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: apiKey } });
}
function submit(name = "保存并获取模型") { fireEvent.click(screen.getByRole("button", { name })); }
function expectFieldError(label: string) {
  const input = screen.getByLabelText(label);
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", screen.getByRole("alert").id);
}
afterEach(cleanup);

describe("UnifiedConnectionEditor", () => {
  it.each([
    "bad-address", "ftp://api.test/v1", "https://user:password@api.test/v1",
    "https://api.test/v1?key=value", "https://api.test/v1#fragment", ""
  ])("retains the key for invalid address %s and allows correction without re-entry", async baseUrl => {
    const p = props(); render(<UnifiedConnectionEditor {...p} />);
    fill(baseUrl, "private-test-key");
    screen.getByRole("button", { name: "保存并获取模型" }).focus();
    submit();
    expect(p.onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API Key")).toHaveValue("private-test-key");
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expectFieldError("Base URL");
    expect(screen.getByRole("alert")).toHaveTextContent("完整的 http:// 或 https:// 地址");

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: " https://fixed.test/v1/ " } });
    expect(screen.getByLabelText("Base URL")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Base URL")).toHaveAccessibleDescription("填写完整 API 地址，保留服务商要求的 /v1 等路径。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    submit();
    expect(p.onSave).toHaveBeenCalledExactlyOnceWith({
      name: "fixed.test", model_base_url: "https://fixed.test/v1", model_protocol: "auto", api_key: "private-test-key"
    });
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存并获取模型" })).toBeEnabled());
  });

  it("requires a fresh key for a changed address and focuses its error", async () => {
    const p = props(); render(<UnifiedConnectionEditor {...p} connection={connection} currentConnection={connection} />);
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://changed.test/v1" } });
    submit("保存服务");
    expect(p.onSave).not.toHaveBeenCalled();
    expectFieldError("API Key");
    expect(screen.getByRole("alert")).toHaveTextContent("新增服务或修改地址后，请重新填写 API Key。");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: " fresh-key " } });
    submit("保存服务");
    expect(p.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model_base_url: "https://changed.test/v1", expected_revision: 2, api_key: "fresh-key"
    }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存服务" })).toBeEnabled());
  });

  it("retains an entered key when secure storage becomes unwritable", async () => {
    const p = props(); const view = render(<UnifiedConnectionEditor {...p} secretWritable />);
    fill("https://api.test/v1", "keep-until-writable");
    view.rerender(<UnifiedConnectionEditor {...p} secretWritable={false} />);
    submit();
    expect(p.onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API Key")).toHaveValue("keep-until-writable");
    expect(screen.getByLabelText("API Key")).toHaveAttribute("readonly");
    expectFieldError("API Key");
    expect(screen.getByRole("alert")).toHaveTextContent("当前密钥存储不可写");
    view.rerender(<UnifiedConnectionEditor {...p} secretWritable />);
    submit();
    expect(p.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ api_key: "keep-until-writable" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存并获取模型" })).toBeEnabled());
  });

  it.each(["unconfirmed", "rejected"] as const)("clears the key before an actual submission with %s outcome", async outcome => {
    let resolve!: (value: boolean) => void;
    let reject!: (reason: Error) => void;
    const onSave = vi.fn(() => new Promise<boolean>((done, fail) => { resolve = done; reject = fail; }));
    render(<UnifiedConnectionEditor {...props()} onSave={onSave} />);
    fill("https://api.test/v1", "one-attempt-key");
    submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ api_key: "one-attempt-key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    if (outcome === "unconfirmed") resolve(false); else reject(new Error("connection lost"));
    expect(await screen.findByRole("alert")).toHaveTextContent("API Key 已清除");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expectFieldError("API Key");
  });

  it("reuses a saved key at an unchanged normalized address", async () => {
    const p = props(); render(<UnifiedConnectionEditor {...p} connection={connection} currentConnection={connection} />);
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://one.test/v1/" } });
    submit("保存服务");
    expect(p.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ api_key: "", expected_revision: 2 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存服务" })).toBeEnabled());
  });

  it("keeps the dirty cancellation confirmation and drops the key when unmounted", () => {
    const p = props(); const view = render(<UnifiedConnectionEditor {...p} />);
    fill("bad-address", "unsaved-key");
    submit();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(p.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("unsaved-key");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(p.onCancel).toHaveBeenCalledOnce();
    view.unmount();
    render(<UnifiedConnectionEditor {...p} />);
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(p.onSave).not.toHaveBeenCalled();
  });
});
