import { Camera, Check, Eye, EyeOff, LoaderCircle, Save, ShieldCheck, Sparkles, Trash2, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { createApiClient } from "../../api/client";
import type { AuthUser } from "../../components/AuthGate";
import { ActionButton } from "../../components/ui/ActionButton";
import { PasswordGuidance } from "../../components/PasswordGuidance";
import { newPasswordError, passwordLength, passwordMaxLength, passwordMinLength } from "../auth/passwordPolicy";
import { presetAvatarFile } from "./avatar-raster";
import { avatarPresets, type AvatarPreset } from "./avatar-presets";
import { PresetAvatarPicker } from "./PresetAvatarPicker";
import "./account-settings.css";

type Props = {
  apiBase: string;
  accessToken: string;
  account: AuthUser;
  avatarUrl: string | null;
  onAccountChange: (account: AuthUser) => void;
  onPasswordChanged: (token: string, account: AuthUser) => void;
};

const nameLimit = 40;
const avatarMaxBytes = 2 * 1024 * 1024;
const avatarTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function validateAvatar(file: File) {
  const typed = avatarTypes.has(file.type);
  const named = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!typed && !named) return "请选择 PNG、JPEG 或 WebP 图片";
  if (file.size > avatarMaxBytes) return "图片不能超过 2MB";
  return "";
}

