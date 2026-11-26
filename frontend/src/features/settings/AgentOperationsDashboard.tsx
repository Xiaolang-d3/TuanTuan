import { useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bot, CheckCircle2, CircleAlert, Clock3, Route, Sparkles, Wrench } from "lucide-react";
import type { createApiClient } from "../../api/client";
import { ActionButton, StatusBadge } from "../../components/ui";
import type { AgentOperationsSnapshot, AgentRunStatus } from "../../types";
import type { ResolvedTheme } from "../appearance/ThemeProvider";
import { RunTrendChart, ToolRankingChart, runStatuses as statuses, runStatusMeta as statusMeta } from "./AgentOperationsCharts";
import { OPERATIONS_PAGE_SIZE, type OperationsDays, useAgentOperations } from "./useAgentOperations";
import "./agent-operations-dashboard.css";

type Props = {
  fetchJson: ReturnType<typeof createApiClient>;
  onOpenConversation: (conversationId: number, signal: AbortSignal) => Promise<boolean>;
  theme: ResolvedTheme;
};

const routeLabels: Record<string, string> = {
  conversation: "普通咨询",
  resume_review: "简历诊断",
  jd_analysis: "岗位分析",
  tailored_resume: "定制简历",
  interview_advice: "面试准备",
  company_research: "公司研究",
  public_web_search: "公开搜索"
};

