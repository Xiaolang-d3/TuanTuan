import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGPTSubscriptionSettings } from "./ChatGPTSubscriptionSettings";

const path = "/agent/chatgpt-subscription";
const authorize = "https://auth.openai.com/api/accounts/authorize?state=example-state";
const signedOut = { show_entry: true, available: true, configured: false, plan_enabled: false, status: "signed_out", accounts: [] };
const first = { id: "first", label: "工作账号", signed_in: true, plan_enabled: true };
const second = { id: "second", label: "个人账号", signed_in: true, plan_enabled: false };
const connected = { ...signedOut, configured: true, plan_enabled: true, status: "connected", active_id: "first", accounts: [first, second] };
const identityOnly = { ...connected, plan_enabled: false, status: "identity_only", active_id: "second" };

async function renderSettings(fetchJson = vi.fn().mockResolvedValue(signedOut)) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const view = render(<ChatGPTSubscriptionSettings fetchJson={fetchJson} onChanged={onChanged} />);
  await act(async () => {});
  return { ...view, fetchJson, onChanged };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatGPTSubscriptionSettings", () => {
  it("keeps the hosted entry hidden before and after status loads", async () => {
    let resolveStatus!: (value: unknown) => void;
    const fetchJson = vi.fn().mockImplementation(() => new Promise(resolve => { resolveStatus = resolve; }));
    const { container } = await renderSettings(fetchJson);
    expect(fetchJson).toHaveBeenCalledOnce();
    expect(container).toBeEmptyDOMElement();
    await act(async () => resolveStatus({ ...signedOut, show_entry: false, available: false, status: "unavailable" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("does not offer sign-in when unsupported by the local backend", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ ...signedOut, available: false, status: "unavailable" });
    await renderSettings(fetchJson);
    expect(screen.getByText("当前环境不支持 ChatGPT 订阅登录。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "登录 ChatGPT" })).not.toBeInTheDocument();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("shows a secure fallback link if popups are blocked and reloads settings only after completion", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fetchJson = vi.fn().mockResolvedValueOnce(signedOut)
      .mockResolvedValueOnce({ attempt_id: "mock/id", authorization_url: authorize })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "completed" })
      .mockResolvedValueOnce(connected);
    const { onChanged } = await renderSettings(fetchJson);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "登录 ChatGPT" })));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(fetchJson.mock.invocationCallOrder[1]);
    expect(fetchJson).toHaveBeenNthCalledWith(2, `${path}/start`, expect.objectContaining({ method: "POST", body: "{}" }));
    const link = screen.getByRole("link", { name: "在浏览器打开 ChatGPT 授权" });
    expect(link).toHaveAttribute("href", authorize);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(fetchJson).toHaveBeenLastCalledWith(`${path}/attempts/mock%2Fid`, expect.objectContaining({ cache: "no-store" }));
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已连接 ChatGPT 订阅。")).toBeVisible();
    expect(screen.getByText(/不会自动更换默认模型/)).toBeVisible();
    expect(screen.getByRole("link", { name: "查看 ChatGPT 用量" })).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
    expect(link).not.toBeInTheDocument();
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([path, `${path}/start`, `${path}/attempts/mock%2Fid`, `${path}/attempts/mock%2Fid`, path]);
  });

  it("disowns the reserved tab, navigates without a referrer, and never closes it after handoff", async () => {
    const anchor = document.createElement("a");
    const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const close = vi.fn();
    const tab = { opener: window, closed: false, location: { href: "about:blank" }, close, document: { createElement: () => anchor, body: document.body } };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const fetchJson = vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValueOnce({ attempt_id: "attempt", authorization_url: authorize });
    const { onChanged } = await renderSettings(fetchJson);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "登录 ChatGPT" })));
    expect(tab.opener).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.href).toBe(authorize);
    expect(anchor.rel).toBe("noreferrer");
    expect(screen.queryByRole("link", { name: "在浏览器打开 ChatGPT 授权" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止等待授权" }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each(["http://auth.openai.com/api/accounts/authorize", "https://auth.openai.com.example.test/api/accounts/authorize", "https://auth.openai.com/untrusted"])("does not navigate or render an untrusted result (%s)", async (authorization_url) => {
    const close = vi.fn();
    const tab = { opener: window, closed: false, location: { href: "about:blank" }, close };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const fetchJson = vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValueOnce({ attempt_id: "attempt", authorization_url });
    await renderSettings(fetchJson);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "登录 ChatGPT" })));
    expect(screen.getByRole("alert")).toHaveTextContent("无法完成 ChatGPT 授权，请重试。");
    expect(screen.getByRole("alert")).not.toHaveTextContent(authorization_url);
    expect(screen.queryByRole("link", { name: "在浏览器打开 ChatGPT 授权" })).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight request on unmount and ignores a late attempt result", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    let complete!: (value: unknown) => void;
    const fetchJson = vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValueOnce({ attempt_id: "attempt", authorization_url: authorize })
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { unmount, onChanged } = await renderSettings(fetchJson);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "登录 ChatGPT" })));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    const signal: AbortSignal = fetchJson.mock.calls[2][1].signal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => complete({ status: "completed" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("switches between accounts, supports explicit reauthorization, and does not expose revoke details", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const fetchJson = vi.fn().mockResolvedValueOnce(connected).mockResolvedValueOnce(identityOnly)
      .mockResolvedValueOnce({ attempt_id: "retry", authorization_url: authorize })
      .mockResolvedValueOnce({ ...identityOnly, configured: false, status: "signed_out", message: "raw details", accounts: [first, { ...second, signed_in: false }] });
    const { onChanged } = await renderSettings(fetchJson);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "切换至 个人账号" })));
    expect(fetchJson).toHaveBeenLastCalledWith(`${path}/active`, expect.objectContaining({ method: "POST", body: '{"account_id":"second"}' }));
    expect(screen.getByText(/未获得订阅模型使用权限/)).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新授权 个人账号" })));
    expect(fetchJson).toHaveBeenLastCalledWith(`${path}/start`, expect.objectContaining({ method: "POST", body: '{"account_id":"second","reconsent":true}' }));
    fireEvent.click(screen.getByRole("button", { name: "停止等待授权" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "退出当前账号" })));
    expect(fetchJson).toHaveBeenLastCalledWith(path, expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByText(/无法确认远程授权已撤销/)).toBeVisible();
    expect(screen.queryByText("raw details")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录 个人账号" })).toBeVisible();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
