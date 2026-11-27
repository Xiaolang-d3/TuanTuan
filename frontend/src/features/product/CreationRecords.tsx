import { useEffect, useState } from "react";
import { ArrowRight, FileText, History, Image, MessageCircle, Presentation } from "lucide-react";
import { ActionButton } from "../../components/ui/ActionButton";
import { creationKinds, readCreationRecords, type CreationKind, type CreationRecord, type FetchCreationJson } from "./creationRecordsApi";
import "./CreationRecords.css";

const icons = { chat: MessageCircle, image: Image, document: FileText, presentation: Presentation };
const statuses: Record<string, string> = {
  active: "进行中", archived: "已归档", queued: "排队中", running: "进行中", done: "已完成",
  succeeded: "已完成", completed: "已完成", failed: "失败", uncertain: "结果待确认",
  waiting_user: "待确认", interrupted: "已中断", cancelled: "已取消",
};
const formatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const PAGE_SIZE = 24;

type Props = {
  fetchJson: FetchCreationJson;
  onOpen: (record: CreationRecord) => void;
  onViewAll?: () => void;
  onCreate?: () => void;
};

export function CreationRecords({ fetchJson, onOpen, onViewAll, onCreate }: Props) {
  const compact = Boolean(onViewAll);
  const [kind, setKind] = useState<CreationKind>();
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<CreationRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const Heading = compact ? "h2" : "h1";
  const heading = compact ? "最近记录" : "创作记录";

  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError(false);
    readCreationRecords(fetchJson, { kind, limit: compact ? 4 : PAGE_SIZE, offset, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return;
      setItems(previous => {
        if (!offset) return page.items;
        return [...new Map([...previous, ...page.items].map(record => [`${record.kind}:${record.id}`, record])).values()];
      });
      setHasMore(page.has_more);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setPending(false);
    });
    return () => controller.abort();
  }, [attempt, compact, fetchJson, kind, offset]);

  function filter(value?: CreationKind) {
    if (value === kind) return;
    setItems([]);
    setError(false);
    setHasMore(false);
    setPending(true);
    setOffset(0);
    setKind(value);
  }

  return <section className={`creation-records${compact ? " creation-records--compact" : ""}`} aria-label={heading}>
    <header className="creation-records-heading">
      <div><Heading><History aria-hidden="true" size={18}/>{heading}</Heading>
        {!compact && <p>继续已有的对话、查看图片生成结果，或打开文档和 PPT。</p>}</div>
      {onViewAll && <ActionButton size="sm" onClick={onViewAll}>查看全部创作记录</ActionButton>}
    </header>
    {!compact && <div className="creation-records-filters" role="group" aria-label="创作类型">
      <ActionButton size="sm" aria-pressed={!kind} onClick={() => filter()}>全部</ActionButton>
      {(Object.keys(creationKinds) as CreationKind[]).map(value =>
        <ActionButton size="sm" key={value} onClick={() => filter(value)} aria-pressed={kind === value}>{creationKinds[value]}</ActionButton>)}
    </div>}
    {items.length > 0 && <ul className="creation-records-list">{items.map(record => {
      const Icon = icons[record.kind];
      const date = new Date(record.updated_at);
      const status = record.status ? statuses[record.status] : null;
      return <li key={`${record.kind}:${record.id}`}>
        <button type="button" className="creation-records-row" onClick={() => onOpen(record)}>
          <Icon size={17} aria-hidden="true"/>
          <span className="creation-records-copy"><strong>{record.title}</strong>
            <span>{creationKinds[record.kind]}{status ? ` · ${status}` : ""}
              {!Number.isNaN(date.getTime()) && <> · <time dateTime={record.updated_at}>{formatter.format(date)}</time></>}
            </span>
          </span>
          <ArrowRight size={16} aria-hidden="true"/>
        </button>
      </li>;
    })}</ul>}
    {error ? <div className="creation-records-state"><p role="alert">暂时无法读取创作记录。</p>
      <ActionButton size="sm" onClick={() => { setPending(true); setError(false); setAttempt(value => value + 1); }}>重新加载</ActionButton></div>
      : pending ? <p className="creation-records-state" role="status">正在读取创作记录…</p>
        : !items.length ? <div className="creation-records-state"><p>{kind ? "还没有这种类型的创作记录。" : "还没有创作记录。"}</p>
          {!kind && onCreate && <ActionButton size="sm" onClick={onCreate}>开始创作</ActionButton>}</div> : null}
    {!compact && hasMore && !error && <ActionButton size="sm" disabled={pending} onClick={() => {
      setPending(true);
      setOffset(previous => previous + PAGE_SIZE);
    }}>加载更多记录</ActionButton>}
  </section>;
}
