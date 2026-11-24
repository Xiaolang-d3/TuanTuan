import { useEffect, useId, useRef, useState } from "react";
import { ApiError, type createApiClient } from "../../api/client";
import "./chatgpt-subscription.css";

const subscriptionPath = "/agent/chatgpt-subscription";
const usageUrl = "https://chatgpt.com/settings/usage";
const pollIntervalMs = 1_500;
const maxPollMs = 10 * 60_000;

type Account = { id: string; label: string; email?: string; signed_in: boolean; plan_enabled: boolean };
type Subscription = {
  available: boolean;
  configured: boolean;
  plan_enabled: boolean;
  status: "unavailable" | "signed_out" | "connected" | "identity_only" | "reauthorize";
  accounts?: Account[];
  active_id?: string | null;
  connection_id?: string | null;
  message?: string;
};
type Attempt = { status: "pending" | "completed" | "failed"; message?: string };
type Phase = "loading" | "starting" | "waiting" | "switching" | "signing-out" | "refreshing";
type Task = { controller: AbortController; blankTab?: Window };
type Props = { fetchJson: ReturnType<typeof createApiClient>; onChanged: () => Promise<void>; disabled?: boolean };

const statusCopy: Record<Subscription["status"], string> = {
  unavailable: "当前环境不支持 ChatGPT 订阅登录。",
  signed_out: "尚未登录 ChatGPT 账号。",
  connected: "已连接 ChatGPT 订阅。",
  identity_only: "账号已登录，但未获得订阅模型使用权限。",
  reauthorize: "当前账号的授权已失效，请重新授权。"
};

function trustedAuthorizationUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.username || url.password || url.hash) {
    throw new Error("Invalid authorization destination");
  }
  return url.href;
}

function closeBlankTab(tab: Window | undefined) {
  try { if (tab && !tab.closed && tab.location.href === "about:blank") tab.close(); } catch { /* Do not touch a cross-origin or already navigated tab. */ }
}

function openBlankTab() {
  const tab = window.open("about:blank", "_blank");
  if (!tab) return undefined;
  try {
    tab.opener = null;
    return tab;
  } catch {
    closeBlankTab(tab);
    return undefined;
  }
}

function navigateBlankTab(tab: Window, url: string) {
  if (tab.closed || tab.location.href !== "about:blank") return false;
  const anchor = tab.document.createElement("a");
  anchor.href = url;
  anchor.rel = "noreferrer";
  tab.document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
  return true;
}

