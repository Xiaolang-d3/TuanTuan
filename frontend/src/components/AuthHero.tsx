import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, FileText, Lightbulb, ListChecks } from "lucide-react";

const STEP_DURATION_MS = 750;
const RESULT_DURATION_MS = 6_000;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const examples = [
  {
    id: "notes",
    label: "整理会议",
    source: "周会笔记",
    icon: FileText,
    prompt: "帮我把这次周会的结论整理成待办。",
    steps: ["读取周会笔记", "提取会议决定和后续事项", "核对待办截止时间"],
    result: "行动清单",
    items: [
      { title: "确认新版首页设计稿", detail: "周三前" },
      { title: "汇总首轮试用反馈", detail: "周五前" },
    ],
  },
  {
    id: "plan",
    label: "拆解计划",
    source: "一个想法",
    icon: Lightbulb,
    prompt: "想做一轮用户访谈，帮我列出准备步骤。",
    steps: ["明确用户访谈的目标", "梳理访谈前需要准备的事项", "按先后顺序安排准备步骤"],
    result: "访谈准备计划",
    items: [
      { title: "明确访谈目标，拟好访谈提纲", detail: "第 1 天" },
      { title: "筛选访谈对象，发出预约邀请", detail: "第 2 天" },
    ],
  },
] as const;

export function AuthHero() {
  const [activeId, setActiveId] = useState<(typeof examples)[number]["id"]>("notes");
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.(REDUCED_MOTION)?.matches ?? false);
  const example = activeId === "notes" ? examples[0] : examples[1];
  const SourceIcon = example.icon;
  const stepCount = example.steps.length;
  const [step, setStep] = useState(reducedMotion ? stepCount : 0);
  const complete = step === stepCount;

  useEffect(() => {
    const preference = window.matchMedia?.(REDUCED_MOTION);
    const update = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      if (event.matches) setStep(stepCount);
    };
    preference?.addEventListener("change", update);
    return () => preference?.removeEventListener("change", update);
  }, [stepCount]);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(
      () => setStep(complete ? 0 : step + 1),
      complete ? RESULT_DURATION_MS : STEP_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeId, complete, reducedMotion, step]);

  return (
    <section className="auth-hero" aria-labelledby="auth-hero-title">
      <div className="auth-hero-cover">
        <div className="auth-hero-copy">
          <p className="auth-eyebrow"><i aria-hidden="true" />智能工作伙伴</p>
          <h2 id="auth-hero-title">把想法，<br /><span>变成行动。</span></h2>
          <p className="auth-hero-intro">整理笔记、拆解计划，从一段对话开始。</p>
        </div>
        <div className="auth-hero-art">
          <img className="auth-hero-mascot" src="/auth-companion-cutout.webp" alt="团团在桌前举着对话气泡，陪你开始工作" width={1448} height={1086} loading="lazy" draggable={false} />
        </div>
      </div>
      <figure className="auth-demo">
        <figcaption><span><i aria-hidden="true" />对话示例</span></figcaption>
        <div className="auth-demo-switch" role="group" aria-label="选择对话示例">
          {examples.map(({ id, label, steps }) => (
            <button key={id} type="button" aria-pressed={id === activeId} aria-controls="auth-demo-preview" onClick={() => {
              if (id === activeId) return;
              setActiveId(id);
              setStep(reducedMotion ? steps.length : 0);
            }}>{label}</button>
          ))}
        </div>
        <div id="auth-demo-preview" className="auth-demo-body">
          <div className="auth-demo-input">
            <div className="auth-demo-meta"><span>你</span><span className="auth-demo-file"><SourceIcon size={13} aria-hidden="true" />{example.source}</span></div>
            <p>{example.prompt}</p>
          </div>
          <div className="auth-demo-execution">
            <div className="auth-demo-execution-header">
              <h3>团团的执行记录</h3>
              <span className="auth-demo-status">{complete ? "已完成" : "执行中"}</span>
            </div>
            <ol className="auth-demo-steps" role="list" aria-label="执行步骤">
              {example.steps.map((label, index) => {
                const done = complete || index < step;
                const current = !complete && index === step;
                const StepIcon = done ? Check : current ? ChevronRight : Circle;
                return (
                  <li key={label} data-state={done ? "done" : current ? "current" : "pending"} aria-current={current ? "step" : undefined}>
                    <span className="auth-demo-step-icon"><StepIcon size={11} aria-hidden="true" /></span>
                    <span>{label}</span>
                    <small>{done ? "已完成" : current ? "进行中" : "待执行"}</small>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="auth-demo-result" data-ready={complete}>
            {!complete && <p className="auth-demo-result-pending"><ListChecks size={17} aria-hidden="true" />执行完成后在这里显示结果</p>}
            <div className="auth-demo-output" aria-hidden={!complete}>
              <h3><ListChecks size={17} aria-hidden="true" />{example.result}</h3>
              <ol role="list">
                {example.items.map(({ title, detail }) => <li key={title}><span>{title}</span><small>{detail}</small></li>)}
              </ol>
            </div>
          </div>
        </div>
      </figure>
    </section>
  );
}
