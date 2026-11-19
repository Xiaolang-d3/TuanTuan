import { useEffect, useRef } from "react";
import { ArrowRight, BookOpen, Layers, SlidersHorizontal } from "lucide-react";
import { PublicSiteFooter } from "../../components/PublicSiteFooter";
import { ProductDemo } from "./ProductDemo";
import "./product-intro.css";

export function ProductIntroPage({ returnHash, signedIn = false, showPrivacy = false }: { returnHash: string; signedIn?: boolean; showPrivacy?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const experienceRef = useRef<HTMLElement>(null);
  const workflowRef = useRef<HTMLElement>(null);
  const privacyRef = useRef<HTMLElement>(null);
  const actionLabel = signedIn ? "继续使用 团团" : "开始使用";

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "产品介绍｜团团";
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => {
    const section = showPrivacy ? privacyRef.current : headingRef.current;
    if (showPrivacy) section?.scrollIntoView?.({ behavior: "instant", block: "start" });
    section?.focus({ preventScroll: true });
  }, [showPrivacy]);

  function explore(section: HTMLElement | null) {
    section?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    section?.focus({ preventScroll: true });
  }

  return (
    <main className="product-intro-page">
      <header className="product-intro-header">
        <div className="product-intro-header-inner">
          <a className="product-intro-brand" href={returnHash} aria-label="团团 入口">
            <img src="/tuantuan-logo.png" alt="" width="36" height="36" draggable={false} />
            <span>团团</span>
          </a>
          <nav className="product-intro-nav" aria-label="产品介绍导航">
            <button type="button" onClick={() => explore(experienceRef.current)}>产品体验</button>
            <button type="button" onClick={() => explore(workflowRef.current)}>工作方式</button>
            <button type="button" onClick={() => explore(privacyRef.current)}>资料与隐私</button>
          </nav>
          <a className="product-intro-entry" href={returnHash}>{signedIn ? "返回应用" : "登录 / 注册"}</a>
        </div>
      </header>
      <section className="product-intro-hero" aria-labelledby="product-intro-title">
        <div className="product-intro-container">
          <div className="product-intro-hero-copy">
            <p className="product-intro-kicker">团团 · 智能工作伙伴</p>
            <h1 id="product-intro-title" ref={headingRef} tabIndex={-1}><span>理解你的想法，</span><span>帮你把事情做好。</span></h1>
            <p className="product-intro-description">说说你的想法，一起分析、起草和修改。需要依据时，再带入资料，让对话走向可用的成果。</p>
            <div className="product-intro-actions">
              <a className="product-intro-action" href={returnHash}>{actionLabel}<ArrowRight size={18} aria-hidden="true" /></a>
              <button className="product-intro-explore" type="button" onClick={() => explore(experienceRef.current)}>探索产品<ArrowRight size={16} aria-hidden="true" /></button>
            </div>
          </div>
          <section className="product-intro-experience" ref={experienceRef} tabIndex={-1} aria-label="产品交互演示">
            <ProductDemo returnHash={returnHash} />
            <p className="product-intro-demo-note">交互演示 · 使用示例资料，体验从提问到成果的过程</p>
          </section>
        </div>
      </section>
      <section className="product-intro-workflow product-intro-container" ref={workflowRef} tabIndex={-1} aria-labelledby="intro-workflow-title">
        <h2 id="intro-workflow-title">从一个想法，到可用的成果。</h2>
        <ol className="product-intro-steps" aria-label="使用流程">
          <li><span aria-hidden="true">01</span><div><h3>说出想法</h3><p>直接提问或描述目标，<br className="intro-desktop-break" />还没想清楚，也可以开始。</p></div></li>
          <li><span aria-hidden="true">02</span><div><h3>一起推敲</h3><p>接着上下文分析、起草和修改，<br className="intro-desktop-break" />按需结合资料与联网研究。</p></div></li>
          <li><span aria-hidden="true">03</span><div><h3>形成成果</h3><p>得到可以继续完善的文档与结论，<br className="intro-desktop-break" />将确认的信息保存下来，方便复用。</p></div></li>
        </ol>
      </section>
      <section className="product-intro-privacy" ref={privacyRef} tabIndex={-1} aria-labelledby="intro-privacy-title">
        <div className="product-intro-container">
          <p className="product-intro-kicker">让积累有价值，让使用有边界</p>
          <h2 id="intro-privacy-title">你的资料，始终由你掌握。</h2>
          <ul className="product-intro-features" aria-label="产品特点">
            <li><BookOpen size={25} aria-hidden="true" /><h3>有据可循</h3><p>结合你提供的资料完成分析与创作，通过引用回到原文。</p></li>
            <li><SlidersHorizontal size={25} aria-hidden="true" /><h3>始终可控</h3><p>自主选择模型服务与使用的资料，需要时由 AI 调用联网搜索。</p></li>
            <li><Layers size={25} aria-hidden="true" /><h3>持续积累</h3><p>本地保存资料与成果，让确认过的知识在后续任务中继续发挥作用。</p></li>
          </ul>
          <p className="product-intro-privacy-note">资料库保存在本机。使用外部模型或联网研究时，相关内容会发送至你配置的服务。</p>
          <a className="product-intro-action" href={returnHash}>{actionLabel}<ArrowRight size={18} aria-hidden="true" /></a>
        </div>
      </section>
      <PublicSiteFooter links={[{ href: returnHash, label: signedIn ? "回到工作空间" : "返回登录" }]} />
    </main>
  );
}
