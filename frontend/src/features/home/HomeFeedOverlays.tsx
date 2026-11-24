import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Plus, SlidersHorizontal, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import type { FetchJson, HomePreferences, HomeReadableItem } from "./types";
import { FeedActions, validWebUrl, type OnFeedMenuAction } from "./HomeFeedCards";

type HomeDialogProps = {
  onClose: () => void;
  returnFocus: () => HTMLElement | false;
};

function HomeDialog({ title, children, onClose, returnFocus, closeDisabled = false, mode }: HomeDialogProps & {
  title: string;
  children: ReactNode;
  closeDisabled?: boolean;
  mode?: "info" | "compact";
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  return <Dialog open disablePointerDismissal={closeDisabled} onOpenChange={(open, details) => {
    if (!open) {
      if (closeDisabled) details.cancel();
      else onClose();
    }
  }}>
    <DialogContent className="home-dialog" backdropClassName="home-modal-backdrop" data-mode={mode} aria-busy={closeDisabled} initialFocus={closeButton} finalFocus={returnFocus}>
      <div className="home-dialog-head">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose ref={closeButton} className="home-icon-btn" aria-label="关闭" disabled={closeDisabled}><X size={18} aria-hidden="true" /></DialogClose>
      </div>
      {children}
    </DialogContent>
  </Dialog>;
}

export function HomeInterestDialog({ fetchJson, preferences, savePreferences, onClose, returnFocus }: HomeDialogProps & { fetchJson: FetchJson; preferences: HomePreferences; savePreferences: (preferences: HomePreferences) => Promise<void> }) {
  const [topics, setTopics] = useState(preferences.topics);
  const [repositories, setRepositories] = useState(preferences.repositories.join("\n"));
  const [digestProfile, setDigestProfile] = useState(preferences.digest_profile_id || "");
  const [curationEnabled, setCurationEnabled] = useState(preferences.curation_enabled === true);
  const [profileOptions, setProfileOptions] = useState<{ id: string; label: string }[]>([]);
  const [profilesError, setProfilesError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchJson<{ connections: { id: string; enabled: boolean }[]; profiles: { id: string; model_name: string; connection_id: string; enabled: boolean }[] }>("/agent/model-connections", { signal: controller.signal })
      .then((catalog) => setProfileOptions(catalog.profiles.filter((profile) => profile.enabled && catalog.connections.some((connection) => connection.id === profile.connection_id && connection.enabled)).map((profile) => ({ id: profile.id, label: profile.model_name }))))
      .catch(() => setProfilesError(true));
    return () => controller.abort();
  }, [fetchJson]);
  const currentMissing = Boolean(digestProfile) && !profileOptions.some((profile) => profile.id === digestProfile);
  return <HomeDialog title="兴趣设置" onClose={onClose} returnFocus={returnFocus} closeDisabled={busy}><form onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    const parsed = [...new Set(repositories.split(/[\n,，]/).map((value) => value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "")).filter(Boolean))];
    if (parsed.some((repository) => !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))) { setError("仓库格式应为 owner/repository，每行一个公开仓库。"); return; }
    if (parsed.length > 8) { setError("最多关注 8 个公开仓库。"); return; }
    if (curationEnabled && !digestProfile) { setError("请先选择日报模型，再启用每日资讯精选。"); return; }
    setBusy(true); setError(null);
    try { await savePreferences({ topics, repositories: parsed, digest_profile_id: digestProfile, ...(curationEnabled || preferences.curation_enabled !== undefined ? { curation_enabled: curationEnabled } : {}) }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "兴趣设置保存失败，请重试。"); }
    finally { setBusy(false); }
  }}><DialogDescription className="home-dialog-description">选择想关注的方向，添加公开 GitHub 仓库获取版本更新，并指定生成 AI 日报的模型。</DialogDescription><fieldset className="home-interest-topics"><legend><SlidersHorizontal size={16} />关注方向</legend><div className="home-chips">{["AI", "Agent", "MCP", "RAG", "评测", "开发工具"].map((key) => <button className={`home-chip${topics.includes(key) ? " on" : ""}`} type="button" key={key} disabled={busy} aria-pressed={topics.includes(key)} onClick={() => setTopics((current) => current.includes(key) ? current.filter((topic) => topic !== key) : [...current, key])}>{key}</button>)}</div></fieldset><label className="home-field">公开仓库<textarea rows={5} value={repositories} disabled={busy} onChange={(event) => setRepositories(event.target.value)} placeholder="例如 owner/repository，每行一个" /><span>最多 8 个公开仓库，只读取公开发布说明。清空后停止关注仓库更新。</span></label><label className="home-field">日报模型<select value={digestProfile} disabled={busy} onChange={(event) => setDigestProfile(event.target.value)}><option value="">不启用（不调用模型）</option>{currentMissing && <option value={digestProfile}>当前模型不可用，请重新选择</option>}{profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select><span>{profilesError ? "模型档案加载失败，其余设置仍可保存；请稍后重试选择日报模型。" : "每天首次打开首页时用公开资讯生成一份中文日报；未启用时不调用模型，也不产生费用。"}</span></label><div className="home-curation-setting"><label className="home-curation-optin"><input type="checkbox" checked={curationEnabled} disabled={busy} onChange={(event) => setCurationEnabled(event.target.checked)} aria-describedby="home-curation-privacy home-curation-cost" />启用每日资讯精选</label><p id="home-curation-privacy">仅发送关注方向与公开内容，不发送私人对话或文件；需要已配置的现有搜索服务，使用上方日报模型。</p><p id="home-curation-cost">每天最多 3 次搜索和 1 次文本模型调用，可能产生费用。仅在应用运行并打开首页时触发，并非全天候定时任务；重新筛选会产生新的请求。</p></div>{error && <p className="home-dialog-error" role="alert">{error}</p>}<div className="home-dialog-actions"><button className="home-btn" type="button" onClick={onClose} disabled={busy}>取消</button><button className="home-btn home-btn-primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button></div></form></HomeDialog>;
}

