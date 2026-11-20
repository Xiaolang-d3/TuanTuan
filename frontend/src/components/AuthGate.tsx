import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import qqConnectLogo from "./qq-connect-logo.png";
import { ApiError, createApiClient } from "../api/client";
import { AuthSession, AuthUser, validateSession } from "../features/auth/session";
import { useAuthSession } from "../features/auth/useAuthSession";
import { beginQq, canUseQq, clearQqReturn, readQqReturn } from "../features/auth/qq";
import { productIntroHash } from "../app/public-routing";
import { AuthEmailInput } from "./AuthEmailInput";
import { AuthMascot } from "./AuthMascot";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { PasswordGuidance } from "./PasswordGuidance";
import { legacyPasswordMaxLength, newPasswordError } from "../features/auth/passwordPolicy";
export type { AuthUser } from "../features/auth/session";
import "./auth-gate.css";

type AuthConfig = { enabled: boolean; setup_required: boolean; registration_open?: boolean; qq_enabled?: boolean };
type FieldErrors = { email?: string; password?: string; passwordConfirmation?: string };
type LoginIssue = { kind: "credentials" | "unregistered" | "network" | "throttled" | "exists" | "generic"; message: string; field?: keyof FieldErrors; retryAfterSeconds?: number };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string, registering: boolean): string | undefined {
  const normalized = email.trim();
  if (!normalized) return "请输入邮箱";
  if (normalized.length > 320) return "邮箱不能超过 320 个字符";
  if (registering && !emailPattern.test(normalized)) return "请输入有效的邮箱地址";
  return undefined;
}

function classifyLoginError(reason: unknown, registering: boolean): LoginIssue {
  const message = reason instanceof Error ? reason.message : "登录失败，请稍后重试";
  const endpoint = registering ? "/auth/register" : "/auth/login";
  const status = reason instanceof ApiError ? reason.status : undefined;
  if (/failed to fetch|networkerror|load failed|网络|无法连接|请求超时/i.test(message)) {
    return { kind: "network", message: "暂时无法连接登录服务，请检查连接后重试。" };
  }
  if (status === 429 || message.includes("次数过多") || message.includes(`${endpoint} 请求失败（429）`)) {
    return { kind: "throttled", message: message.includes("请在") ? message : "登录失败次数过多，请稍后再试。", retryAfterSeconds: reason instanceof ApiError ? reason.retryAfterSeconds : 0 };
  }
  if (!registering && status === 404 && message === "该邮箱尚未注册") {
    return { kind: "unregistered", message, field: "email" };
  }
  if ((registering && status === 409) || message.includes("已注册") || message.includes(`${endpoint} 请求失败（409）`)) {
    return { kind: "exists", message: "该邮箱已注册，请直接登录。", field: "email" };
  }
  if (status === 401 || message.includes("邮箱或密码") || message.includes(`${endpoint} 请求失败（401）`)) {
    return { kind: "credentials", message: message === "密码不正确" ? "密码不正确，请重新输入。" : "邮箱或密码不正确，请核对后重试。", field: "password" };
  }
  return { kind: "generic", message };
}

function validateLoginFields(input: {
  email: string;
  password: string;
  passwordConfirmation: string;
  registering: boolean;
  confirmPassword?: boolean;
}): FieldErrors {
  const next: FieldErrors = {};
  const emailError = validateEmail(input.email, input.registering);
  if (emailError) next.email = emailError;
  if (!input.password) next.password = "请输入密码";
  else if (input.registering) next.password = newPasswordError(input.password, input.email);
  else if (Array.from(input.password).length > legacyPasswordMaxLength) next.password = "密码不能超过 500 个字符";
  if (!next.password) delete next.password;
  if (input.registering && input.confirmPassword !== false) {
    if (!input.passwordConfirmation) next.passwordConfirmation = "请再次输入密码";
    else if (input.password.normalize("NFC") !== input.passwordConfirmation.normalize("NFC")) next.passwordConfirmation = "两次输入的密码不一致";
  }
  return next;
}