export function AccountSettingsPage({
  apiBase,
  accessToken,
  account,
  avatarUrl,
  onAccountChange,
  onPasswordChanged
}: Props) {
  const fetchJson = createApiClient(apiBase, accessToken);
  const fileRef = useRef<HTMLInputElement>(null);
  const localAvatarRef = useRef<string | null>(null);
  const [displayName, setDisplayName] = useState(account.display_name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visibleFields, setVisibleFields] = useState({ current: false, next: false, confirm: false });
  const [profileBusy, setProfileBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState("");
  const [avatarNotice, setAvatarNotice] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [profileError, setProfileError] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [localAvatar, setLocalAvatar] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Which built-in avatar was applied during this visit. The account only stores
  // the resulting picture, so after a reload there is no preset to highlight.
  const [presetActiveId, setPresetActiveId] = useState<string | null>(null);
  const [presetBusyId, setPresetBusyId] = useState<string | null>(null);
  const [presetStatus, setPresetStatus] = useState<{ tone: "notice" | "error"; text: string } | null>(null);

  useEffect(() => {
    setDisplayName(account.display_name || "");
  }, [account.display_name]);

  function replaceLocalAvatar(url: string | null) {
    if (localAvatarRef.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(localAvatarRef.current);
    }
    localAvatarRef.current = url;
    setLocalAvatar(url);
  }

  useEffect(() => {
    if (!avatarUrl || !localAvatarRef.current) return;
    replaceLocalAvatar(null);
  }, [avatarUrl]);

  useEffect(() => () => {
    if (localAvatarRef.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(localAvatarRef.current);
    }
  }, []);

  useEffect(() => {
    if (!profileNotice && !avatarNotice && !passwordNotice) return;
    const timer = window.setTimeout(() => {
      setProfileNotice("");
      setAvatarNotice("");
      setPasswordNotice("");
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [profileNotice, avatarNotice, passwordNotice]);

  const savedName = (account.display_name || "").trim();
  const dirty = displayName.trim() !== savedName;
  const nameCount = displayName.trim().length;
  const preview = localAvatar || avatarUrl;
  const initial = (displayName.trim() || account.email).slice(0, 1).toUpperCase();
  const passwordReady = Boolean(
    currentPassword
    && !newPasswordError(newPassword, account.email)
    && newPassword.normalize("NFC") !== currentPassword.normalize("NFC")
    && confirmPassword
    && newPassword.normalize("NFC") === confirmPassword.normalize("NFC")
  );
  const confirmMismatch = Boolean(confirmPassword && newPassword.normalize("NFC") !== confirmPassword.normalize("NFC"));
  // A photo upload and a preset pick write the same avatar, so they serialize.
  const avatarLocked = avatarBusy || presetBusyId !== null;

  async function saveProfile(event?: FormEvent) {
    event?.preventDefault();
    if (profileBusy || !dirty) return;
    setProfileBusy(true);
    setProfileError("");
    setProfileNotice("");
    try {
      const payload = await fetchJson<{ user: AuthUser }>("/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName })
      });
      onAccountChange(payload.user);
      setProfileNotice(payload.user.display_name ? "昵称已保存" : "已恢复为使用邮箱显示");
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setProfileBusy(false);
    }
  }

  function revertName() {
    setDisplayName(account.display_name || "");
    setProfileError("");
    setProfileNotice("");
  }

  async function uploadAvatar(file: File) {
    const invalid = validateAvatar(file);
    if (invalid) {
      setAvatarError(invalid);
      setAvatarNotice("");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    replaceLocalAvatar(typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null);
    setAvatarBusy(true);
    setAvatarError("");
    setAvatarNotice("");
    setPresetStatus(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const payload = await fetchJson<{ user: AuthUser }>("/auth/me/avatar", { method: "POST", body });
      onAccountChange(payload.user);
      setPresetActiveId(null);
      setAvatarNotice("头像已更新");
    } catch (reason) {
      replaceLocalAvatar(null);
      setAvatarError(reason instanceof Error ? reason.message : "头像上传失败");
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function applyPreset(preset: AvatarPreset) {
    if (avatarBusy || presetBusyId) return;
    setPresetBusyId(preset.id);
    setPresetStatus(null);
    setAvatarError("");
    try {
      // The built-in artwork is an SVG, so it is rasterised locally and then
      // sent through the very same upload endpoint a photo would use.
      const file = await presetAvatarFile(preset);
      const body = new FormData();
      body.append("file", file);
      const payload = await fetchJson<{ user: AuthUser }>("/auth/me/avatar", { method: "POST", body });
      onAccountChange(payload.user);
      setPresetActiveId(preset.id);
      setPresetStatus({ tone: "notice", text: `已换成${preset.label}` });
    } catch (reason) {
      setPresetStatus({ tone: "error", text: reason instanceof Error ? reason.message : "头像更新失败" });
    } finally {
      setPresetBusyId(null);
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true);
    setAvatarError("");
    setAvatarNotice("");
    setPresetStatus(null);
    try {
      const payload = await fetchJson<{ user: AuthUser }>("/auth/me/avatar", { method: "DELETE" });
      replaceLocalAvatar(null);
      onAccountChange(payload.user);
      setPresetActiveId(null);
      setAvatarNotice("已移除头像");
    } catch (reason) {
      setAvatarError(reason instanceof Error ? reason.message : "头像删除失败");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (passwordBusy) return;
    if (confirmMismatch) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    const policyError = newPasswordError(newPassword, account.email);
    if (policyError) {
      setPasswordError(policyError);
      return;
    }
    if (newPassword.normalize("NFC") === currentPassword.normalize("NFC")) {
      setPasswordError("新密码不能与当前密码相同");
      return;
    }
    setPasswordBusy(true);
    setPasswordError("");
    setCurrentPasswordError("");
    setPasswordNotice("");
    try {
      const payload = await fetchJson<{ access_token: string; user: AuthUser }>("/auth/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setVisibleFields({ current: false, next: false, confirm: false });
      onPasswordChanged(payload.access_token, payload.user);
      setPasswordNotice("密码已更新，当前登录仍然有效");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "修改密码失败";
      if (message.includes("当前密码")) setCurrentPasswordError(message);
      else setPasswordError(message);
    } finally {
      setPasswordBusy(false);
    }
  }

  function toggleVisible(field: keyof typeof visibleFields) {
    setVisibleFields((current) => ({ ...current, [field]: !current[field] }));
  }

  return (
    <section className="account-settings-page">
      <header className="library-page-heading">
        <div>
          <p>昵称和头像保存在本机账户中，与资料库内容分开。</p>
        </div>
      </header>

      <form className="account-card" onSubmit={(event) => void saveProfile(event)}>
        <header className="library-foundation-heading">
          <span><UserRound size={18} /></span>
          <div>
            <h3>账号信息</h3>
            <p>点头像即可更换。改完昵称后保存，侧栏会马上更新。</p>
          </div>
        </header>
        <div className="account-identity">
          <div
            className={`account-avatar-block ${dragOver ? "is-drop" : ""} ${avatarBusy ? "is-busy" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer.files[0];
              if (file) void uploadAvatar(file);
            }}
          >
            <button
              className="account-avatar"
              type="button"
              disabled={avatarLocked}
              onClick={() => fileRef.current?.click()}
              aria-label={account.has_avatar || preview ? "更换头像" : "上传头像"}
            >
              {preview ? <img src={preview} alt="" /> : <span className="account-avatar-glyph">{initial}</span>}
              <span className="account-avatar-overlay" aria-hidden="true">
                {avatarBusy ? <LoaderCircle className="spinning" size={18} /> : <Camera size={18} />}
                <em>{avatarBusy ? "处理中" : preview ? "更换" : "上传"}</em>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={avatarLocked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadAvatar(file);
              }}
            />
            <div className="account-avatar-actions">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={avatarLocked}>
                <Camera size={15} />{preview ? "更换头像" : "上传头像"}
              </button>
              {account.has_avatar || localAvatar ? (
                <button type="button" onClick={() => void removeAvatar()} disabled={avatarLocked}>
                  <Trash2 size={15} />移除
                </button>
              ) : null}
            </div>
            <small>拖入或点击头像，支持 PNG / JPEG / WebP，最大 2MB。</small>
            {avatarError ? <p className="account-field-error" role="alert">{avatarError}</p> : null}
            {avatarNotice ? <p className="account-notice"><Check size={14} />{avatarNotice}</p> : null}
          </div>
          <div className="account-fields">
            <label htmlFor="account-display-name">
              <span>昵称</span>
              <span className="account-name-input">
                <input
                  id="account-display-name"
                  value={displayName}
                  maxLength={nameLimit}
                  placeholder="怎么称呼你"
                  autoComplete="nickname"
                  aria-label="昵称"
                  aria-invalid={Boolean(profileError)}
                  aria-describedby="account-display-name-count"
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setProfileNotice("");
                    setProfileError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && dirty) {
                      event.preventDefault();
                      revertName();
                    }
                  }}
                />
                <small id="account-display-name-count" className={nameCount >= nameLimit ? "is-limit" : undefined}>
                  {nameCount}/{nameLimit}
                </small>
              </span>
            </label>
            <p className="account-email-line">
              <span>登录邮箱</span>
              <strong>{account.email}</strong>
            </p>
            {profileError ? <p className="account-field-error" role="alert">{profileError}</p> : null}
            {profileNotice ? <p className="account-notice"><Check size={14} />{profileNotice}</p> : null}
            {dirty ? (
              <div className="account-inline-actions">
                <ActionButton variant="secondary" type="button" onClick={revertName} disabled={profileBusy}>
                  <X size={15} />取消
                </ActionButton>
                <ActionButton variant="primary" type="submit" disabled={profileBusy}>
                  {profileBusy ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}
                  {profileBusy ? "保存中…" : "保存昵称"}
                </ActionButton>
              </div>
            ) : null}
          </div>
        </div>
        <section className="account-preset-block" aria-labelledby="account-preset-title">
          <header className="account-preset-heading">
            <span><Sparkles size={16} aria-hidden="true" /></span>
            <div>
              <h4 id="account-preset-title">奶龙头像</h4>
              <small>挑一个直接换上，也可以继续用自己的照片。</small>
            </div>
          </header>
          <PresetAvatarPicker
            presets={avatarPresets}
            activeId={presetActiveId}
            busyId={presetBusyId}
            disabled={avatarLocked}
            onSelect={(preset) => void applyPreset(preset)}
          />
          {presetStatus ? (presetStatus.tone === "error"
            ? <p className="account-preset-status account-preset-error" role="alert">{presetStatus.text}</p>
            : <p className="account-preset-status" role="status"><Check size={14} aria-hidden="true" />{presetStatus.text}</p>) : null}
        </section>
      </form>

      <form className="account-card" onSubmit={(event) => void savePassword(event)} noValidate>
        <header className="library-foundation-heading">
          <span><ShieldCheck size={18} /></span>
          <div>
            <h3>修改密码</h3>
            <p>更新后其他登录会话失效，当前标签页继续使用。</p>
          </div>
        </header>
        <div className="account-password-fields">
          <label htmlFor="account-current-password">
            <span id="account-current-password-label">当前密码</span>
            <span className="account-password-input">
              <input
                id="account-current-password"
                aria-labelledby="account-current-password-label"
                type={visibleFields.current ? "text" : "password"}
                autoComplete="current-password"
                disabled={passwordBusy}
                value={currentPassword}
                aria-invalid={Boolean(currentPasswordError)}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setCurrentPasswordError("");
                  setPasswordError("");
                  setPasswordNotice("");
                }}
              />
              <button type="button" onClick={() => toggleVisible("current")} aria-label={visibleFields.current ? "隐藏当前密码" : "显示当前密码"}>
                {visibleFields.current ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            {currentPasswordError ? <small className="account-field-error" role="alert">{currentPasswordError}</small> : null}
          </label>
          <label htmlFor="account-new-password">
            <span id="account-new-password-label">新密码</span>
            <span className="account-password-input">
              <input
                id="account-new-password"
                aria-labelledby="account-new-password-label"
                type={visibleFields.next ? "text" : "password"}
                autoComplete="new-password"
                placeholder="设置新密码"
                disabled={passwordBusy}
                value={newPassword}
                aria-invalid={Boolean(newPassword && newPasswordError(newPassword, account.email))}
                aria-describedby="account-password-guidance"
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  setPasswordError("");
                  setPasswordNotice("");
                }}
              />
              <button type="button" onClick={() => toggleVisible("next")} aria-label={visibleFields.next ? "隐藏新密码" : "显示新密码"}>
                {visibleFields.next ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            <PasswordGuidance password={newPassword} email={account.email} id="account-password-guidance" />
          </label>
          <label htmlFor="account-confirm-password">
            <span id="account-confirm-password-label">确认新密码</span>
            <span className="account-password-input">
              <input
                id="account-confirm-password"
                aria-labelledby="account-confirm-password-label"
                type={visibleFields.confirm ? "text" : "password"}
                autoComplete="new-password"
                disabled={passwordBusy}
                value={confirmPassword}
                aria-invalid={confirmMismatch}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setPasswordError("");
                  setPasswordNotice("");
                }}
              />
              <button type="button" onClick={() => toggleVisible("confirm")} aria-label={visibleFields.confirm ? "隐藏确认密码" : "显示确认密码"}>
                {visibleFields.confirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            {confirmMismatch ? <small className="account-field-error" role="alert">两次输入的新密码不一致</small> : null}
          </label>
        </div>
        <ul className="account-password-hints" aria-live="polite">
          <li className={passwordLength(newPassword) >= passwordMinLength && passwordLength(newPassword) <= passwordMaxLength ? "ok" : undefined}>至少 {passwordMinLength} 个字符</li>
          <li className={newPassword && newPassword.normalize("NFC") !== currentPassword.normalize("NFC") ? "ok" : undefined}>与当前密码不同</li>
          <li className={confirmPassword && !confirmMismatch ? "ok" : undefined}>两次输入一致</li>
        </ul>
        {passwordError ? <p className="account-field-error" role="alert">{passwordError}</p> : null}
        {passwordNotice ? <p className="account-notice"><Check size={14} />{passwordNotice}</p> : null}
        <footer className="account-card-footer">
          <span>{passwordReady ? "可以更新密码" : "填完三项后即可更新"}</span>
          <ActionButton variant="primary" type="submit" disabled={passwordBusy || !passwordReady}>
            {passwordBusy ? <LoaderCircle className="spinning" size={16} /> : <Save size={16} />}
            {passwordBusy ? "更新中…" : "更新密码"}
          </ActionButton>
        </footer>
      </form>
    </section>
  );
}