export function HomeLibraryDialog({ item, fetchJson, onLibraryChanged, onClose, returnFocus, onSaved }: HomeDialogProps & { item: HomeReadableItem; fetchJson: FetchJson; onLibraryChanged: () => Promise<void>; onSaved: (message: string) => void }) {
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const [url, setUrl] = useState(item.url);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <HomeDialog title="存入文件库" onClose={onClose} returnFocus={returnFocus} closeDisabled={busy}><form onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !validWebUrl(url.trim())) { setError("请填写标题和有效的 http / https 原文链接。"); return; }
    setError(null); setBusy(true);
    try {
      await fetchJson("/library/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim(), content: [summary.trim(), `原文链接：${url.trim()}`, `来源：${item.source}`, ...(item.published_at ? [`发布时间：${item.published_at}`] : [])].filter(Boolean).join("\n\n"), privacy_mode: "redacted" }) });
      try { await onLibraryChanged(); onSaved("已存入文件库"); } catch { onSaved("已存入文件库，列表刷新失败，请在文件库重新刷新"); }
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }}><DialogDescription className="home-dialog-description">确认要保存的标题、摘要和原文链接。内容会按文件库默认规则脱敏。</DialogDescription><label className="home-field">标题<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} maxLength={200} required /></label><label className="home-field">摘要<textarea value={summary} onChange={(event) => setSummary(event.target.value)} disabled={busy} rows={5} /></label><label className="home-field">原文链接<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} required /></label>{error && <p className="home-dialog-error" role="alert">{error}</p>}<div className="home-dialog-actions"><button className="home-btn" type="button" onClick={onClose} disabled={busy}>取消</button><button className="home-btn home-btn-primary" type="submit" disabled={busy}><Plus size={16} />{busy ? "保存中…" : "确认存入"}</button></div></form></HomeDialog>;
}

export function HomeBookmarksDialog({ items, busyItems, onBookmark, onMenuAction, onClose, returnFocus, mode }: HomeDialogProps & { items: HomeReadableItem[]; busyItems: Set<string>; onBookmark: (id: string) => void; onMenuAction: OnFeedMenuAction; mode: "info" | "compact" }) {
  return <HomeDialog title="我的收藏" onClose={onClose} returnFocus={returnFocus} mode={mode}><DialogDescription className="home-dialog-description">收藏保留标题、摘要与原文链接，资讯移出首页后仍可访问。</DialogDescription>{items.length ? <div className="home-bookmark-list">{items.map((item) => <article className="home-bookmark-row" key={item.id}><h3><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></h3><p>{item.summary}</p><div className="home-bookmark-foot"><span>{item.source}</span><FeedActions item={item} bookmarked busy={busyItems.has(item.id)} onBookmark={() => onBookmark(item.id)} onMenuAction={onMenuAction} /></div></article>)}</div> : <div className="home-empty"><Bookmark size={32} /><h3>还没有收藏</h3><p>阅读时点击书签，即可把值得回看的内容保存在这里。</p></div>}</HomeDialog>;
}
