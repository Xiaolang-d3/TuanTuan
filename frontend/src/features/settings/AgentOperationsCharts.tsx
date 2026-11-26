import { useEffect, useRef } from "react";
import { init, use, type ComposeOption, type EChartsType } from "echarts/core";
import { BarChart, type BarSeriesOption } from "echarts/charts";
import { DataZoomSliderComponent, GridComponent, LegendComponent, TooltipComponent, type DataZoomComponentOption, type GridComponentOption, type LegendComponentOption, type TooltipComponentOption } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { AgentOperationsSnapshot } from "../../types";
import type { ResolvedTheme } from "../appearance/ThemeProvider";

use([BarChart, GridComponent, LegendComponent, TooltipComponent, DataZoomSliderComponent, SVGRenderer]);

type Options = ComposeOption<BarSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption | DataZoomComponentOption>;
type Trend = AgentOperationsSnapshot["trend"];
type ToolBreakdown = AgentOperationsSnapshot["tool_breakdown"];

export const runStatuses = ["done", "failed", "waiting_user", "cancelled"] as const;
export const runStatusMeta = {
  done: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  waiting_user: { label: "等待确认", tone: "warning" },
  cancelled: { label: "已取消", tone: "neutral" }
} as const;

function useChart() {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = init(element, undefined, { renderer: "svg" });
    chart.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(element);
    return () => {
      resize.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  return { host, chart };
}

function readPalette(element: HTMLElement) {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    colors: runStatuses.map((status) => token(`--agent-status-${status}`)),
    accent: token("--color-brand"), muted: token("--color-text-muted"), text: token("--color-text"),
    border: token("--color-border"), surface: token("--color-surface"), subtle: token("--color-surface-subtle"),
    highlight: token("--color-brand-soft")
  };
}

function trendOptions(data: Trend, date: string | null, palette: ReturnType<typeof readPalette>): Options {
  const long = data.length > 7;
  const labels = new Map(data.map((day) => [day.date, day.label]));
  return {
    animation: false,
    color: palette.colors,
    legend: {
      top: 0, left: 0, itemWidth: 8, itemHeight: 8, itemGap: 8, icon: "roundRect",
      selectedMode: false, textStyle: { color: palette.muted, fontSize: 11 }
    },
    grid: { left: 33, right: 8, top: 38, bottom: long ? 55 : 30 },
    tooltip: {
      trigger: "axis", renderMode: "richText", confine: true,
      backgroundColor: palette.surface, borderColor: palette.border, textStyle: { color: palette.text },
      axisPointer: { type: "shadow", shadowStyle: { color: palette.highlight } }
    },
    xAxis: {
      type: "category", data: data.map((day) => day.date), axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.border } },
      axisLabel: {
        interval: long ? "auto" : 0, hideOverlap: true, showMinLabel: true, showMaxLabel: true, fontSize: 10, color: palette.muted,
        formatter: (key: string) => key === date ? `{active|${labels.get(key)}}` : labels.get(key) ?? key,
        rich: { active: { color: palette.accent, fontWeight: "bold", backgroundColor: palette.highlight, borderRadius: 3, padding: 3 } }
      }
    },
    yAxis: { type: "value", minInterval: 1, axisLabel: { color: palette.muted, fontSize: 10 }, splitLine: { lineStyle: { color: palette.border, type: "dashed" } } },
    dataZoom: long ? [{
      type: "slider", height: 19, bottom: 5, showDetail: false, showDataShadow: false, minValueSpan: 6,
      backgroundColor: palette.subtle, borderColor: palette.border, fillerColor: "rgba(57, 129, 200, 0.2)",
      handleStyle: { color: palette.surface, borderColor: palette.muted }, brushSelect: false
    }] : [],
    series: runStatuses.map((status) => ({
      type: "bar", stack: "runs", name: runStatusMeta[status].label, barMaxWidth: 24,
      emphasis: { focus: "none" },
      data: data.map((day) => day[status])
    }))
  };
}

export function RunTrendChart({ data, date, theme, onDateChange }: {
  data: Trend;
  date: string | null;
  theme: ResolvedTheme;
  onDateChange: (date: string) => void;
}) {
  const { host, chart } = useChart();
  useEffect(() => {
    const instance = chart.current;
    if (!instance || !host.current) return;
    const firstRender = !instance.getOption();
    instance.setOption(trendOptions(data, date, readPalette(host.current)));
    if (firstRender && data.length > 7) {
      instance.dispatchAction({ type: "dataZoom", startValue: Math.max(0, data.length - 10), endValue: data.length - 1 });
    }
  }, [chart, host, data, date, theme]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const zr = instance.getZr();
    const click = (event: { offsetX: number; offsetY: number }) => {
      const point = [event.offsetX, event.offsetY];
      if (!instance.containPixel({ gridIndex: 0 }, point)) return;
      const [index] = instance.convertFromPixel({ gridIndex: 0 }, point);
      const day = data[index];
      if (day) onDateChange(day.date);
    };
    zr.on("click", click);
    return () => { zr.off("click", click); };
  }, [chart, data, onDateChange]);

  return <div className="agent-echart agent-trend-chart" ref={host} role="img" aria-label="Agent 运行状态趋势，使用下方日期选择器查看和筛选按日统计" />;
}

export function ToolRankingChart({ data, theme }: { data: ToolBreakdown; theme: ResolvedTheme }) {
  const { host, chart } = useChart();
  const rows = data.slice(0, 6);
  useEffect(() => {
    if (!chart.current || !host.current) return;
    const palette = readPalette(host.current);
    const ranked = data.slice(0, 6);
    const labels = new Map(ranked.map(({ name, label }) => [name, label]));
    const options: Options = {
      animation: false,
      grid: { left: 104, right: 28, top: 9, bottom: 9 },
      tooltip: {
        trigger: "item", renderMode: "richText", confine: true, formatter: "{b}：{c} 次",
        backgroundColor: palette.surface, borderColor: palette.border, textStyle: { color: palette.text }
      },
      xAxis: { type: "value", show: false },
      yAxis: {
        type: "category", inverse: true, data: ranked.map(({ name }) => name), axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: palette.muted, fontSize: 11, width: 96, overflow: "truncate", formatter: (name: string) => labels.get(name) ?? name }
      },
      series: [{
        type: "bar", barMaxWidth: 9, itemStyle: { color: palette.accent, borderRadius: 5 },
        showBackground: true, backgroundStyle: { color: palette.subtle, borderRadius: 5 },
        label: { show: true, position: "right", color: palette.text, fontSize: 11 },
        data: ranked.map(({ label, count }) => ({ name: label, value: count }))
      }]
    };
    chart.current.setOption(options);
  }, [chart, host, data, theme]);

  return <div className="agent-echart agent-tool-chart" ref={host} role="img" aria-label={`工具使用排行：${rows.map(({ label, count }) => `${label} ${count} 次`).join("，")}`} />;
}
