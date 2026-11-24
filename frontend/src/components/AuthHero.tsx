import { useState } from "react";
import { FileText, Lightbulb, ListChecks } from "lucide-react";

const examples = [
  {
    id: "notes",
    label: "整理会议",
    source: "周会笔记",
    icon: FileText,
    prompt: "帮我把这次周会的结论整理成待办。",
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
    result: "访谈准备计划",
    items: [
      { title: "明确访谈目标，拟好访谈提纲", detail: "第 1 天" },
      { title: "筛选访谈对象，发出预约邀请", detail: "第 2 天" },
    ],
  },
] as const;

export function AuthHero() {
  const [activeId, setActiveId] = useState<(typeof examples)[number]["id"]>("notes");
  const example = activeId === "notes" ? examples[0] : examples[1];
  const SourceIcon = example.icon;
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
          {examples.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={id === activeId} aria-controls="auth-demo-preview" onClick={() => setActiveId(id)}>{label}</button>
          ))}
        </div>
        <div id="auth-demo-preview" className="auth-demo-body" aria-live="polite" aria-atomic="true">
          <div className="auth-demo-input">
            <div className="auth-demo-meta"><span>你</span><span className="auth-demo-file"><SourceIcon size={13} aria-hidden="true" />{example.source}</span></div>
            <p>{example.prompt}</p>
          </div>
          <div className="auth-demo-output">
            <h3><ListChecks size={17} aria-hidden="true" />{example.result}</h3>
            <ol role="list">
              {example.items.map(({ title, detail }) => <li key={title}><span>{title}</span><small>{detail}</small></li>)}
            </ol>
          </div>
        </div>
      </figure>
    </section>
  );
}
