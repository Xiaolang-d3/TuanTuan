import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bootstrap } from "./Bootstrap";
import { resolveApiBase } from "./runtime";

vi.mock("./runtime", () => ({ resolveApiBase: vi.fn() }));
vi.mock("./App", () => ({ App: ({ user }: { user: { email: string } }) => <div>当前账户：{user.email}</div> }));

function navigate(hash: string) {
  act(() => {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

function configureService() {
  vi.mocked(resolveApiBase).mockResolvedValue({ apiBase: "https://app.example.com" });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/auth/config")) return new Response(JSON.stringify({ enabled: true, setup_required: false, registration_open: true }));
    if (path.endsWith("/auth/login")) return new Response(JSON.stringify({ access_token: "memory-token", user: { id: 1, email: "owner@example.test" } }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("public product entry", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.mocked(resolveApiBase).mockReset();
  });

  it("opens product information directly without authentication requests", async () => {
    const fetchMock = configureService();
    navigate("#/about");
    render(<Bootstrap />);

    await act(async () => {});
    expect(screen.getByRole("heading", { name: /理解你的想法/ })).toHaveFocus();
    expect(screen.getByRole("list", { name: "产品特点" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录 / 注册" })).toHaveAttribute("href", "#/home");
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(document.title).toBe("产品介绍｜团团");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the public page accessible when desktop startup fails", async () => {
    vi.mocked(resolveApiBase).mockRejectedValue(new Error("测试启动失败"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    navigate("#/about/");
    render(<Bootstrap />);

    await act(async () => {});
    expect(screen.getByRole("heading", { name: /理解你的想法/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    navigate("#/home");
    expect(await screen.findByRole("alert")).toHaveTextContent("测试启动失败");
  });

  it("returns to sign-in with the email retained and passwords cleared", async () => {
    configureService();
    render(<Bootstrap />);
    fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret-password" } });
    navigate("#/about");
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    navigate("#/home");
    expect(await screen.findByLabelText("邮箱")).toHaveValue("owner@example.test");
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });

  it("retains an in-memory session and the previous route when visiting product information", async () => {
    const fetchMock = configureService();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    render(<Bootstrap />);
    fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("当前账户：owner@example.test");
    navigate("#/settings");
    navigate("#/about");
    expect(screen.getByRole("link", { name: "返回应用" })).toHaveAttribute("href", "#/settings");
    navigate("#/settings");
    expect(await screen.findByText("当前账户：owner@example.test")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/login"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/auth/me"))).toBe(false);
  });

  it("cancels a pending sign-in before showing product information", async () => {
    configureService();
    let finishLogin!: (response: Response) => void;
    let loginSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/config")) return new Response(JSON.stringify({ enabled: true, setup_required: false }));
      loginSignal = init?.signal;
      return new Promise<Response>((resolve) => { finishLogin = resolve; });
    }));
    render(<Bootstrap />);
    fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    navigate("#/about");
    expect(loginSignal?.aborted).toBe(true);
    await act(async () => finishLogin(new Response(JSON.stringify({ access_token: "late-token", user: { email: "owner@example.test" } }))));
    navigate("#/home");
    expect(await screen.findByLabelText("密码")).toHaveValue("");
    expect(screen.queryByText("当前账户：owner@example.test")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });
});
