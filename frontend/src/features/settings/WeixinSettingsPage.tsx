import { useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { createApiClient } from "../../api/client";
import { useAsyncPolling } from "../../hooks/useAsyncPolling";
import { useWeixinStatus, type WeixinChannel, type WeixinBotState } from '../chat/useWeixinStatus';
import "./weixin-settings.css";

type Status = WeixinBotState;
type Login = { session_id: string; qr_image: string; status: string };
const labels: Record<string, string> = {
  wait: "请用手机微信扫描二维码", scaned: "已扫码，请在手机上确认",
  need_verifycode: "请输入手机微信显示的数字", expired: "二维码已过期，请重新连接",
  verify_code_blocked: "验证码尝试次数过多，请重新连接"
};

export function WeixinSettingsPage({ apiBase, accessToken, channel: sharedChannel }: { apiBase: string; accessToken: string; channel?: WeixinChannel }) {
  const api = useMemo(() => createApiClient(apiBase, accessToken), [apiBase, accessToken]);
  const localChannel = useWeixinStatus(api, !sharedChannel);
  const channel = sharedChannel ?? localChannel;
  const status = channel.status;
  const setStatus = channel.accept;
  const [login, setLogin] = useState<Login | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [api]);

  async function poll(verifyCode = "") {
    if (!login) return;
    const epoch = generation.current;
    let result: { status: string };
    try { result = await api<{ status: string }>("/channels/weixin/login/poll", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: login.session_id, verify_code: verifyCode })
    }, 45000); } catch (reason) { if (epoch !== generation.current) return; throw reason; }
    if (epoch !== generation.current) return;
    setError("");
    if (result.status === "confirmed") {
      await channel.refresh();
      if (epoch !== generation.current) return;
      setLogin(null); setCode("");
    } else {
      setLogin(current => current?.session_id === login.session_id ? { ...current, status: result.status } : current);
    }
  }
  useAsyncPolling({ enabled: !!login && ["wait", "scaned"].includes(login.status), intervalMs: 1000,
    runImmediately: true, poll: () => poll(), onError: reason => setError(reason instanceof Error ? reason.message : "连接状态读取失败") });

  async function action(kind: "connect" | "disconnect" | "verify") {
    const epoch = kind === "verify" ? generation.current : ++generation.current;
    setBusy(true); setError("");
    try {
      if (kind === "connect") { setCode(""); const next = await api<Login>("/channels/weixin/login", { method: "POST" }); if (epoch === generation.current) setLogin(next); }
      if (kind === "disconnect") { setLogin(null); const next = await api<Status>("/channels/weixin", { method: "DELETE" }); if (epoch === generation.current) setStatus(next); }
      if (kind === "verify") await poll(code);
    } catch (reason) { if (epoch === generation.current) setError(reason instanceof Error ? reason.message : "微信连接失败"); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  return <section className="weixin-settings" aria-labelledby="weixin-title">
    <header><MessageCircle size={24} aria-hidden="true" /><div><h2 id="weixin-title">微信</h2><p>在手机上给团团派任务，回到同一个会话查看回答。</p></div></header>
    <p role="status">{status ? status.connected ? status.enabled ? status.error ? "已绑定微信，消息通道异常" : "已连接微信" : "微信连接已失效" : "尚未连接微信" : "正在读取连接状态…"}</p>
    <p className="weixin-help">支持绑定用户的私聊文字任务和语音转写。使用当前账号的模型与资料，执行记录保留在团团中。接收消息时，团团后端需要保持运行。</p>
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    {login && <div className="weixin-pairing">
      {["wait", "scaned", "need_verifycode"].includes(login.status) && <img src={login.qr_image} alt="微信连接二维码" width="240" height="240" />}
      <p role="status">{labels[login.status] || "正在等待微信确认"}</p>
      {login.status === "need_verifycode" && <form onSubmit={event => { event.preventDefault(); void action("verify"); }}>
        <label htmlFor="weixin-code">手机显示的验证码</label>
        <input id="weixin-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]+" maxLength={16} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />
        <button type="submit" disabled={busy || !code}>确认验证码</button>
      </form>}
    </div>}
    <div className="weixin-actions">
      <button type="button" disabled={busy || (!!login && ["wait", "scaned", "need_verifycode"].includes(login.status))} onClick={() => void action("connect")}>
        {busy ? "正在处理…" : status?.connected || login ? "重新连接" : "连接微信"}
      </button>
      {(status?.connected || login) && <button type="button" disabled={busy} onClick={() => void action("disconnect")}>{status?.connected ? "解除绑定" : "取消连接"}</button>}
      {status?.conversation_id && <a href={`#/chat/${status.conversation_id}`}>查看微信会话</a>}
    </div>
  </section>;
}
