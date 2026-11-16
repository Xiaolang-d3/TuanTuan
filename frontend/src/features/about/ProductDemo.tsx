import { useRef, useState } from "react";
import { ArrowRight, ArrowUp, BookOpen, Check, FileText, MessageCircle, Search, Settings, UserRound } from "lucide-react";

const sourceGroups = {
  project: [
    { title: "项目计划书.pdf", type: "PDF", description: "项目背景、目标、实施路径与预期成果。", excerpt: "项目目标：把分散的研究资料整理为可复用的知识，让分析和创作能够回到真实依据。", location: "第 1–3 页" },
    { title: "行业研究报告.docx", type: "DOC", description: "行业现状、同类方案与机会分析。", excerpt: "研究关注资料整理、信息检索与内容创作之间的衔接，减少重复查找和上下文切换。", location: "研究结论" },
    { title: "用户访谈记录.md", type: "MD", description: "资料使用习惯、工作流程与实际需求。", excerpt: "访谈观察：资料分散在文档和笔记中，已有结论难以在下一次任务中直接复用。", location: "需求整理" }
  ],
  research: [
    { title: "资料整理方法.md", type: "MD", description: "整理来源、标注主题与保留引用。", excerpt: "为资料保留来源和主题。把原始内容与自己的结论区分开，便于后续核查与更新。", location: "方法笔记" },
    { title: "分析框架.pdf", type: "PDF", description: "从问题、证据到下一步行动的分析框架。", excerpt: "先明确需要回答的问题，再收集支持或反驳判断的证据，最后给出有边界的结论。", location: "第 2 页" }
  ]
};

const scenarios = [
  { title: "梳理项目亮点", prompt: "根据这些资料，帮我梳理项目亮点。", introduction: "结合项目记录，可以从以下四个方面梳理亮点：", points: [
    { title: "明确的问题定位与目标", text: "围绕资料分散、查找重复的实际问题，建立从资料到成果的完整工作流程。" },
    { title: "连贯的产品设计", text: "把资料整理、对话分析与内容生成连接起来，减少任务之间的切换。" },
    { title: "可追溯的分析依据", text: "结合项目记录、研究与访谈，让关键判断能够回到对应的资料。" },
    { title: "持续复用的知识积累", text: "将确认后的结论保留下来，为后续研究和创作提供起点。" }
  ] },
  { title: "规划下一步行动", prompt: "把项目资料整理成一份下一步行动清单。", introduction: "根据已有资料，下一步可以按以下顺序推进：", points: [
    { title: "明确本次目标", text: "梳理项目计划中的目标和边界，确定当前最需要回答的问题。" },
    { title: "补齐关键证据", text: "核查行业研究与访谈记录，标记尚需验证的假设。" },
    { title: "形成可执行方案", text: "将研究结论转化为具体任务，写明负责人、依赖与完成条件。" },
    { title: "保存确认的结论", text: "把确认后的信息沉淀到知识库，让下次任务直接从已有成果开始。" }
  ] },
  { title: "整理研究笔记", prompt: "这些研究笔记里，有哪些方法可以复用？", introduction: "可以将以下方法整理为后续任务的参考：", points: [
    { title: "从问题开始研究", text: "先写清楚要回答的问题，避免收集资料时失去方向。" },
    { title: "为结论保留依据", text: "记录关键引用和来源，把观察、推断与已确认事实区分开。" },
    { title: "让资料便于查找", text: "按照主题整理文档，保留有意义的标题与摘要。" },
    { title: "把成果带到下一次任务", text: "保存可复用的框架与结论，在新的上下文中再次核查和完善。" }
  ] }
];

type DemoView = "chat" | "library" | "settings";
type SourceGroup = keyof typeof sourceGroups;

