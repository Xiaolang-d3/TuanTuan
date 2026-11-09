import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalog } from "../../types";

type Purpose = "chat" | "image";
type Props = {
  catalog: ModelCatalog;
  busy: boolean;
  loading: boolean;
  onMutate: (path: string, method: "POST", body: Record<string, unknown>) => Promise<boolean>;
  onApplied: () => Promise<void>;
  scope?: unknown;
};

export function ModelUsageRules({ catalog, busy, loading, onMutate, onApplied, scope }: Props) {
  const owner = useMemo(() => ({}), [scope]);
  const active = useRef(owner); active.current = owner;
  const [editor, setEditor] = useState<{ purpose: Purpose; id: string; version: number } | null>(null);
  const [notice, setNotice] = useState("");
  const submitting = useRef(false);
  const defaults = catalog.purpose_defaults;
  const ready = Boolean(defaults && catalog.purpose_version !== undefined);
  const enabled = catalog.profiles.filter(profile => profile.enabled && catalog.connections.some(source => source.id === profile.connection_id && source.enabled && (source.api_key_configured || source.model_protocol === "ollama")));
  const sourceName = (connectionId: string) => catalog.connections.find(source => source.id === connectionId)?.name || "模型服务";
  useEffect(() => { setEditor(null); setNotice(""); submitting.current = false; }, [owner]);
  const eligible = (kind: Purpose) => enabled.filter(profile => profile.supported_purposes?.includes(kind));
  async function save() {
    if (!editor || busy || submitting.current) return;
    submitting.current = true;
    setNotice("");
    try {
      const saved = await onMutate(`/agent/model-defaults/${editor.purpose}`, "POST", { profile_id: editor.id || null, expected_version: editor.version });
      if (active.current !== owner) return;
      if (saved) {
        setEditor(null);
        setNotice("使用规则已保存，从后续新任务生效；正在执行的任务继续使用原配置。");
        try { await onApplied(); }
        catch { if (active.current === owner) setNotice("使用规则已保存，模型摘要尚未刷新，请重新进入设置核对。"); }
      } else setNotice("保存未确认，请重新读取并核对使用规则后再编辑。");
    } finally { if (active.current === owner) submitting.current = false; }
  }
  return <section className="settings-card model-settings-card model-usage-rules" aria-labelledby="model-usage-title">
    <div><h3 id="model-usage-title">使用规则</h3><p>从所有服务已启用的模型中，分别设置任务的默认模型。</p></div>
    {!ready && !loading ? <p role="status">默认用途尚未读取，请刷新配置；旧版后端需要更新后才能分别设置。</p> : null}
    <div className="model-purpose-list">{(["chat", "image"] as Purpose[]).map(kind => {
      const profile = catalog.profiles.find(item => item.id === defaults?.[kind]);
      const label = kind === "chat" ? "聊天与工作" : "图片生成";
      const options = eligible(kind);
      return <div className="model-usage-row" key={kind}>
        <strong>{label}</strong>
        {editor?.purpose === kind ? <div className="model-usage-editor"><label>{label}默认模型<select aria-label={`${label}默认模型`} value={editor.id} disabled={busy} onChange={event => setEditor({ ...editor, id: event.target.value })}>
          <option value="">自动选择已启用的模型</option>
          {editor.id && !options.some(item => item.id === editor.id) ? <option value={editor.id} disabled>当前模型不满足此用途，请重新选择</option> : null}
          {options.map(item => <option key={item.id} value={item.id}>{item.model_name} · {sourceName(item.connection_id)}</option>)}
        </select></label>
          {!options.length ? <small>暂无符合条件的模型，请先在服务连接中启用模型并确认能力。</small> : null}
          <div className="model-connection-actions"><button type="button" disabled={busy || Boolean(editor.id && !options.some(item => item.id === editor.id))} onClick={() => void save()}>保存{label}规则</button><button type="button" disabled={busy} onClick={() => { setEditor(null); setNotice(""); }}>取消</button></div>
        </div> : <><span className="model-usage-value">{profile ? profile.model_name : defaults?.[kind] ? "原模型不存在" : loading ? "读取中…" : "自动选择已启用的模型"}<small>{profile ? `${sourceName(profile.connection_id)}${!eligible(kind).some(item => item.id === profile.id) ? " · 请检查连接与模型状态" : ""}` : "没有合适模型时将提示配置"}</small></span><button type="button" aria-label={`更换${label}模型`} disabled={busy || !ready || editor !== null} onClick={() => { setNotice(""); setEditor({ purpose: kind, id: defaults?.[kind] || "", version: catalog.purpose_version! }); }}>更换</button></>}
      </div>;
    })}<div className="model-usage-row"><strong>视频生成</strong><span className="model-usage-value">暂未接入<small>可识别视频模型，暂不提供生成和默认设置</small></span></div></div>
    <p>任务中手动选择优先；聊天任务的阶段分工可在高级规则中单独指定。图片默认模型仅用于生图任务。</p>
    {notice ? <p role="status" className="model-connections-notice">{notice}</p> : null}
  </section>;
}
