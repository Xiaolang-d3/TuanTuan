import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate";

function authConfig(setupRequired = false) {
  return new Response(JSON.stringify({ enabled: true, setup_required: setupRequired, registration_open: true }), { status: 200 });
}

describe("AuthGate", () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("validates an existing session without requesting sign-in configuration", async () => {
    window.sessionStorage.setItem("tuantuan-auth-token", "saved-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/me")) {
        return new Response(JSON.stringify({ user: { email: "owner@example.com" } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => <div>应用已就绪</div>}</AuthGate>);

    await screen.findByText("应用已就绪");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
    expect(window.sessionStorage.getItem("tuantuan-auth-token")).toBe("saved-token");
  });

  it("keeps a saved session when the backend is briefly unavailable", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    render(<AuthGate apiBase="https://app.example.com">{() => <div>应用已就绪</div>}</AuthGate>);

    expect(await screen.findByText("登录服务暂时不可用，请重新连接。正在自动重试…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新连接" })).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBe("saved-token");
  });

  it("only signs out when the saved token is rejected", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "expired-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ detail: "登录状态已失效，请重新登录" }), { status: 401 });
      }
      if (path.endsWith("/auth/config")) return authConfig();
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => <div>应用已就绪</div>}</AuthGate>);

    expect(await screen.findByLabelText("邮箱")).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });

  it("renders a local-only account form without a captcha", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/config")) return authConfig();
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);

    expect(await screen.findByLabelText("邮箱")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByLabelText("验证码")).not.toBeInTheDocument();
    expect(screen.getByText("账户、资料和对话只保存在这台设备上，不是云端账号。")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("auth-gate");
    expect(screen.getByRole("heading", { name: "团团" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByText(/沉淀到你的本地知识库/)).not.toBeInTheDocument();
    const aboutLink = screen.getByRole("link", { name: "关于 团团" });
    expect(aboutLink).toHaveAttribute("href", "#/about");
    expect(aboutLink.closest("form")).toBeNull();
    expect(screen.getByRole("navigation", { name: "公共导航" })).toContainElement(aboutLink);

    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
  });

  it.each([
    ["密码不正确", "密码不正确，请重新输入。"],
    ["邮箱或密码不正确", "邮箱或密码不正确，请核对后重试。"]
  ])("shows a password error without offering account creation: %s", async (detail, expected) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/login") && init?.method === "POST") {
        return new Response(JSON.stringify({ detail }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveFocus());
    expect(screen.queryByRole("button", { name: "创建并登录" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("creates and signs in an unknown account only after accepting the creation notice", async () => {
    let finishRegistration: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/login")) return new Response(JSON.stringify({ detail: "该邮箱尚未注册" }), { status: 404 });
      if (path.endsWith("/auth/register")) {
        expect(JSON.parse(String(init?.body))).toEqual({ email: "new@example.com", password: "rkt9876543!" });
        return new Promise<Response>((resolve) => { finishRegistration = resolve; });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{(_token, _logout, user) => <div>已进入 {user.email}</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: " New@Example.com " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "rkt9876543!" } });
    fireEvent.click(screen.getByLabelText("保持登录"));
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    const create = await screen.findByRole("button", { name: "创建并登录" });
    expect(screen.getByText(/该邮箱尚未注册。确认邮箱无误后/)).toHaveTextContent("使用当前邮箱和密码创建本地账户，并自动登录");
    expect(screen.getByLabelText("密码")).toHaveValue("rkt9876543!");
    expect(screen.queryByLabelText("确认密码")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
    finishRegistration(new Response(JSON.stringify({ access_token: "new-token", user: { email: "new@example.com" } }), { status: 200 }));
    expect(await screen.findByText("已进入 new@example.com")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("tuantuan-auth-token")).toBe("new-token");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });

  it.each(["short", "passwordpassword"])("enforces the new password policy before creating from login: %s", async (password) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/login")) return new Response(JSON.stringify({ detail: "该邮箱尚未注册" }), { status: 404 });
      if (path.endsWith("/auth/register")) return new Response(JSON.stringify({ access_token: "new-token", user: { email: "new@example.com" } }), { status: 200 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => <div>应用已就绪</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建并登录" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(password === "short" ? "密码至少需要 8 个字符" : "容易被猜到");
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并登录" }));
    expect(await screen.findByText("应用已就绪")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["edit", "cancel"])("cancels pending creation when the user changes their intent: %s", async (action) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/config")) return authConfig();
      if (String(input).endsWith("/auth/login")) return new Response(JSON.stringify({ detail: "该邮箱尚未注册" }), { status: 404 });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("button", { name: "创建并登录" });
    if (action === "edit") fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "other@example.com" } });
    else fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(screen.queryByText(/该邮箱尚未注册。确认邮箱无误后/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
    if (action === "cancel") expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns to login if another request registered the email before confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/login")) return new Response(JSON.stringify({ detail: "该邮箱尚未注册" }), { status: 404 });
      if (path.endsWith("/auth/register")) return new Response(JSON.stringify({ detail: "该邮箱已注册，请直接登录" }), { status: 409 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建并登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("该邮箱已注册，请直接登录。");
    expect(screen.queryByRole("button", { name: "创建并登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [false, "该邮箱尚未注册"],
    [true, "Not Found"]
  ])("does not offer creation for closed registration or unrelated 404 errors", async (registrationOpen, detail) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth/config")
      ? new Response(JSON.stringify({ enabled: true, setup_required: false, registration_open: registrationOpen }), { status: 200 })
      : new Response(JSON.stringify({ detail }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(detail);
    expect(screen.queryByRole("button", { name: "创建并登录" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers reconnect when login cannot reach the server", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/login") && init?.method === "POST") throw new TypeError("Failed to fetch");
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("暂时无法连接登录服务，请检查连接后重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新连接" })).toBeInTheDocument();
  });

  it("validates the registration email while typing and clears errors when corrected", async () => {
    const fetchMock = vi.fn(async () => authConfig(true));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    const email = await screen.findByLabelText("邮箱");
    expect(screen.queryByText("请输入邮箱")).not.toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "false");

    for (const value of ["name", "name@", "name@example", "name @example.com"]) {
      fireEvent.change(email, { target: { value } });
      expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
      expect(email).toHaveAttribute("aria-invalid", "true");
      expect(email).toHaveAccessibleDescription("请输入有效的邮箱地址");
    }

    fireEvent.change(email, { target: { value: " name@example.com " } });
    expect(screen.queryByText("请输入有效的邮箱地址")).not.toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "false");
    expect(email).not.toHaveAttribute("aria-describedby");

    fireEvent.change(email, { target: { value: "" } });
    expect(screen.getByText("请输入邮箱")).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears registration format errors after selecting an email suggestion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => authConfig(true)));
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    const email = await screen.findByLabelText("邮箱");
    fireEvent.change(email, { target: { value: "reader@q" } });
    expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "reader@qq.com" }));
    expect(email).toHaveValue("reader@qq.com");
    expect(email).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("请输入有效的邮箱地址")).not.toBeInTheDocument();
  });

  it("allows legacy login names and validates existing input when switching to registration", async () => {
    const fetchMock = vi.fn(async () => authConfig());
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    const email = await screen.findByLabelText("邮箱");
    fireEvent.change(email, { target: { value: "legacy-owner" } });
    expect(email).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("请输入有效的邮箱地址")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "没有账号？创建账号" }));
    expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("button", { name: "已有账号？去登录" }));
    expect(email).toHaveValue("legacy-owner");
    expect(email).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("请输入有效的邮箱地址")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates registration fields before sending credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/config")) return authConfig();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.click(screen.getByRole("button", { name: "没有账号？创建账号" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "invalid" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByText("请输入有效的邮箱地址")).toBeInTheDocument();
    expect(screen.getByText("密码至少需要 8 个字符")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives live password guidance and rejects weak passwords before registration", async () => {
    const fetchMock = vi.fn(async () => authConfig(true));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    const email = await screen.findByLabelText("邮箱");
    const password = screen.getByLabelText("密码");
    expect(password).toHaveAttribute("placeholder", "设置登录密码");
    expect(password).not.toHaveAttribute("maxlength");
    expect(screen.getByText("8–128 个字符，建议使用较长的密码或短语")).toBeInTheDocument();
    fireEvent.change(email, { target: { value: "reader@example.com" } });
    fireEvent.change(password, { target: { value: "short" } });
    expect(screen.getByRole("status")).toHaveTextContent("还需 3 个字符");
    fireEvent.change(password, { target: { value: "passwordpassword" } });
    expect(screen.getByRole("status")).toHaveTextContent("容易被猜到");
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "passwordpassword" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(password, { target: { value: "a long memorable phrase" } });
    expect(screen.getByRole("status")).toHaveTextContent("符合密码要求");
    expect(password).toHaveAttribute("aria-invalid", "false");
    fireEvent.change(password, { target: { value: "x".repeat(129) } });
    expect(password).toHaveValue("x".repeat(129));
    expect(screen.getByRole("status")).toHaveTextContent("密码不能超过 128 个字符");
  });

  it("lets a visitor create another local account", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/register") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ email: "new@example.com", password: "rkt9876543!" });
        return new Response(JSON.stringify({ access_token: "new-token", user: { email: "new@example.com" } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate apiBase="https://app.example.com">{(_token, _logout, user) => <div>已进入 {user.email}</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.click(screen.getByRole("button", { name: "没有账号？创建账号" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "rkt9876543!" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "rkt9876543!" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByText("已进入 new@example.com")).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBe("new-token");
  });

  it("respects reduced motion on the decorative background", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/config")) return authConfig();
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && query.includes("reduce"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    }));
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);

    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    const gate = screen.getByRole("main");
    expect(gate.querySelector(".auth-grid")).not.toBeNull();
    fireEvent.pointerMove(gate, { clientX: 200, clientY: 400 });
    expect(gate.style.getPropertyValue("--cell-x")).toBe("");
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("account session lifecycle", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mockAuth(extra?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const response = extra?.(path, init);
      if (response) return response;
      if (path.endsWith("/auth/config")) return authConfig();
      if (path.endsWith("/auth/me")) return new Response(JSON.stringify({ user: { email: "owner@example.com" } }));
      if (path.endsWith("/auth/login")) return new Response(JSON.stringify({ access_token: "new-token", user: { email: "owner@example.com" } }));
      if (path.endsWith("/auth/logout")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
  }

  it("stores a temporary login only in session storage and preserves normalized email", async () => {
    const fetchMock = mockAuth((path, init) => {
      if (path.endsWith("/auth/login")) {
        expect(JSON.parse(String(init?.body))).toEqual({ email: "owner@example.com", password: "old" });
      }
      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "  OWNER@Example.com  " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "old" } });
    fireEvent.click(screen.getByLabelText("保持登录"));
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("账户已就绪");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
    expect(window.sessionStorage.getItem("tuantuan-auth-token")).toBe("new-token");
  });

  it("revokes the session before clearing the saved login", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    let finishLogout: (response: Response) => void = () => undefined;
    const fetchMock = mockAuth((path, init) => {
      if (path.endsWith("/auth/logout")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer saved-token");
        return new Promise<Response>((resolve) => { finishLogout = resolve; });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{(_token, logout) => <button onClick={logout}>退出登录</button>}</AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(await screen.findByText("正在退出登录…")).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBe("saved-token");
    await act(async () => finishLogout(new Response(null, { status: 204 })));
    await screen.findByLabelText("邮箱");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });

  it("keeps the session and offers retry when logout fails", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    let attempts = 0;
    vi.stubGlobal("fetch", mockAuth((path) => {
      if (path.endsWith("/auth/logout") && ++attempts === 1) return Promise.reject(new TypeError("Failed to fetch"));
    }));
    render(<AuthGate apiBase="https://app.example.com">{(_token, logout) => <button onClick={logout}>退出登录</button>}</AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    await screen.findByText("退出未完成，请重新连接后重试。");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBe("saved-token");
    fireEvent.click(screen.getByRole("button", { name: "重试退出" }));
    await screen.findByLabelText("邮箱");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });

  it("returns to login when a protected request rejects the session", async () => {
    const { createApiClient } = await import("../api/client");
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    vi.stubGlobal("fetch", mockAuth((path) => path.endsWith("/library") ? new Response('{"detail":"登录失效"}', { status: 401 }) : undefined));
    render(<AuthGate apiBase="https://app.example.com">{(token) => <button onClick={() => { void createApiClient("https://app.example.com", token)("/library").catch(() => undefined); }}>加载资料</button>}</AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "加载资料" }));
    await screen.findByLabelText("邮箱");
    expect(screen.getByRole("status")).toHaveTextContent("登录状态已失效，请重新登录");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });

  it("ignores a late 401 belonging to a replaced session", async () => {
    const { SESSION_EXPIRED_EVENT } = await import("../api/client");
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    vi.stubGlobal("fetch", mockAuth());
    render(<AuthGate apiBase="https://app.example.com">{(token, _logout, user, update) => <button onClick={() => update("fresh-token", user)}>{token}</button>}</AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "saved-token" }));
    await screen.findByRole("button", { name: "fresh-token" });
    act(() => window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { token: "saved-token" } })));
    expect(screen.getByRole("button", { name: "fresh-token" })).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBe("fresh-token");
  });

  it("synchronizes logout across persistent browser tabs", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    vi.stubGlobal("fetch", mockAuth());
    render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>);
    await screen.findByText("账户已就绪");
    act(() => {
      window.localStorage.removeItem("tuantuan-auth-token");
      window.dispatchEvent(new StorageEvent("storage", { key: "tuantuan-auth-token", newValue: null }));
    });
    await screen.findByLabelText("邮箱");
    expect(screen.getByRole("status")).toHaveTextContent("账户已在其他窗口退出");
  });

  it("retries session restoration through repeated identical network errors", async () => {
    window.localStorage.setItem("tuantuan-auth-token", "saved-token");
    let attempts = 0;
    const fetchMock = mockAuth((path) => {
      if (path.endsWith("/auth/me") && ++attempts < 3) return Promise.reject(new TypeError("Failed to fetch"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>);
    await screen.findByRole("alert");
    vi.useFakeTimers();
    // Trigger a retry so its backoff timer is managed by the test clock.
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(attempts).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("账户已就绪")).toBeInTheDocument();
    expect(attempts).toBe(3);
  });

  it("offers direct login after duplicate registration and clears password on mode change", async () => {
    vi.stubGlobal("fetch", mockAuth((path) => path.endsWith("/auth/register") ? new Response('{"detail":"该邮箱已注册"}', { status: 409 }) : undefined));
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.click(screen.getByRole("button", { name: "没有账号？创建账号" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
    fireEvent.click(await screen.findByRole("button", { name: "去登录" }));
    expect(screen.getByLabelText("邮箱")).toHaveValue("owner@example.com");
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.queryByLabelText("确认密码")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "登录本地账户" })).toBeInTheDocument();
  });

  it("does not expose registration when the server closes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"enabled":true,"setup_required":false,"registration_open":false}')));
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    expect(screen.queryByRole("button", { name: "没有账号？创建账号" })).not.toBeInTheDocument();
  });

  it("rejects malformed successful login data without saving an undefined token", async () => {
    vi.stubGlobal("fetch", mockAuth((path) => path.endsWith("/auth/login") ? new Response('{"user":{"email":"owner@example.com"}}') : undefined));
    render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("登录服务返回了无效数据，请重试");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
    expect(screen.queryByText("账户已就绪")).not.toBeInTheDocument();
  });

  it("blocks resubmission until Retry-After has elapsed", async () => {
    vi.stubGlobal("fetch", mockAuth((path) => path.endsWith("/auth/login") ? new Response('{"detail":"登录失败次数过多"}', { status: 429, headers: { "Retry-After": "2" } }) : undefined));
    render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("button", { name: "2 秒后重试" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  });

  it("expires an active login at the token deadline", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 10;
    const token = `${btoa(JSON.stringify({ exp: expiry }))}.signature`;
    window.localStorage.setItem("tuantuan-auth-token", token);
    vi.stubGlobal("fetch", mockAuth());
    vi.useFakeTimers();
    await act(async () => { render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>); });
    expect(screen.getByText("账户已就绪")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("登录已到期");
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });
});