export function AuthGate({ apiBase, children, publicPage }: { apiBase: string; children: (accessToken: string, onLogout: () => void, user: AuthUser, updateSession: (token: string, user: AuthUser) => void) => ReactNode; publicPage?: (signedIn: boolean) => ReactNode }) {
  const showingPublicPage = Boolean(publicPage);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const session = useAuthSession(apiBase);
  const { token, authenticated, restoreError, notice, logoutBusy, logoutError, retryRestore, logout, updateSession, acceptSession } = session;
  const [qqReturn, setQqReturn] = useState(readQqReturn);
  const [qqBusy, setQqBusy] = useState(false);
  const [qqNotice, setQqNotice] = useState<{ message: string; error: boolean } | null>(null);
  const acceptSessionRef = useRef(acceptSession);
  acceptSessionRef.current = acceptSession;
  const qqExchange = useRef<{ apiBase: string; token: string | null; result: Promise<unknown> } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [pendingCreation, setPendingCreation] = useState(false);
  const creating = registering || pendingCreation;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bootNonce, setBootNonce] = useState(0);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<LoginIssue["kind"] | "">("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const chosenMode = useRef(false);
  const submitController = useRef<AbortController | null>(null);
  const focusAfterSubmit = useRef<keyof FieldErrors | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const passwordConfirmationRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!qqReturn || !canUseQq(apiBase)) return;
    const binding = qqReturn.startsWith("bind");
    const complete = (message = "", error = true) => {
      clearQqReturn();
      setQqReturn(null);
      if (message) setQqNotice({ message, error });
    };
    if (qqReturn.endsWith("cancelled")) {
      complete("已取消 QQ 授权。", false);
      return;
    }
    if (qqReturn !== "login" && qqReturn !== "bind") {
      complete("未能完成 QQ 授权，请重试。");
      return;
    }
    if (binding && !token) {
      complete("请先登录原来的团团账号，再重新绑定 QQ。");
      return;
    }
    if (!binding && token) {
      complete("请先退出当前账户，再使用 QQ 登录。");
      return;
    }
    if (!qqExchange.current) {
      qqExchange.current = { apiBase, token, result: createApiClient(apiBase, token ?? undefined)("/auth/qq/finish", { method: "POST" }) };
    }
    if (qqExchange.current.apiBase !== apiBase || qqExchange.current.token !== token) {
      complete("登录状态已改变，请重新授权 QQ。");
      return;
    }
    let cancelled = false;
    void qqExchange.current.result.then((payload) => {
      if (cancelled) return;
      const next = binding ? { ...(payload as { user: AuthUser }), access_token: token } : payload;
      acceptSessionRef.current(validateSession(next));
      complete(binding ? "QQ 已绑定，下次可用 QQ 登录此账户。" : "", false);
    }).catch((reason: unknown) => {
      if (!cancelled) complete(reason instanceof Error ? reason.message : "未能完成 QQ 授权，请重试。");
    });
    return () => { cancelled = true; };
  }, [apiBase, qqReturn, token]);

  useEffect(() => {
    if (busy || !focusAfterSubmit.current) return;
    const field = focusAfterSubmit.current;
    focusAfterSubmit.current = null;
    const inputs = { email: emailInputRef, password: passwordInputRef, passwordConfirmation: passwordConfirmationRef };
    inputs[field].current?.focus();
  }, [busy]);

  useEffect(() => {
    if (token || showingPublicPage) return;
    const controller = new AbortController();
    let cancelled = false;
    void createApiClient(apiBase)<AuthConfig>("/auth/config", { signal: controller.signal })
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        if (!chosenMode.current) setRegistering(Boolean(next.setup_required && next.registration_open !== false));
        if (next.registration_open === false) setRegistering(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const raw = reason instanceof Error ? reason.message : "无法连接登录服务";
        setError(/failed to fetch|networkerror|load failed/i.test(raw)
          ? "无法连接本地服务，请点重新连接。若反复失败，请完全退出后重开 团团。"
          : raw);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [apiBase, token, bootNonce, showingPublicPage]);

  useEffect(() => {
    if (!showingPublicPage) return;
    submitController.current?.abort();
    submitController.current = null;
    setBusy(false);
    setPassword("");
    setPasswordConfirmation("");
    setPasswordVisible(false);
    setPendingCreation(false);
    setFieldErrors({});
    setError("");
    setErrorKind("");
    focusAfterSubmit.current = null;
  }, [showingPublicPage]);

  useEffect(() => {
    setBusy(false);
    setPendingCreation(false);
    return () => { submitController.current?.abort(); submitController.current = null; };
  }, [apiBase, token]);

  useEffect(() => {
    if (!cooldownUntil) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= cooldownUntil) setCooldownUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  function switchMode(next: boolean) {
    chosenMode.current = true;
    setRegistering(next);
    setPendingCreation(false);
    setPassword("");
    setPasswordConfirmation("");
    setPasswordVisible(false);
    setFieldErrors(next && email ? { email: validateEmail(email, true) } : {});
    setError("");
    setErrorKind("");
    setQqNotice(null);
  }

  async function startQq() {
    if (busy || qqBusy) return;
    setQqBusy(true);
    setQqNotice(null);
    try {
      await beginQq(apiBase);
    } catch (reason) {
      setQqNotice({ message: reason instanceof Error ? reason.message : "无法连接 QQ，请重试。", error: true });
      setQqBusy(false);
    }
  }

  function focusFirstInvalid(next: FieldErrors) {
    if (next.email) emailInputRef.current?.focus();
    else if (next.password) passwordInputRef.current?.focus();
    else if (next.passwordConfirmation) passwordConfirmationRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || qqBusy || submitController.current || cooldown) return;
    const nextFields = validateLoginFields({
      email,
      password,
      passwordConfirmation,
      registering: creating,
      confirmPassword: registering
    });
    setFieldErrors(nextFields);
    if (Object.keys(nextFields).length) {
      setError("");
      focusFirstInvalid(nextFields);
      return;
    }
    const controller = new AbortController();
    submitController.current = controller;
    setBusy(true);
    setError("");
    setErrorKind("");
    try {
      const payload = await createApiClient(apiBase)<AuthSession>(creating ? "/auth/register" : "/auth/login", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password })
      });
      if (controller.signal.aborted) return;
      const next = validateSession(payload);
      setPassword("");
      setPasswordConfirmation("");
      setPasswordVisible(false);
      chosenMode.current = true;
      setRegistering(false);
      setPendingCreation(false);
      session.acceptSession(next);
    } catch (reason) {
      if (controller.signal.aborted) return;
      const issue = classifyLoginError(reason, creating);
      if (issue.kind === "unregistered" && config?.registration_open !== false) {
        setPendingCreation(true);
        setFieldErrors({ email: validateEmail(email, true) });
        focusAfterSubmit.current = "password";
        return;
      }
      if (issue.kind === "exists" && pendingCreation) setPendingCreation(false);
      setError(issue.message);
      setErrorKind(issue.kind);
      if (issue.retryAfterSeconds) setCooldownUntil(Date.now() + issue.retryAfterSeconds * 1000);
      setFieldErrors(issue.field ? { [issue.field]: issue.message } : {});
      focusAfterSubmit.current = issue.field ?? null;
    } finally {
      if (submitController.current === controller) submitController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (publicPage) return publicPage(Boolean(token && authenticated));
  if (canUseQq(apiBase) && (qqReturn === "login" || qqReturn === "bind")) return <AuthStatus message="正在完成 QQ 授权…" />;
  if (logoutBusy) return <AuthStatus message="正在退出登录…" />;
  if (token && !authenticated) {
    return (
      <AuthStatus
        message={restoreError || "正在验证登录状态…"}
        alert={Boolean(restoreError)}
        onRetry={restoreError ? retryRestore : undefined}
      />
    );
  }
  if (token && authenticated) {
    return <>
      {qqNotice ? <div className={`auth-session-error${qqNotice.error ? "" : " auth-session-notice"}`} role={qqNotice.error ? "alert" : "status"}>
        {qqNotice.message}<button type="button" onClick={() => setQqNotice(null)}>关闭</button>
      </div> : null}
      {logoutError ? <div className="auth-session-error" role="alert">{logoutError}<button type="button" onClick={() => void logout()}>重试退出</button></div> : null}
      {children(token, () => { setQqNotice(null); void logout(); }, authenticated.user, updateSession)}
    </>;
  }
  if (error && !config) {
    return <AuthStatus message={error} alert onRetry={() => { setError(""); setBootNonce((value) => value + 1); }} />;
  }
  if (!config) return <AuthStatus message="正在连接登录服务…" />;
  const qqEnabled = config.qq_enabled && canUseQq(apiBase);
  const confirmMismatch = Boolean(registering && passwordConfirmation && password.normalize("NFC") !== passwordConfirmation.normalize("NFC"));
  const livePasswordError = creating && password ? newPasswordError(password, email) : undefined;
  return (
    <AuthGateShell>
      <div className="auth-shell">
        <form className="auth-card" onSubmit={submit} noValidate aria-busy={busy}>
          <div className="auth-heading">
            <h2 className="auth-form-title">{qqEnabled ? creating ? "创建团团账户" : "登录团团账户" : creating ? "创建本地账户" : "登录本地账户"}</h2>
            <p className="auth-subtitle">{creating ? qqEnabled ? "选择邮箱或 QQ，开始你的工作空间" : "几秒钟即可开始，数据只留在这台设备" : "欢迎回来，继续你的工作空间"}</p>
          </div>
          {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
          {pendingCreation ? <p className="auth-create-notice" role="status">该邮箱尚未注册。确认邮箱无误后，点击「创建并登录」将使用当前邮箱和密码创建{qqEnabled ? "团团" : "本地"}账户，并自动登录。</p> : null}
          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="auth-email">邮箱</label>
              <AuthEmailInput
                inputRef={emailInputRef}
                registering={creating}
                value={email}
                disabled={busy}
                error={fieldErrors.email}
                onChange={(nextEmail) => {
                  setEmail(nextEmail);
                  if (pendingCreation) {
                    setPendingCreation(false);
                    setError("");
                    setErrorKind("");
                    setFieldErrors({ email: validateEmail(nextEmail, registering) });
                  } else {
                    setFieldErrors((current) => ({ ...current, email: validateEmail(nextEmail, registering) }));
                  }
                }}
              />
              {fieldErrors.email ? <small id="auth-email-error" className="auth-field-error">{fieldErrors.email}</small> : null}
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password">密码</label>
              <span className="auth-password-field">
                <input
                  id="auth-password"
                  ref={passwordInputRef}
                  type={passwordVisible ? "text" : "password"}
                  name="password"
                  autoComplete={creating ? "new-password" : "current-password"}
                  placeholder={creating ? "设置登录密码" : "输入登录密码"}
                  value={password}
                  disabled={busy}
                  aria-invalid={Boolean(fieldErrors.password || livePasswordError)}
                  aria-describedby={[creating ? "auth-password-guidance" : "", fieldErrors.password ? "auth-password-error" : ""].filter(Boolean).join(" ") || undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
                  }}
                />
                <button
                  className="auth-show-password"
                  type="button"
                  aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                  aria-pressed={passwordVisible}
                  disabled={busy}
                  aria-controls="auth-password"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </button>
              </span>
              {creating ? <PasswordGuidance password={password} email={email} id="auth-password-guidance" /> : null}
              {fieldErrors.password ? <small id="auth-password-error" className="auth-field-error" role="alert">{fieldErrors.password}</small> : null}
            </div>
            {registering ? (
              <div className="auth-field">
                <label htmlFor="auth-password-confirm">确认密码</label>
                <span className="auth-password-field">
                  <input
                    id="auth-password-confirm"
                    ref={passwordConfirmationRef}
                    type={passwordVisible ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    value={passwordConfirmation}
                    disabled={busy}
                    aria-invalid={Boolean(fieldErrors.passwordConfirmation || confirmMismatch)}
                    aria-describedby={fieldErrors.passwordConfirmation || confirmMismatch ? "auth-password-confirm-error" : undefined}
                    onChange={(event) => {
                      setPasswordConfirmation(event.target.value);
                      if (fieldErrors.passwordConfirmation) setFieldErrors((current) => ({ ...current, passwordConfirmation: undefined }));
                    }}
                  />
                </span>
                {fieldErrors.passwordConfirmation || confirmMismatch ? <small id="auth-password-confirm-error" className="auth-field-error">{fieldErrors.passwordConfirmation || "两次输入的密码不一致"}</small> : null}
              </div>
            ) : null}
          </div>
          {error && !fieldErrors.password ? (
            <p className="auth-error" role="alert">
              <span>{error}</span>
              {errorKind === "exists" ? <button type="button" className="auth-error-action" onClick={() => switchMode(false)}>去登录</button> : null}
              {errorKind === "network" ? <button type="button" className="auth-error-action" onClick={() => { setError(""); setErrorKind(""); setBootNonce((value) => value + 1); }}>重新连接</button> : null}
            </p>
          ) : null}
          {qqNotice ? <p className={qqNotice.error ? "auth-error" : "auth-notice"} role={qqNotice.error ? "alert" : "status"}>{qqNotice.message}</p> : null}
          <div className="auth-actions">
            <button className="auth-submit" type="submit" disabled={busy || qqBusy || cooldown > 0} aria-busy={busy}>
              {qqEnabled ? <Mail size={16} aria-hidden="true" /> : null}
              <span>{cooldown ? `${cooldown} 秒后重试` : busy ? (creating ? "正在创建…" : "正在登录…") : pendingCreation ? "创建并登录" : registering ? "创建账号" : "登录"}</span>
            </button>
            {qqEnabled ? <>
              <div className="auth-qq-divider" aria-hidden="true">或</div>
              <button
                className="auth-submit auth-qq-button"
                type="button"
                disabled={busy || qqBusy}
                aria-busy={qqBusy}
                aria-describedby="auth-qq-hint"
                onClick={() => void startQq()}
              >
                {/* QQ Connect's standard 16 × 16 sign-in icon. */}
                <img src={qqConnectLogo} width="16" height="16" alt="" />
                <span>{qqBusy ? "正在前往 QQ…" : creating ? "使用 QQ 注册" : "使用 QQ 登录"}</span>
              </button>
              <p className="auth-qq-hint" id="auth-qq-hint">首次用 QQ 会创建账号。已有账号请先登录，再绑定 QQ。</p>
            </> : null}
          </div>
          {!qqEnabled ? <p className="auth-local-note"><Lock size={13} aria-hidden="true" /><span>账户、资料和对话只保存在这台设备上，不是云端账号。</span></p> : null}
          <p className="auth-mode-switch">
            {pendingCreation ? (
              <button type="button" onClick={() => switchMode(false)} disabled={busy}>返回登录</button>
            ) : registering ? (
              <button type="button" onClick={() => switchMode(false)} disabled={busy}>已有账号？去登录</button>
            ) : config.registration_open !== false ? (
              <button type="button" onClick={() => switchMode(true)} disabled={busy}>没有账号？创建账号</button>
            ) : null}
          </p>
        </form>
        <section className="auth-artwork" aria-label="团团，你的智能工作伙伴">
          <AuthMascot />
          <div className="auth-artwork-caption">
            <h2>从对话开始，让工作更从容。</h2>
            <p>团团，你的智能工作伙伴。</p>
          </div>
        </section>
      </div>
    </AuthGateShell>
  );
}

function isAuthFormTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("form, input, button, textarea, label, .auth-card, .auth-status-card"));
}

function suppressBackgroundDoubleClick(event: { target: EventTarget | null; preventDefault: () => void }) {
  if (isAuthFormTarget(event.target)) return;
  event.preventDefault();
}

function AuthGateShell({ status = false, children }: { status?: boolean; children: ReactNode }) {
  return (
    <main className={status ? "auth-gate auth-gate-status" : "auth-gate"} onDoubleClick={suppressBackgroundDoubleClick}>
      <h1 className="auth-wordmark">团团</h1>
      <nav className="auth-public-nav" aria-label="公共导航">
        <a href={productIntroHash}>关于 团团</a>
        <ThemeToggleButton className="auth-theme-toggle" />
      </nav>
      {children}
    </main>
  );
}

function AuthStatus({ message, alert = false, onRetry }: { message: string; alert?: boolean; onRetry?: () => void }) {
  return (
    <AuthGateShell status>
      <div className="auth-status-card">
        <p role={alert ? "alert" : undefined}>{message}</p>
        {onRetry ? <button type="button" className="auth-status-retry" onClick={onRetry}>重新连接</button> : null}
      </div>
    </AuthGateShell>
  );
}