function formatLatency(value: number | null) {
  if (value === null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s`;
}

function formatTokens(value: number) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
}

function formatTime(value: string | null) {
  if (!value) return "暂无记录";
  const iso = value.replace(" ", "T");
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: "UTC",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dayDescription(day: AgentOperationsSnapshot["trend"][number]) {
  return `${day.date}：${day.total} 次运行，${statuses.map((status) => `${statusMeta[status].label} ${day[status]}`).join("，")}`;
}

function RunConversation({ run, onOpenConversation }: {
  run: AgentOperationsSnapshot["recent_runs"][number];
  onOpenConversation: Props["onOpenConversation"];
}) {
  const request = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function open() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setOpening(true);
    setError("");
    try {
      const available = await onOpenConversation(run.conversation_id, controller.signal);
      if (!controller.signal.aborted && !available) setError("原对话已不可用。");
    } catch {
      if (!controller.signal.aborted) setError("暂时无法打开原对话，请重试。");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  }

  if (!run.conversation_available) return <small>原对话已不可用。</small>;
  return (
    <footer className="agent-run-actions">
      <ActionButton size="sm" icon={<ArrowUpRight size={13} aria-hidden="true" />} disabled={opening} onClick={() => void open()}>
        {opening ? "正在打开…" : "打开原对话"}
      </ActionButton>
      {error ? <small role="alert">{error}</small> : null}
    </footer>
  );
}

export function AgentOperationsDashboard({ fetchJson, onOpenConversation, theme }: Props) {
  const [days, setDays] = useState<OperationsDays>(7);
  const [status, setStatus] = useState<AgentRunStatus | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { overview, records, failed, refresh } = useAgentOperations(fetchJson, { days, status, date, page });
  const summary = overview?.summary;
  const offset = page * OPERATIONS_PAGE_SIZE;
  const filtered = !!(status || date);
  const loading = !records && !failed;

  function selectDate(next: string | null) {
    setDate(next);
    setPage(0);
  }

  return (
    <section className="settings-card agent-operations-card">
      <header className="agent-operations-heading">
        <div className="settings-card-heading">
          <span><Bot size={18} /></span>
          <div><h3>Agent 运行概览</h3><p>回看执行结果、工具调用和需要处理的异常。</p></div>
        </div>
        <div className="agent-operations-controls">
          <div className="agent-window-switch" role="group" aria-label="统计时间范围">
            {([7, 30, 90] as const).map((option) => (
              <button
                type="button"
                className={days === option ? "active" : ""}
                aria-pressed={days === option}
                key={option}
                onClick={() => { if (days !== option) { setDays(option); setDate(null); setPage(0); } }}
              >
                {option} 天
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="agent-operations-freshness">
        <Activity size={13} />
        <span>{overview ? `数据更新至 ${formatTime(overview.freshness_at)}` : failed ? "暂未读取到数据" : "正在读取 Agent 运行记录…"}</span>
        <em>本机数据 · UTC</em>
      </div>

      <div className="agent-kpi-grid">
        <article>
          <span><Activity size={14} />运行次数</span>
          <strong>{summary?.total_runs ?? "—"}</strong>
          <small>所选范围内的总数</small>
        </article>
        <article>
          <span><CheckCircle2 size={14} />Agent 完成率</span>
          <strong>{summary?.success_rate == null ? "—" : `${summary.success_rate}%`}</strong>
          <small>已完成运行 / 全部运行</small>
        </article>
        <article>
          <span><Wrench size={14} />工具调用</span>
          <strong>{summary?.total_tool_calls ?? "—"}</strong>
          <small>{summary?.average_rounds == null ? "暂无运行轮次" : `平均 ${summary.average_rounds} 轮 / 运行`}</small>
        </article>
        <article>
          <span><Clock3 size={14} />模型 P95 耗时</span>
          <strong>{formatLatency(summary?.model_p95_latency_ms ?? null)}</strong>
          <small>{summary ? `${summary.model_requests} 次同期模型请求` : "暂无请求数据"}</small>
        </article>
        <article>
          <span><Sparkles size={14} />模型 Token</span>
          <strong>{summary ? formatTokens(summary.total_tokens) : "—"}</strong>
          <small>{summary?.model_success_rate == null ? "暂无模型请求成功率" : `模型请求成功率 ${summary.model_success_rate}%`}</small>
        </article>
      </div>

      <div className="agent-status-controls" role="group" aria-label="按运行状态筛选">
        <ActionButton className="agent-status-filter" size="sm" aria-pressed={status === null} onClick={() => { setStatus(null); setPage(0); }}>
          全部 <strong>{summary?.total_runs ?? "—"}</strong>
        </ActionButton>
        {statuses.map((item) => (
          <ActionButton
            className={`agent-status-filter agent-status-dot ${item}`}
            size="sm"
            key={item}
            aria-pressed={status === item}
            onClick={() => { setStatus(status === item ? null : item); setPage(0); }}
          >
            {statusMeta[item].label} <strong>{overview?.status_breakdown.find((entry) => entry.status === item)?.count ?? (overview ? 0 : "—")}</strong>
          </ActionButton>
        ))}
      </div>

      <div className="agent-charts-grid">
        <article className="agent-chart-panel trend-panel">
          <header>
            <div><strong>运行状态趋势</strong><span>按 UTC 日期统计，点击图表或选择日期来筛选</span></div>
          </header>
          {overview ? (
            <>
              <RunTrendChart key={days} data={overview.trend} date={date} theme={theme} onDateChange={(next) => selectDate(date === next ? null : next)} />
              <label className="agent-trend-date-select">
                按日期筛选
                <select value={date ?? ""} onChange={(event) => selectDate(event.currentTarget.value || null)}>
                  <option value="">全部日期</option>
                  {overview.trend.slice().reverse().map((day) => <option key={day.date} value={day.date} aria-label={dayDescription(day)}>{day.date}</option>)}
                </select>
              </label>
            </>
          ) : <div className="agent-chart-empty">{failed ? "暂无趋势数据" : "正在读取趋势…"}</div>}
        </article>
        <article className="agent-chart-panel">
          <header>
            <div><strong>工具使用排行</strong><span>按去重后的真实工具调用计数</span></div>
          </header>
          {overview?.tool_breakdown.length ? <ToolRankingChart data={overview.tool_breakdown} theme={theme} /> : (
            <div className="agent-chart-empty">{overview ? "暂无工具调用" : failed ? "暂无排行数据" : "正在读取工具排行…"}</div>
          )}
        </article>
      </div>

      <div className="agent-run-log">
        <header>
          <div>
            <strong>运行记录</strong>
            <span>{filtered ? `筛选：${status ? statusMeta[status].label : "全部状态"}${date ? ` · ${date}（UTC）` : ""}` : "展开记录可查看目标、调用工具与错误原因"}</span>
          </div>
          <div className="agent-run-log-actions">
            {filtered ? <ActionButton size="sm" onClick={() => { setStatus(null); selectDate(null); }}>清除筛选</ActionButton> : null}
            {records ? <StatusBadge tone="info" icon={<Route size={12} />}>{records.matching_runs} 条</StatusBadge> : null}
          </div>
        </header>
        {failed ? (
          <div className="agent-run-feedback" role="alert">
            <span>{records ? "刷新失败，当前显示上一次的数据。" : "无法读取 Agent 运行记录。"}</span>
            <ActionButton size="sm" onClick={() => void refresh()}>重试</ActionButton>
          </div>
        ) : null}
        {loading ? <div className="agent-run-empty" role="status">正在读取符合条件的运行记录…</div> : null}
        {records?.recent_runs.length ? (
          <div className="agent-run-list">
            {records.recent_runs.map((run) => {
              const meta = statusMeta[run.status];
              return (
                <details key={run.id}>
                  <summary>
                    <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    <div><strong>{run.conversation_title}</strong><span>{routeLabels[run.route] || run.route}</span></div>
                    <span className="agent-run-meta">{run.tool_call_count} 个工具 · {run.rounds} 轮</span>
                    <time>{formatTime(run.created_at)}</time>
                  </summary>
                  <div className="agent-run-detail">
                    <div><span>运行目标</span><p>{run.goal}</p></div>
                    <div><span>调用工具</span><p>{run.tools.length ? run.tools.join("、") : "本轮未调用工具"}</p></div>
                    {run.error_message ? (
                      <div className="agent-run-error">
                        <span><CircleAlert size={13} />失败原因</span>
                        <p>{run.error_message}{run.error_code ? `（${run.error_code}）` : ""}</p>
                      </div>
                    ) : null}
                    <small>记录 ID {run.id} · {run.provider || "本地"} / {run.platform || "manual"}</small>
                    <RunConversation run={run} onOpenConversation={onOpenConversation} />
                  </div>
                </details>
              );
            })}
          </div>
        ) : records ? (
          <div className="agent-run-empty"><Bot size={22} /><span>{page > 0 ? "此页没有记录，可以返回上一页。" : filtered ? "没有符合当前筛选条件的运行记录。" : "这个时间范围内还没有 Agent 运行记录。"}</span></div>
        ) : null}
        {(page > 0 || (records && records.matching_runs > OPERATIONS_PAGE_SIZE)) ? (
          <nav className="agent-run-pagination" aria-label="运行记录分页">
            <ActionButton size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</ActionButton>
            <span>{records?.recent_runs.length ? `第 ${offset + 1}–${offset + records.recent_runs.length} 条，共 ${records.matching_runs} 条` : `第 ${page + 1} 页`}</span>
            <ActionButton size="sm" disabled={!records || offset + OPERATIONS_PAGE_SIZE >= records.matching_runs} onClick={() => setPage(page + 1)}>下一页</ActionButton>
          </nav>
        ) : null}
      </div>

      <footer className="agent-coverage-note">
        <CircleAlert size={13} />
        <span>模型耗时、Token 与请求成功率为同期模型请求汇总，不代表单次 Agent 运行的指标。</span>
      </footer>
    </section>
  );
}