export function ProductDemo({ returnHash }: { returnHash: string }) {
  const [view, setView] = useState<DemoView>("chat");
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [sourceGroup, setSourceGroup] = useState<SourceGroup>("project");
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const excerptRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const sourceListRef = useRef<HTMLUListElement>(null);
  const scenario = scenarios[scenarioIndex];
  const sources = sourceGroups[sourceGroup];
  const source = selectedSource === null ? null : sources[selectedSource];

  function selectScenario(index: number) {
    setScenarioIndex(index);
    setView("chat");
    setSourceGroup(index === 2 ? "research" : "project");
    setSelectedSource(null);
    window.requestAnimationFrame(() => {
      questionRef.current?.scrollIntoView({ block: "nearest" });
      questionRef.current?.focus({ preventScroll: true });
    });
  }

  function changeSourceGroup(group: SourceGroup) {
    setSourceGroup(group);
    setSelectedSource(null);
  }

  function openCitation(index: number) {
    setSourceGroup(scenarioIndex === 2 ? "research" : "project");
    setSelectedSource(index);
    window.requestAnimationFrame(() => {
      excerptRef.current?.scrollIntoView({ block: "nearest" });
      excerptRef.current?.focus({ preventScroll: true });
    });
  }

  function closeCitation() {
    sourceListRef.current?.querySelectorAll("button")[selectedSource ?? 0]?.focus();
    setSelectedSource(null);
  }

  return (
    <div className="intro-demo">
      <aside className="intro-demo-sidebar">
        <div className="intro-demo-brand"><img src="/tuantuan-logo.png" alt="" width="30" height="30" draggable={false} /><span>团团</span></div>
        <nav className="intro-demo-nav" aria-label="演示视图">
          <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}><MessageCircle size={18} aria-hidden="true" /><span>对话</span></button>
          <button type="button" aria-pressed={view === "library"} onClick={() => setView("library")}><BookOpen size={18} aria-hidden="true" /><span>资料库</span></button>
          <button type="button" aria-pressed={view === "settings"} onClick={() => setView("settings")}><Settings size={18} aria-hidden="true" /><span>设置</span></button>
        </nav>
        <div className="intro-demo-scenarios">
          <p>试试这些任务</p>
          {scenarios.map((item, index) => <button type="button" key={item.title} aria-pressed={scenarioIndex === index && view === "chat"} onClick={() => selectScenario(index)}>{item.title}</button>)}
        </div>
        <span className="intro-demo-sidebar-note">你的资料 · 你的工作空间</span>
      </aside>

      <div className="intro-demo-main" aria-live="polite">
        {view === "chat" ? <>
          <div className="intro-demo-question" ref={questionRef} tabIndex={-1} aria-label="示例问题"><UserRound className="intro-demo-avatar" size={28} aria-hidden="true" /><p>{scenario.prompt}</p></div>
          <div className="intro-demo-response">
            <img className="intro-demo-assistant" src="/tuantuan-logo.png" alt="团团" width="28" height="28" draggable={false} />
            <div className="intro-demo-answer">
              <p>{scenario.introduction}</p>
              <ol>{scenario.points.map((point) => <li key={point.title}><strong>{point.title}</strong><p>{point.text}</p></li>)}</ol>
              <div className="intro-demo-citations"><span><BookOpen size={12} aria-hidden="true" />参考资料</span><div>{sourceGroups[scenarioIndex === 2 ? "research" : "project"].map((item, index) => <button type="button" key={item.title} onClick={() => openCitation(index)} aria-label={`查看引用：${item.title}`}><FileText size={14} aria-hidden="true" /><span>{item.title}<small>{item.location}</small></span></button>)}</div></div>
            </div>
          </div>
          <button className="intro-demo-next" type="button" onClick={() => selectScenario((scenarioIndex + 1) % scenarios.length)}><span>换一个问题，看看资料如何发挥作用</span><span className="intro-demo-send"><ArrowUp size={18} aria-hidden="true" /></span></button>
        </> : view === "library" ? <div className="intro-demo-detail-view">
          <p className="intro-demo-view-eyebrow">资料库</p><h3>让有用的资料，随时可用。</h3><p>按来源整理文档与笔记，在对话中引用需要的内容。</p>
          <ul className="intro-demo-library">{Object.values(sourceGroups).flat().map((item) => <li key={item.title}><span className={`intro-demo-file-icon ${item.type.toLowerCase()}`}><FileText size={18} aria-hidden="true" /></span><div><strong>{item.title}</strong><p>{item.description}</p></div><span className="intro-demo-file-type">{item.type}</span></li>)}</ul>
          <button className="intro-demo-text-button" type="button" onClick={() => selectScenario(scenarioIndex)}>用这些资料开始对话<ArrowRight size={15} aria-hidden="true" /></button>
        </div> : <div className="intro-demo-detail-view">
          <p className="intro-demo-view-eyebrow">设置</p><h3>按你的方式，使用 AI。</h3><p>在应用中配置模型服务、资料使用与联网研究。</p>
          <ul className="intro-demo-settings"><li><Settings size={19} aria-hidden="true" /><div><strong>选择模型服务</strong><p>连接你配置的模型，按任务选择合适的服务。</p></div></li><li><Search size={19} aria-hidden="true" /><div><strong>决定是否联网研究</strong><p>根据任务需要，选择是否搜索公开网络。</p></div></li><li><Check size={19} aria-hidden="true" /><div><strong>管理自己的资料</strong><p>确认需要保留的信息，并在资料库中管理。</p></div></li></ul>
          <a className="intro-demo-text-button" href={returnHash}>进入 团团<ArrowRight size={15} aria-hidden="true" /></a>
        </div>}
      </div>

      <aside className="intro-demo-sources" aria-label="演示参考资料">
        <h3>参考资料</h3>
        <div className="intro-demo-source-groups" role="group" aria-label="资料分类"><button type="button" aria-pressed={sourceGroup === "project"} onClick={() => changeSourceGroup("project")}>项目记录 (3)</button><button type="button" aria-pressed={sourceGroup === "research"} onClick={() => changeSourceGroup("research")}>研究笔记 (2)</button></div>
        <ul ref={sourceListRef}>{sources.map((item, index) => <li key={item.title}><button type="button" aria-expanded={selectedSource === index} onClick={() => setSelectedSource(selectedSource === index ? null : index)}><span className={`intro-demo-file-icon ${item.type.toLowerCase()}`}><FileText size={17} aria-hidden="true" /></span><span><strong>{item.title}</strong><small>{item.location} · 示例资料</small><span>{item.description}</span></span></button></li>)}</ul>
        {source ? <div className="intro-demo-source-excerpt" ref={excerptRef} tabIndex={-1} aria-label="引用原文"><strong>{source.title}</strong><p>{source.excerpt}</p><button type="button" onClick={closeCitation}>收起原文</button></div> : <p className="intro-demo-source-hint">选择资料，查看原文片段。</p>}
      </aside>
    </div>
  );
}
