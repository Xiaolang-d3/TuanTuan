import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WeixinSettingsPage } from "./WeixinSettingsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("distinguishes saved binding from a healthy message channel", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    connected: true, enabled: true, error: "无法连接微信服务，请检查后端网络"
  }), { headers: { "Content-Type": "application/json" } })));
  render(<WeixinSettingsPage apiBase="http://local" accessToken="token" />);
  expect(await screen.findByText("已绑定微信，消息通道异常")).toBeInTheDocument();
  expect(screen.queryByText("已连接微信")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "解除绑定" })).toBeEnabled();
});

it("shows a QR code, accepts phone verification and connects without exposing credentials", async () => {
  let connected = false;
  const requests: Array<{ path: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const path = String(url);
    requests.push({ path, body: options?.body as string });
    let data: unknown = { connected, enabled: connected, error: "" };
    if (path.endsWith("/login")) data = { session_id: "session", qr_image: "data:image/png;base64,AAAA", status: "wait" };
    if (path.endsWith("/login/poll")) {
      if (new Headers(options.headers).get("Content-Type") !== "application/json") {
        return new Response(JSON.stringify({ detail: "Input should be a valid dictionary or object to extract fields from" }), { status: 422 });
      }
      connected = JSON.parse(options.body as string).verify_code === "1234";
      data = { status: connected ? "confirmed" : "need_verifycode" };
    }
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }));
  render(<WeixinSettingsPage apiBase="http://local" accessToken="local-token" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接微信" }));
  expect(await screen.findByRole("img", { name: "微信连接二维码" })).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText("手机显示的验证码"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "确认验证码" }));
  expect(await screen.findByText("已连接微信")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
  expect(requests.some(request => request.body?.includes('"verify_code":"1234"'))).toBe(true);
});

it("shows connection errors and keeps retry available", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    String(url).endsWith("/login") ? { detail: "微信暂时不可用" } : { connected: false, enabled: false, error: "" }
  ), { status: String(url).endsWith("/login") ? 502 : 200, headers: { "Content-Type": "application/json" } })));
  render(<WeixinSettingsPage apiBase="http://local" accessToken="token" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接微信" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("微信暂时不可用");
  expect(screen.getByRole("button", { name: "连接微信" })).toBeEnabled();
});

it("keeps a new QR session when an old confirmation arrives after cancellation", async () => {
  let session = 0;
  let oldStarted = false;
  let completeOld: (value: Response) => void = () => {};
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (String(url).endsWith("/login")) return response({ session_id: `session${++session}`, qr_image: `data:image/png;base64,QR${session}`, status: "wait" });
    if (String(url).endsWith("/login/poll")) {
      if (JSON.parse(options.body as string).session_id === "session1") return new Promise<Response>(resolve => { oldStarted = true; completeOld = resolve; });
      return response({ status: "wait" });
    }
    return response({ connected: false, enabled: false, error: "" });
  }));
  render(<WeixinSettingsPage apiBase="http://local" accessToken="token" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接微信" }));
  await screen.findByRole("img", { name: "微信连接二维码" });
  await waitFor(() => expect(oldStarted).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  fireEvent.click(await screen.findByRole("button", { name: "连接微信" }));
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,QR2"));
  await act(async () => { completeOld(response({ status: "confirmed" })); });
  expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,QR2");
});