describe("restricted storage and request cancellation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("allows an in-memory login when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth/config") ? authConfig() : new Response('{"access_token":"memory-token","user":{"email":"owner@example.com"}}')));
    render(<AuthGate apiBase="https://app.example.com">{() => <div>账户已就绪</div>}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("账户已就绪")).toBeInTheDocument();
  });

  it("does not save a login response that arrives after unmount", async () => {
    let resolveLogin: (response: Response) => void = () => undefined;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/config")) return authConfig();
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveLogin = resolve; });
    }));
    const rendered = render(<AuthGate apiBase="https://app.example.com">{() => null}</AuthGate>);
    await screen.findByLabelText("邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    rendered.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveLogin(new Response('{"access_token":"late-token","user":{"email":"owner@example.com"}}')));
    expect(window.localStorage.getItem("tuantuan-auth-token")).toBeNull();
  });
});

it("restores a new persistent login in an already open signed-out tab", async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/auth/config") ? authConfig() : new Response('{"user":{"email":"owner@example.com"}}')));
  const rendered = render(<AuthGate apiBase="https://app.example.com">{() => <div>同步登录成功</div>}</AuthGate>);
  try {
    await screen.findByLabelText("邮箱");
    act(() => {
      window.localStorage.setItem("tuantuan-auth-token", "other-tab-token");
      window.dispatchEvent(new StorageEvent("storage", { key: "tuantuan-auth-token", newValue: "other-tab-token" }));
    });
    expect(await screen.findByText("同步登录成功")).toBeInTheDocument();
  } finally {
    rendered.unmount();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});
