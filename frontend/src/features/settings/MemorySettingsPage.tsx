import { useEffect, useState } from "react";
import { Brain, ListChecks, Pencil, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { ApiError, type createApiClient } from "../../api/client";
import { Switch } from "../../components/ui/Switch";
import type { AgentSettings, MemoryOverview, MemoryRule, MemorySummary } from "../../types";
import "./memory-settings-page.css";

const RULE_MAX_LENGTH = 300;
const ITEMS_PER_PAGE = 10;

type Props = {
  fetchJson: ReturnType<typeof createApiClient>;
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function ToggleSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <Switch.Root checked={checked} aria-label={label} disabled={disabled} onCheckedChange={onChange}>
      <span className="memory-switch-track"><Switch.Thumb className="memory-switch-thumb" /></span>
      <span>{checked ? "已开启" : "已关闭"}</span>
    </Switch.Root>
  );
}

export function MemorySettingsPage({ fetchJson }: Props) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [itemPage, setItemPage] = useState(0);
  const [newRule, setNewRule] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [memoryResult, settingsResult] = await Promise.allSettled([
        fetchJson<MemoryOverview>("/memory"),
        fetchJson<AgentSettings>("/agent/settings")
      ]);
      if (!alive) return;
      if (memoryResult.status === "fulfilled") setOverview(memoryResult.value);
      else setError(errorMessage(memoryResult.reason, "读取记忆数据失败"));
      if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
      else if (memoryResult.status === "fulfilled") setError("读取设置失败，开关暂不可用");
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [fetchJson]);

  async function reloadSettings() {
    try {
      const latest = await fetchJson<AgentSettings>("/agent/settings");
      setSettings(latest);
    } catch (reason) {
      setError(errorMessage(reason, "重新读取设置失败"));
    }
  }

  const enabled = settings?.user_memory_enabled ?? overview?.enabled ?? true;

  async function toggleEnabled(next: boolean) {
    if (!settings || busy) return;
    const previous = settings;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await fetchJson<AgentSettings>("/agent/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...previous, user_memory_enabled: next, expected_revision: previous.config_revision })
      });
      setSettings(saved);
      setNotice(next ? "已开启跨会话记忆：团团会在相关对话中自动引用记住的内容。" : "已关闭跨会话记忆：不再抽取新记忆，也不在对话中注入；已有记忆保留在本机。");
    } catch (reason) {
      await reloadSettings();
      if (reason instanceof ApiError && reason.status === 409) {
        setError("设置已在其他页面更新，请重新查看后再试。");
      } else {
        setError(errorMessage(reason, "保存开关失败"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: MemorySummary) {
    if (!overview || busy) return;
    const previous = overview;
    setOverview({ ...previous, items: previous.items.filter((entry) => entry.id !== item.id) });
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fetchJson<{ deleted: boolean }>(`/memory/items/${item.id}`, { method: "DELETE" });
      setNotice("已删除一条记忆。");
    } catch (reason) {
      setOverview(previous);
      setError(errorMessage(reason, "删除记忆失败"));
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const rule = newRule.trim();
    if (!rule || !overview || busy) return;
    if (rule.length > RULE_MAX_LENGTH) {
      setError(`规则最多 ${RULE_MAX_LENGTH} 字`);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fetchJson<MemoryRule>("/memory/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule })
      });
      const refreshed = await fetchJson<{ rules: MemoryRule[] }>("/memory/rules");
      setOverview((current) => current ? { ...current, rules: refreshed.rules } : current);
      setNewRule("");
      setNotice("规则已添加，会在之后的对话中始终生效。");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setError("规则数量已达上限，请先删除不需要的规则。");
      } else {
        setError(errorMessage(reason, "添加规则失败"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(entry: MemoryRule) {
    const rule = editingText.trim();
    if (!rule || !overview || busy) return;
    if (rule.length > RULE_MAX_LENGTH) {
      setError(`规则最多 ${RULE_MAX_LENGTH} 字`);
      return;
    }
    const previous = overview;
    setOverview({ ...previous, rules: previous.rules.map((current) => current.id === entry.id ? { ...current, rule } : current) });
    setEditingId(null);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fetchJson<MemoryRule>(`/memory/rules/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule })
      });
      setNotice("规则已更新。");
    } catch (reason) {
      setOverview(previous);
      setError(errorMessage(reason, "更新规则失败"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(entry: MemoryRule, next: boolean) {
    if (!overview || busy) return;
    const previous = overview;
    setOverview({ ...previous, rules: previous.rules.map((current) => current.id === entry.id ? { ...current, enabled: next } : current) });
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fetchJson<MemoryRule>(`/memory/rules/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next })
      });
      setNotice(next ? "规则已启用。" : "规则已停用。");
    } catch (reason) {
      setOverview(previous);
      setError(errorMessage(reason, "更新规则失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(entry: MemoryRule) {
    if (!overview || busy) return;
    const previous = overview;
    setOverview({ ...previous, rules: previous.rules.filter((current) => current.id !== entry.id) });
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fetchJson<{ deleted: boolean }>(`/memory/rules/${entry.id}`, { method: "DELETE" });
      setNotice("规则已删除。");
    } catch (reason) {
      setOverview(previous);
      setError(errorMessage(reason, "删除规则失败"));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!overview || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fetchJson<{ cleared_items: number; cleared_rules: number }>("/memory", { method: "DELETE" });
      setOverview((current) => current ? { ...current, items: [], rules: [] } : current);
      setItemPage(0);
      setConfirmClear(false);
      setNotice(`已清除 ${result.cleared_items} 条记忆与 ${result.cleared_rules} 条规则。开关保持不变。`);
    } catch (reason) {
      setError(errorMessage(reason, "清除记忆失败"));
    } finally {
      setBusy(false);
    }
  }

  const items = overview?.items ?? [];
  const rules = overview?.rules ?? [];
  const pageCount = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const safePage = Math.min(itemPage, pageCount - 1);
  const visibleItems = items.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  return (
    <section className="memory-settings" aria-labelledby="memory-title">
      <header>
        <Brain size={28} aria-hidden="true" />
        <div>
          <h2 id="memory-title">记忆与个性化</h2>
          <p>团团会把你在对话中提到的事实与偏好保存在本机，之后的相关对话会自动引用。所有记忆仅存于你的设备，可随时关闭或清除。</p>
        </div>
      </header>

      {loading ? <p role="status">正在读取记忆数据…</p> : null}
      {!loading && error ? <p role="alert">{error}</p> : null}
      {!loading && notice ? <p role="status">{notice}</p> : null}

      {!loading ? (
        <>
          <section className="settings-card memory-toggle-card" aria-labelledby="memory-toggle-title">
            <div className="memory-toggle-row">
              <div>
                <h3 id="memory-toggle-title">跨会话记忆</h3>
                <p>开启后，团团会从对话中自动提取事实与偏好，并在相关的新对话中引用；关闭后不再抽取与注入，已有记忆保留在本地。</p>
              </div>
              <ToggleSwitch checked={enabled} disabled={busy || !settings} label="跨会话记忆" onChange={(next) => void toggleEnabled(next)} />
            </div>
            {!settings ? <p className="memory-hint">开关设置读取失败，暂时无法切换。刷新页面可重试。</p> : null}
          </section>

          <section className="settings-card memory-items-card" aria-labelledby="memory-items-title">
            <div className="settings-card-heading">
              <span><Sparkles size={17} aria-hidden="true" /></span>
              <div>
                <h3 id="memory-items-title">已记住的内容</h3>
                <p>来自对话的自动抽取，共 {items.length} 条。删除后立即生效。</p>
              </div>
            </div>
            {items.length === 0 ? (
              <p className="memory-empty">还没有记住任何内容。多聊几次，团团会逐渐记住你的事实与偏好。</p>
            ) : (
              <ul className="memory-list">
                {visibleItems.map((item) => (
                  <li className="memory-item" key={item.id}>
                    <div className="memory-item-main">
                      <span className={`memory-kind ${item.kind}`}>{item.kind === "fact" ? "事实" : "偏好"}</span>
                      <p className="memory-item-summary">{item.summary}</p>
                      <span className="memory-item-meta">
                        {item.source_conversation_id ? `来自对话 #${item.source_conversation_id} · ` : ""}更新于 {formatDateTime(item.updated_at)}
                      </span>
                    </div>
                    <button type="button" className="memory-icon-button" aria-label={`删除记忆：${item.summary}`} title="删除" disabled={busy} onClick={() => void removeItem(item)}>
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pageCount > 1 ? (
              <div className="memory-pagination">
                <button type="button" disabled={safePage === 0 || busy} onClick={() => setItemPage(safePage - 1)}>上一页</button>
                <span>第 {safePage + 1} / {pageCount} 页</span>
                <button type="button" disabled={safePage >= pageCount - 1 || busy} onClick={() => setItemPage(safePage + 1)}>下一页</button>
              </div>
            ) : null}
          </section>

          <section className="settings-card memory-rules-card" aria-labelledby="memory-rules-title">
            <div className="settings-card-heading">
              <span><ListChecks size={17} aria-hidden="true" /></span>
              <div>
                <h3 id="memory-rules-title">显式规则</h3>
                <p>你手动写下的规则会完整注入相关对话，优先级高于自动记忆。共 {rules.length} 条。</p>
              </div>
            </div>
            <form className="memory-rule-form" onSubmit={(event) => { event.preventDefault(); void addRule(); }}>
              <input
                value={newRule}
                onChange={(event) => setNewRule(event.target.value)}
                placeholder="例如：回答时默认使用中文"
                aria-label="新规则"
                maxLength={RULE_MAX_LENGTH}
                disabled={busy}
              />
              <button type="submit" disabled={busy || !newRule.trim()}>添加规则</button>
            </form>
            {rules.length === 0 ? (
              <p className="memory-empty">还没有显式规则。</p>
            ) : (
              <ul className="memory-rule-list">
                {rules.map((rule) => (
                  <li className="memory-rule" key={rule.id}>
                    {editingId === rule.id ? (
                      <form className="memory-rule-edit" onSubmit={(event) => { event.preventDefault(); void saveRule(rule); }}>
                        <input
                          value={editingText}
                          onChange={(event) => setEditingText(event.target.value)}
                          aria-label="编辑规则内容"
                          maxLength={RULE_MAX_LENGTH}
                          autoFocus
                          disabled={busy}
                        />
                        <button type="submit" disabled={busy || !editingText.trim()}>保存</button>
                        <button type="button" disabled={busy} onClick={() => setEditingId(null)}>取消</button>
                      </form>
                    ) : (
                      <>
                        <p className="memory-rule-text">{rule.rule}</p>
                        <div className="memory-rule-actions">
                          <Switch.Root
                            checked={rule.enabled}
                            aria-label={`规则「${rule.rule}」${rule.enabled ? "停用" : "启用"}`}
                            title={rule.enabled ? "停用" : "启用"}
                            disabled={busy}
                            onCheckedChange={(next) => void toggleRule(rule, next)}
                          >
                            {rule.enabled ? "已启用" : "已停用"}
                          </Switch.Root>
                          <button type="button" className="memory-icon-button" aria-label={`编辑规则：${rule.rule}`} title="编辑" disabled={busy} onClick={() => { setEditingId(rule.id); setEditingText(rule.rule); }}>
                            <Pencil size={15} aria-hidden="true" />
                          </button>
                          <button type="button" className="memory-icon-button" aria-label={`删除规则：${rule.rule}`} title="删除" disabled={busy} onClick={() => void removeRule(rule)}>
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="settings-card memory-privacy-card" aria-labelledby="memory-privacy-title">
            <div className="settings-card-heading">
              <span><ShieldCheck size={17} aria-hidden="true" /></span>
              <div><h3 id="memory-privacy-title">隐私说明</h3></div>
            </div>
            <p>记忆只保存在你本机的数据库中，不会发送给第三方；敏感信息在写入前会自动脱敏。关闭开关后，新的对话不再使用这些记忆。</p>
            {confirmClear ? (
              <div className="memory-clear-confirm" role="group" aria-label="确认清除记忆">
                <p>确定要清除全部 {items.length} 条记忆与 {rules.length} 条规则吗？此操作不可撤销。</p>
                <div className="memory-clear-actions">
                  <button type="button" className="memory-danger-button" disabled={busy} onClick={() => void clearAll()}>确认清除</button>
                  <button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
                </div>
              </div>
            ) : (
              <div className="memory-clear-actions">
                <button type="button" className="memory-danger-button" disabled={busy || (items.length === 0 && rules.length === 0)} onClick={() => setConfirmClear(true)}>清除全部记忆与规则</button>
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
