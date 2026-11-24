import { useEffect, useRef, useState } from "react";
import { ExternalLink, Search, SlidersHorizontal } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import type { HomeModelBenchmark, HomeModelBenchmarks as BenchmarkData } from "./types";
import { CHART, creatorColor, efficientFrontier, makeAxis, placeLabels } from "./benchmark-chart";
import { HomeMediaBenchmarks } from "./HomeMediaBenchmarks";
import "./model-benchmarks.css";

const SOURCE_URL = "https://artificialanalysis.ai/leaderboards/models";
const DOCS_URL = "https://artificialanalysis.ai/data-api/docs/reference";
const VIEWS = { price: "能力 × 成本", speed: "能力 × 速度", table: "全部模型明细" } as const;
const LINKS = [
  { name: "Arena", text: "用户盲测偏好", url: "https://arena.ai/leaderboard/text/pareto" },
  { name: "LiveBench", text: "推理、数学与编程", url: "https://livebench.ai/" },
  { name: "SWE-bench", text: "代码修复与 Agent 配置", url: "https://www.swebench.com/verified" },
  { name: "OpenRouter", text: "模型目录与 API 价格", url: "https://openrouter.ai/models" },
];
function number(value: number | null, prefix = "") {
  return value === null ? "未提供" : `${prefix}${value.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}
function isMeasured(value: number | null): value is number { return value !== null && Number.isFinite(value); }

function HomeLanguageBenchmarks({ data }: { data?: BenchmarkData }) {
  const [view, setView] = useState<keyof typeof VIEWS>("price");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [creator, setCreator] = useState("");
  const [showLabels, setShowLabels] = useState(true);
  const [logCost, setLogCost] = useState(true);
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(900);
  const models = data?.models || [];
  const matching = models.filter(model => (!creator || model.creator === creator) && `${model.name} ${model.creator}`.toLowerCase().includes(query.trim().toLowerCase()));
  const metric = view === "speed" ? "tokens_per_second" : "task_cost";
  const points = matching.filter(model => isMeasured(model.intelligence) && isMeasured(model[metric]));
  const selected = matching.find(model => model.id === (hoveredId || selectedId));
  const creators = Array.from(new Set(models.map(model => model.creator))).sort();
  const axis = makeAxis(points.map(model => model[metric]!), view === "price" && logCost);
  const maxY = Math.max(10, Math.ceil(Math.max(0, ...points.map(model => model.intelligence!)) / 10) * 10);
  const minY = Math.min(0, Math.floor(Math.min(0, ...points.map(model => model.intelligence!)) / 10) * 10);
  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    const update = () => { const width = node.getBoundingClientRect().width; if (width > 0) setChartWidth(Math.max(280, Math.round(width))); };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view, points.length > 0]);
  const frame = { ...CHART, width: chartWidth, height: chartWidth < 560 ? 380 : 450, left: 40, right: chartWidth - 18, top: 30, bottom: chartWidth < 560 ? 322 : 392 };
  const tickGap = frame.right - frame.left < 500 ? 68 : 62;
  const visibleTicks = axis.ticks.reduce<number[]>((ticks, tick) => {
    if (!ticks.length || (axis.position(tick) - axis.position(ticks[ticks.length - 1])) * (frame.right - frame.left) >= tickGap) ticks.push(tick);
    return ticks;
  }, []);
  const lastTick = axis.ticks[axis.ticks.length - 1];
  if (visibleTicks[visibleTicks.length - 1] !== lastTick) {
    if (visibleTicks.length > 1 && (axis.position(lastTick) - axis.position(visibleTicks[visibleTicks.length - 1])) * (frame.right - frame.left) < tickGap) visibleTicks.pop();
    visibleTicks.push(lastTick);
  }
  const plotted = points.map(model => ({ model, x: frame.left + axis.position(model[metric]!) * (frame.right - frame.left),
    y: frame.bottom - (model.intelligence! - minY) / (maxY - minY) * (frame.bottom - frame.top) }));
  const frontier = efficientFrontier(plotted, metric);
  const labels = placeLabels(plotted, frontier, hoveredId || selectedId, frame, chartWidth < 600 ? 5 : 9);
  const named = new Set(labels.map(label => label.model.id));
  const frontierIds = new Set(frontier.map(point => point.model.id));
  const plotCreators = Array.from(new Set(points.map(model => model.creator))).sort();
  const pages = Math.max(1, Math.ceil(matching.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const collected = data?.collected_at ? new Date(data.collected_at) : null;
  const timestamp = collected && Number.isFinite(collected.getTime()) ? collected.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  const emptyText = data?.status === "unconfigured" ? "尚未配置官方评测数据源，请由应用管理员配置 Artificial Analysis API Key。"
    : data?.status === "error" ? data.error || "官方评测数据暂时无法更新。"
    : data?.status === "empty" ? "官方 API 本次未返回模型数据。" : "正在同步官方评测数据…";

  return <div className="home-language-benchmarks">
    {models.length > 0 ? <>
      <div className="home-benchmark-toolbar"><div className="home-chips" role="group" aria-label="评测视图">{(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map(key => <button key={key} type="button" className={`home-benchmark-view${key === view ? " on" : ""}`} aria-pressed={key === view} onClick={() => { setView(key); setHoveredId(null); }}>{VIEWS[key]}</button>)}</div><div className="home-benchmark-tools"><label className="home-benchmark-search"><Search size={14} /><input aria-label="搜索评测模型" placeholder="搜索模型" maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setPage(0); setHoveredId(null); }} /></label><details className="home-benchmark-filter" onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}><summary role="button" aria-label="筛选与显示设置"><SlidersHorizontal size={14} /><span>筛选{creator ? " · 1" : ""}</span></summary><div className="home-benchmark-controls"><label>厂商<select aria-label="评测厂商" value={creator} onChange={event => { setCreator(event.target.value); setPage(0); setHoveredId(null); }}><option value="">全部厂商（{creators.length}）</option>{creators.map(name => <option key={name} value={name}>{name}</option>)}</select></label>{view !== "table" && <label><input type="checkbox" checked={showLabels} onChange={event => setShowLabels(event.target.checked)} />模型名称</label>}{view === "price" && <label><input type="checkbox" checked={logCost} onChange={event => setLogCost(event.target.checked)} />成本对数刻度</label>}</div></details></div></div>
      <div className="home-benchmark-meta"><span>{models.length} 个模型{query.trim() || creator ? ` · 匹配 ${matching.length} 个` : ""}{view !== "table" ? ` · 图中 ${points.length} 个` : ""}</span>{view !== "table" && <span>{view === "price" ? "左上更强、更省" : "右上更强、更快"}</span>}</div>
      {view === "table" ? <>
        <div className="home-benchmark-table-wrap"><table className="home-benchmark-table"><caption>官方 API 返回的全部模型与配置 · 单价：美元 / 百万 token；评测成本：美元 / 任务</caption><thead><tr>{["模型 / 配置", "厂商", "综合指数", "编程指数", "Agent 指数", "输入价格", "输出价格", "评测成本/任务", "token/秒", "首字延迟/秒"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{matching.slice(currentPage * 50, (currentPage + 1) * 50).map(model => <tr key={model.id}><td><a href={model.url} target="_blank" rel="noreferrer">{model.name}</a></td><td>{model.creator}</td><td>{number(model.intelligence)}</td><td>{number(model.coding)}</td><td>{number(model.agentic)}</td><td>{number(model.input_price, "$")}</td><td>{number(model.output_price, "$")}</td><td>{number(model.task_cost, "$")}</td><td>{number(model.tokens_per_second)}</td><td>{number(model.first_token_seconds)}</td></tr>)}</tbody></table></div>
        {!matching.length && <p className="home-benchmark-note">没有匹配的模型，可清空搜索查看全部。</p>}
        <div className="home-benchmark-pagination"><button className="home-btn" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage + 1} / {pages} 页 · 共 {matching.length} 个</span><button className="home-btn" type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
      </> : <>
        {points.length > 0 ? <div className="home-benchmark-chart-scroll" ref={chartRef}><svg className="home-benchmark-scatter" viewBox={`0 0 ${frame.width} ${frame.height}`} role="group" aria-label={view === "price" ? "模型能力与成本散点图" : "模型能力与速度散点图"}>
          <text x={frame.left} y="16" className="home-benchmark-axis-title">综合能力指数</text>
          <rect className="home-benchmark-attractive" x={view === "price" ? frame.left : (frame.left + frame.right) / 2} y={frame.top} width={(frame.right - frame.left) / 2} height={(frame.bottom - frame.top) / 2} />
          {Array.from({ length: 5 }, (_, index) => {
            const y = frame.bottom - index * (frame.bottom - frame.top) / 4;
            return <g key={index}><line x1={frame.left} x2={frame.right} y1={y} y2={y} className="home-benchmark-grid" /><text x={frame.left - 12} y={y + 5} textAnchor="end">{number(minY + (maxY - minY) * index / 4)}</text></g>;
          })}
          {visibleTicks.map(tick => <g key={tick}><line x1={frame.left + axis.position(tick) * (frame.right - frame.left)} x2={frame.left + axis.position(tick) * (frame.right - frame.left)} y1={frame.bottom} y2={frame.bottom + 5} className="home-benchmark-grid" /><text x={frame.left + axis.position(tick) * (frame.right - frame.left)} y={frame.bottom + 25} textAnchor="middle">{number(tick, view === "price" ? "$" : "")}</text></g>)}
          <polyline className="home-benchmark-frontier" points={frontier.map(point => `${point.x},${point.y}`).join(" ")} />
          {[...plotted].sort((a, b) => Number(named.has(a.model.id)) - Number(named.has(b.model.id))).map(({ model, x, y }) => <circle key={model.id} cx={x} cy={y} r={selected?.id === model.id ? 8 : named.has(model.id) ? 6 : 4} fill={creatorColor(model.creator)} className={`${named.has(model.id) ? "named " : "context "}${frontierIds.has(model.id) ? "efficient " : ""}${selected?.id === model.id ? "selected" : ""}`} tabIndex={0} role="button" aria-label={`查看模型：${model.name}，综合指数 ${number(model.intelligence)}，${view === "price" ? "评测任务成本 " + number(model.task_cost, "$") : "输出速度 " + number(model.tokens_per_second)}`} onMouseEnter={() => setHoveredId(model.id)} onMouseLeave={() => setHoveredId(null)} onFocus={() => setHoveredId(model.id)} onBlur={() => setHoveredId(null)} onClick={() => setSelectedId(model.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(model.id); } }}><title>{model.creator} · {model.name} · 指数 {number(model.intelligence)}</title></circle>)}
          {showLabels && labels.map(label => <g key={label.model.id} className={`home-benchmark-point-label${selected?.id === label.model.id ? " active" : ""}`} aria-hidden="true">
            <line x1={label.x} y1={label.y} x2={Math.max(label.left, Math.min(label.left + label.width, label.x))} y2={Math.max(label.top, Math.min(label.top + label.height, label.y))} />
            <rect x={label.left} y={label.top} width={label.width} height={label.height} rx="4" />
            <text x={label.left + 6} y={label.top + 16}>{label.lines.map((line, index) => <tspan key={index} x={label.left + 6} dy={index === 0 ? 0 : 16}>{line}</tspan>)}</text>
          </g>)}
          <text x={(frame.left + frame.right) / 2} y={frame.height - 15} textAnchor="middle" className="home-benchmark-axis-title">{view === "price" ? `评测任务成本：USD / 任务 · ${logCost ? "对数刻度" : "线性刻度"}` : "输出速度：token / 秒 · 线性刻度"}</text>
        </svg></div> : <p className="home-benchmark-note">当前没有具备完整指标的模型，可切换明细查看原始缺项或清空搜索。</p>}
        {selected && <div className="home-benchmark-detail" aria-live="polite"><><a href={selected.url} target="_blank" rel="noreferrer">{selected.name}<ExternalLink size={12} /></a><span>{selected.creator} · 指数 {number(selected.intelligence)} · 输入 {number(selected.input_price, "$")} / 输出 {number(selected.output_price, "$")} 每百万 token · 评测任务 {number(selected.task_cost, "$")} · {number(selected.tokens_per_second)} token/秒</span></></div>}
        <details className="home-benchmark-legend"><summary>图例 · {plotCreators.length} 家厂商</summary><div>{plotCreators.map(name => <span key={name}><i style={{ background: creatorColor(name) }} />{name}</span>)}</div></details>
      </>}
      <details className="home-benchmark-explainer"><summary>指标说明</summary><p className="home-benchmark-note">综合指数不是正确率；模型名称保留官方思考档位。成本图使用官方综合指数评测的每任务成本；输入、输出单价以美元 / 百万 token 展示。虚线按当前筛选范围计算，表示没有其它模型同时更强且更省（或更快），不代表综合推荐。任务成本受评测用量影响，不等同订阅费。图表由团团绘制，数据与评测方法来自官方。</p></details>
      {data?.status === "error" && <p className="home-digest-warning" role="status">{data.error || "更新失败"} · 继续显示上次快照</p>}
    </> : <div className="home-benchmark-empty" role="status"><p>{emptyText}</p>{data?.status === "unconfigured" && <a className="home-more-link" href={DOCS_URL} target="_blank" rel="noreferrer">申请 Key 与官方接入文档 <ExternalLink size={13} /></a>}</div>}
    <div className="home-benchmark-provenance"><a href={SOURCE_URL} target="_blank" rel="noreferrer">官方榜单 <ExternalLink size={12} /></a><a href="https://artificialanalysis.ai/methodology" target="_blank" rel="noreferrer">评测方法</a><a href={DOCS_URL} target="_blank" rel="noreferrer">Data API 文档</a><span>{timestamp ? `采集于 ${timestamp} · 每 6 小时更新` : "尚无已采集数据"}</span></div>
    <details className="home-benchmark-explainer"><summary>更多评测来源</summary><div className="home-benchmark-links">{LINKS.map(link => <a key={link.name} href={link.url} target="_blank" rel="noreferrer"><b>{link.name}<ExternalLink size={12} /></b><span>{link.text}</span></a>)}</div></details>
  </div>;
}


const CATEGORIES = { language: "语言模型", image: "图像", video: "视频", speech: "语音" } as const;
type Category = keyof typeof CATEGORIES;

export function HomeModelBenchmarks({ data }: { data?: BenchmarkData }) {
  const categories = Object.keys(CATEGORIES) as Category[];
  return <Tabs render={<section />} className="home-module home-benchmarks" aria-labelledby="home-benchmarks-title" defaultValue="language">
    <div className="home-module-head"><h2 className="home-module-title" id="home-benchmarks-title">模型评测</h2><a className="home-benchmark-source" href={SOURCE_URL} target="_blank" rel="noreferrer">Artificial Analysis <ExternalLink size={11} /></a></div>
    <TabsList className="home-benchmark-categories" aria-label="模型类别" activateOnFocus loopFocus>
      {categories.map((category) => <TabsTrigger key={category} value={category}>{CATEGORIES[category]}</TabsTrigger>)}
    </TabsList>
    {categories.map((category) => <TabsContent key={category} value={category} tabIndex={undefined}>
      {category === "language" ? <HomeLanguageBenchmarks data={data} /> : <HomeMediaBenchmarks category={category} data={data} />}
    </TabsContent>)}
  </Tabs>;
}
