import { useEffect, useState } from "react";
import { ActionButton } from "../../components/ui/ActionButton";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import type { FetchCreationJson } from "./creationRecordsApi";
import "./TaskCenter.css";

const statuses = {
  queued: "排队中", running: "运行中", awaiting_confirmation: "待确认", completed: "已完成",
  failed: "失败", outcome_unknown: "结果待核实", cancelled: "已取消", interrupted: "已中断",
};
export type TaskCenterView = "tasks" | "notifications";
export type TaskSource = { kind: "image" | "chat"; id: string };
type TaskItem = {
  kind: string; id: string; title: string; status: keyof typeof statuses; updated_at: string;
  source: TaskSource | null; notification_key: string;
};
type TaskSnapshot = { items: TaskItem[]; has_more: boolean };
const formatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

export function TaskCenter({ view, fetchJson, onClose, onChange, onOpenSource }: {
  view: TaskCenterView; fetchJson: FetchCreationJson; onClose: () => void;
  onChange: (view: TaskCenterView) => void; onOpenSource: (source: TaskSource) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ client: FetchCreationJson; attempt: number; snapshot?: TaskSnapshot }>();
  const current = result?.client === fetchJson && result.attempt === attempt ? result : undefined;
  const snapshot = current?.snapshot;
  const title = view === "tasks" ? "任务中心" : "通知";
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<TaskSnapshot>("/task-center", { signal: controller.signal }).then(snapshot => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, attempt, snapshot });
    }, () => {
      if (!controller.signal.aborted) setResult({ client: fetchJson, attempt });
    });
    return () => controller.abort();
  }, [fetchJson, attempt]);
  const items = view === "tasks" ? snapshot?.items ?? [] : Array.from(new Map(
    (snapshot?.items ?? []).filter(item => !["queued", "running"].includes(item.status))
      .map(item => [item.notification_key, item] as const),
  ).values());

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="task-center" backdropClassName="task-center-backdrop">
      <header className="task-center-header">
        <div><DialogTitle>{title}</DialogTitle><DialogDescription>查看后台任务和图片回执。打开来源不会重新提交任务。</DialogDescription></div>
        <DialogClose className="ui-button ui-button-secondary ui-button-sm">关闭</DialogClose>
      </header>
      <div className="task-center-controls">
        <div role="group" aria-label="查看任务状态">
          <ActionButton size="sm" aria-pressed={view === "tasks"} onClick={() => onChange("tasks")}>任务</ActionButton>
          <ActionButton size="sm" aria-pressed={view === "notifications"} onClick={() => onChange("notifications")}>通知</ActionButton>
        </div>
        <ActionButton size="sm" disabled={!current} onClick={() => setAttempt(value => value + 1)}>刷新</ActionButton>
      </div>
      {!current ? <p role="status">正在读取…</p> : !snapshot ? <p role="alert">暂时无法读取任务，请刷新重试。</p> : <>
        {items.length > 0 ? <ul className="task-center-list">{items.map(item => {
          const time = new Date(item.updated_at);
          const source = item.source;
          return <li key={view === "tasks" ? `${item.kind}:${item.id}` : item.notification_key}>
            <div>
              <strong>{item.title}</strong>
              <small>{statuses[item.status] ?? "状态未识别"}{!Number.isNaN(time.getTime()) && <> · <time dateTime={item.updated_at}>{formatter.format(time)}</time></>}</small>
              {item.status === "outcome_unknown" && <p>先查看来源核实结果，团团不会自动重新提交。</p>}
            </div>
            {source && <ActionButton size="sm" aria-label={`查看来源：${item.title}`} onClick={() => onOpenSource(source)}>查看来源</ActionButton>}
          </li>;
        })}</ul> : <p>{view === "tasks" ? "还没有任务。" : "当前没有任务状态通知。"}</p>}
        {snapshot.has_more && <p>这里只显示优先处理和近期的任务。可到原工作区查看完整记录。</p>}
      </>}
    </DialogContent>
  </Dialog>;
}