function waitToPoll(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    const timer = window.setTimeout(finish, pollIntervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function ChatGPTSubscriptionSettings({ fetchJson, onChanged, disabled = false }: Props) {
  const titleId = useId();
  const taskRef = useRef<Task | null>(null);
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [phase, setPhase] = useState<Phase | null>("loading");
  const [authorizationLink, setAuthorizationLink] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function cancelTask() {
    const task = taskRef.current;
    taskRef.current = null;
    task?.controller.abort();
    closeBlankTab(task?.blankTab);
  }

  function begin(nextPhase: Phase) {
    if (taskRef.current) return null;
    const task: Task = { controller: new AbortController() };
    taskRef.current = task;
    setPhase(nextPhase);
    setError("");
    setNotice("");
    return task;
  }

  function current(task: Task) { return taskRef.current === task && !task.controller.signal.aborted; }

  function finish(task: Task) {
    if (!current(task)) return;
    cancelTask();
    setPhase(null);
    setAuthorizationLink("");
  }

  async function getStatus(task: Task) {
    const next = await fetchJson<Subscription>(subscriptionPath, { signal: task.controller.signal, cache: "no-store" });
    if (current(task)) setSubscription(next);
  }

  async function readStatus(refresh = false) {
    const task = begin("loading");
    if (!task) return;
    try {
      await getStatus(task);
      if (refresh) await refreshModels(task);
    } catch {
      if (current(task)) setError("无法读取 ChatGPT 订阅状态，请重试。");
    } finally { finish(task); }
  }

  useEffect(() => {
    setSubscription(null);
    setAuthorizationLink("");
    void readStatus();
    return cancelTask;
  }, [fetchJson]);

  async function refreshModels(task: Task) {
    if (!current(task)) return;
    setPhase("refreshing");
    setAuthorizationLink("");
    try { await latestOnChanged.current(); }
    catch { if (current(task)) setError("授权状态已更新，但未能刷新模型设置。请重新读取模型设置。"); }
  }

  async function startSignIn(accountId?: string, reconsent = false) {
    if (disabled || !subscription?.available) return;
    const task = begin("starting");
    if (!task) return;
    const signal = task.controller.signal;
    try {
      // Reserve a same-origin tab during the click, before waiting on the API.
      try { task.blankTab = openBlankTab(); } catch { /* Use the inline link. */ }
      const result = await fetchJson<{ attempt_id: string; authorization_url: string }>(`${subscriptionPath}/start`, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, reconsent: reconsent || undefined })
      });
      if (!current(task)) return;
      const url = trustedAuthorizationUrl(result.authorization_url);
      const attemptPath = `${subscriptionPath}/attempts/${encodeURIComponent(result.attempt_id)}`;
      let opened = false;
      try { if (task.blankTab) opened = navigateBlankTab(task.blankTab, url); } catch { /* Use the inline link. */ }
      if (!opened) closeBlankTab(task.blankTab);
      // Never close or otherwise control a tab after handing it off to OpenAI.
      task.blankTab = undefined;
      setAuthorizationLink(opened ? "" : url);
      setPhase("waiting");
      const deadline = Date.now() + maxPollMs;
      while (current(task) && Date.now() < deadline) {
        await waitToPoll(signal);
        if (!current(task) || Date.now() >= deadline) break;
        let attempt: Attempt;
        try {
          attempt = await fetchJson<Attempt>(attemptPath, { signal, cache: "no-store" });
        } catch (reason) {
          // A transient local connection hiccup does not cancel the browser flow.
          if (reason instanceof ApiError && reason.status < 500) throw reason;
          continue;
        }
        if (!current(task)) return;
        if (attempt.status === "pending") continue;
        if (attempt.status === "failed") {
          setError("未能完成 ChatGPT 授权。请关闭授权页后重试。");
          return;
        }
        if (attempt.status !== "completed") throw new Error("Invalid attempt status");
        setNotice("授权流程已完成；不会自动更换默认模型。");
        // Attempt completion itself can change the catalog, even if the status read fails.
        await Promise.all([refreshModels(task), getStatus(task).catch(() => {
          if (current(task)) {
            setSubscription(null);
            setError("授权流程已完成，但未能读取最新账号状态。请重新读取。");
          }
        })]);
        return;
      }
      if (current(task)) setError("等待授权超时。请关闭授权页后重试。");
    } catch {
      if (current(task)) setError("无法完成 ChatGPT 授权，请重试。");
    } finally { finish(task); }
  }

  function dismissSignIn() {
    if (phase !== "starting" && phase !== "waiting") return;
    cancelTask();
    setPhase(null);
    setError("");
    setAuthorizationLink("");
    setNotice("已停止等待。请关闭浏览器中的授权页；如已授权，可重新读取状态。");
  }

  async function changeAccount(accountId?: string) {
    if (disabled || !subscription?.available) return;
    const task = begin(accountId ? "switching" : "signing-out");
    if (!task) return;
    const signal = task.controller.signal;
    try {
      const next = accountId
        ? await fetchJson<Subscription>(`${subscriptionPath}/active`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: accountId }) })
        : await fetchJson<Subscription>(subscriptionPath, { method: "DELETE", signal });
      if (!current(task)) return;
      setSubscription(next);
      setNotice(accountId ? "已切换 ChatGPT 账号。" : next.message
        ? "已从本机退出 ChatGPT 账号，但无法确认远程授权已撤销。"
        : "已从本机退出 ChatGPT 账号，已保存的账号仍可重新登录。");
      await refreshModels(task);
    } catch {
      if (current(task)) setError(accountId ? "无法确认账号切换，请重新读取状态后重试。" : "无法确认已退出，请重新读取状态后重试。");
    } finally { finish(task); }
  }

  const locked = Boolean(phase) || disabled;
  const waiting = phase === "starting" || phase === "waiting";
  return (
    <section className="chatgpt-subscription" aria-labelledby={titleId}>
      <h3 id={titleId}>ChatGPT 订阅登录</h3>
      <p>仅限本机使用，需要符合条件的 ChatGPT 订阅；不会回退到按量付费的 OpenAI API。</p>
      {subscription ? <p role="status">{statusCopy[subscription.available ? subscription.status : "unavailable"]}</p> : null}
      {phase === "loading" ? <p role="status">正在读取 ChatGPT 订阅状态…</p> : null}
      {phase === "starting" ? <p role="status">正在准备浏览器授权…</p> : null}
      {phase === "waiting" ? <p role="status">请在浏览器中完成授权，然后返回团团。</p> : null}
      {phase === "switching" ? <p role="status">正在切换账号…</p> : null}
      {phase === "signing-out" ? <p role="status">正在退出账号…</p> : null}
      {phase === "refreshing" ? <p role="status">正在刷新模型设置…</p> : null}
      {error ? <p role="alert" className="model-capability-error">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {waiting && <div className="chatgpt-subscription-actions">
        {authorizationLink && <a href={authorizationLink} target="_blank" rel="noopener noreferrer">在浏览器打开 ChatGPT 授权</a>}
        <button type="button" onClick={dismissSignIn}>停止等待授权</button>
      </div>}
      {subscription?.available && <>
        {Boolean(subscription.accounts?.length) && <ul className="chatgpt-subscription-accounts" aria-label="已保存的 ChatGPT 账号">
          {subscription.accounts?.map((account) => {
            const active = account.id === subscription.active_id;
            const needsReauthorization = account.signed_in && !account.plan_enabled || active && subscription.status === "reauthorize";
            const accountName = account.label || account.email || "ChatGPT 账号";
            return <li key={account.id}>
              <div><strong>{accountName}</strong>{account.email && account.email !== accountName ? <small>{account.email}</small> : null}
                <small>{active ? "当前账号 · " : ""}{account.signed_in ? account.plan_enabled ? "已登录 · 可使用订阅模型" : "已登录 · 无订阅模型权限" : "未登录"}</small>
              </div>
              <div className="chatgpt-subscription-actions">
                {!active && account.signed_in && <button type="button" disabled={locked} aria-label={`切换至 ${accountName}`} onClick={() => void changeAccount(account.id)}>切换至此账号</button>}
                {(needsReauthorization || !account.signed_in) && <button type="button" disabled={locked} aria-label={`${needsReauthorization ? "重新授权" : "登录"} ${accountName}`} onClick={() => void startSignIn(account.id, needsReauthorization)}>{needsReauthorization ? "重新授权" : "登录"}</button>}
                {active && (account.signed_in || subscription.configured) && <button type="button" disabled={locked} onClick={() => void changeAccount()}>退出当前账号</button>}
              </div>
            </li>;
          })}
        </ul>}
        <div className="chatgpt-subscription-actions">
          <button type="button" disabled={locked} onClick={() => void startSignIn()}>{subscription.accounts?.length ? "添加 ChatGPT 账号" : "登录 ChatGPT"}</button>
          <a href={usageUrl} target="_blank" rel="noopener noreferrer">查看 ChatGPT 用量</a>
        </div>
        {subscription.plan_enabled && <p>在模型列表中读取此服务的模型；如需更换默认模型，请在场景默认模型中手动选择。</p>}
      </>}
      {!waiting && <button type="button" disabled={locked} onClick={() => void readStatus()}>重新读取 ChatGPT 状态</button>}
    </section>
  );
}
