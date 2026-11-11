import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ModelConnection, ModelProtocol } from "../../types";
import { PROTOCOL_LABELS } from "./protocolLabels";

type Props = {
  connection?: ModelConnection; currentConnection?: ModelConnection; connections?: ModelConnection[]; busy: boolean; secretWritable?: boolean;
  onCancel: () => void; onSave: (body: Record<string, unknown>) => Promise<boolean>;
};
const address = (value: string) => value.trim().replace(/\/+$/, "");
export function UnifiedConnectionEditor({ connection, currentConnection, connections = [], busy, secretWritable, onCancel, onSave }: Props) {
  const [baseUrl, setBaseUrl] = useState(connection?.model_base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState(connection?.name ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(connection?.model_protocol ?? "auto");
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState<"baseUrl" | "apiKey" | null>(null);
  const errorId = useId();
  const baseUrlInput = useRef<HTMLInputElement>(null);
  const apiKeyInput = useRef<HTMLInputElement>(null);
  const [discard, setDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => { alive.current = true; root.current?.querySelector("input")?.focus(); return () => { alive.current = false; }; }, []);
  const dirty = Boolean(apiKey || baseUrl !== (connection?.model_base_url ?? "") || name !== (connection?.name ?? "") || protocol !== (connection?.model_protocol ?? "auto"));
  const outdated = Boolean(connection && currentConnection?.revision !== connection.revision);
  const locked = busy || saving || outdated;
  const duplicates = !connection && baseUrl.trim() ? connections.filter(item => address(item.model_base_url) === address(baseUrl)) : [];
  function cancel() { if (dirty) setDiscard(true); else onCancel(); }
  function validationError(field: "baseUrl" | "apiKey", message: string) {
    setError(message);
    setInvalidField(field);
    (field === "baseUrl" ? baseUrlInput : apiKeyInput).current?.focus();
  }
  function clearValidationError() { setError(""); setInvalidField(null); }
  async function save() {
    if (locked) return;
    let parsed: URL;
    try { parsed = new URL(baseUrl.trim()); if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(); }
    catch { validationError("baseUrl", "Base URL 需要完整的 http:// 或 https:// 地址，不包含账号、密码、查询参数或片段。"); return; }
    const optional = protocol === "ollama" || protocol === "auto" && /ollama|:11434(?:\/|$)/i.test(baseUrl);
    if (!optional && !apiKey.trim() && (!connection?.api_key_configured || address(baseUrl) !== address(connection.model_base_url))) { validationError("apiKey", "新增服务或修改地址后，请重新填写 API Key。"); return; }
    if (secretWritable === false && apiKey.trim()) { validationError("apiKey", "当前密钥存储不可写，请恢复安全存储后重试。"); return; }
    clearValidationError(); setSaving(true);
    setApiKey("");
    try {
      const success = await onSave({ name: name.trim() || parsed.hostname, model_base_url: address(baseUrl), model_protocol: protocol, api_key: apiKey.trim(), ...(connection ? { expected_revision: connection.revision } : {}) });
      if (!success && alive.current) setError("未确认保存，API Key 已清除。请核对配置后重新填写。");
    } catch { if (alive.current) setError("保存失败，API Key 已清除。请重新填写后重试。"); }
    finally { if (alive.current) setSaving(false); }
  }
  return <section className="unified-connection-editor" aria-label={connection ? "编辑服务" : "添加服务"}>
    <div className="unified-directory-heading"><div><h3>{connection ? "编辑服务" : "添加服务"}</h3><p>填写服务商提供的地址和密钥。名称与接口可保持自动。</p></div></div>
    <form ref={root} aria-label={connection ? "编辑服务" : "添加服务"} onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
      <div className="unified-connection-fields"><label>Base URL<input ref={baseUrlInput} aria-label="Base URL" aria-invalid={invalidField === "baseUrl" || undefined} aria-describedby={invalidField === "baseUrl" ? errorId : `${errorId}-address-help`} type="text" value={baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} disabled={locked} onChange={event => { setBaseUrl(event.target.value); clearValidationError(); }} /><small id={`${errorId}-address-help`}>填写完整 API 地址，保留服务商要求的 /v1 等路径。</small></label><label>API Key<span className="unified-key-input"><input ref={apiKeyInput} aria-label="API Key" aria-invalid={invalidField === "apiKey" || undefined} aria-describedby={invalidField === "apiKey" ? errorId : `${errorId}-key-help`} type={showKey ? "text" : "password"} value={apiKey} placeholder={connection?.api_key_configured ? "已安全保存，留空继续使用" : "服务商提供的密钥"} autoComplete="new-password" disabled={locked} readOnly={secretWritable === false} onChange={event => { setApiKey(event.target.value); clearValidationError(); }} /><button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showKey} disabled={locked || !apiKey} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small id={`${errorId}-key-help`}>本地 Ollama 可留空；其他服务填写对应的访问密钥。</small></label></div>
      {duplicates.length ? <p role="status" className="unified-duplicate">已有相同地址的服务：{duplicates.map(item => item.name || "模型服务").join("、")}。更新配置请取消后编辑已有服务；使用不同账号时可继续添加，并设置不同的服务名称。</p> : null}
      <details><summary>名称与接口（可选）</summary><div className="unified-connection-fields"><label>服务名称<input aria-label="服务名称" value={name} disabled={locked} placeholder="自动使用地址名称" onChange={event => setName(event.target.value)} /></label><label>接口协议<select aria-label="接口协议" value={protocol} disabled={locked} onChange={event => { setProtocol(event.target.value as ModelProtocol); clearValidationError(); }}><option value="auto">自动匹配</option>{Object.entries(PROTOCOL_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div></details>
      {outdated ? <p role="alert">此服务已更新，请取消后重新编辑最新配置。</p> : error ? <p id={errorId} role="alert">{error}</p> : null}
      {secretWritable === false ? <p>当前安全存储不可写，已有密钥仍保持原状。</p> : null}
      {discard ? <div className="unified-discard" role="alert"><p>放弃未保存的修改？输入的 API Key 将被清除。</p><button type="button" disabled={saving} onClick={onCancel}>放弃修改</button><button type="button" onClick={() => setDiscard(false)}>继续编辑</button></div> : null}
      <div className="unified-actions"><button type="submit" className="unified-primary" disabled={locked}>{saving ? "保存中…" : connection ? "保存服务" : "保存并获取模型"}</button><button type="button" disabled={busy || saving} onClick={cancel}>取消</button></div>
    </form>
  </section>;
}
