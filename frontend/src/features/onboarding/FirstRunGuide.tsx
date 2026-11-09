import { useEffect, useRef } from "react";
import { ArrowRight, X } from "lucide-react";
import "./first-run-guide.css";

type FirstRunGuideProps = {
  onDismiss: () => void;
  onOpenModelSettings: () => void;
  onOpenLibrary: () => void;
};

/**
 * Shown once per account, before the home dashboard.
 * Its only job: let someone who has never configured a model understand what 团团 does.
 */
export function FirstRunGuide({ onDismiss, onOpenModelSettings, onOpenLibrary }: FirstRunGuideProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <div className="first-run-overlay">
      <section
        className="first-run-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        aria-describedby="first-run-subtitle"
      >
        <button className="first-run-skip" type="button" onClick={onDismiss} aria-label="跳过新手指引">
          <X size={16} aria-hidden="true" />
        </button>

        <header className="first-run-head">
          <img className="first-run-logo" src="/tuantuan-logo.png" alt="" width="44" height="44" draggable={false} />
          <p className="first-run-eyebrow">团团 · 智能工作伙伴</p>
          <h1 id="first-run-title">先接上模型，再让它开始干活</h1>
          <p className="first-run-subtitle" id="first-run-subtitle">
            团团不自带模型。接上你常用的模型服务，再给它一份资料，它就能据此回答问题，并把结论保存下来。
          </p>
        </header>

        <ol className="first-run-steps">
          <li className="first-run-step">
            <span className="first-run-step-number" aria-hidden="true">1</span>
            <h2>接上你的模型</h2>
            <p>没有模型时，对话无法开始。支持 OpenAI 兼容接口、Anthropic、Gemini，以及本机的 Ollama。</p>
            <button ref={primaryRef} className="first-run-primary" type="button" onClick={onOpenModelSettings}>
              去配置模型
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </li>

          <li className="first-run-step">
            <span className="first-run-step-number" aria-hidden="true">2</span>
            <h2>它是这么干活的</h2>
            <div className="first-run-mock" aria-hidden="true">
              <p className="first-run-mock-question">根据这些资料，帮我梳理项目亮点。</p>
              <div className="first-run-mock-answer">
                <strong>结合项目记录，可以从四个方面梳理：</strong>
                <span className="first-run-mock-cite">项目计划书.pdf</span>
                <span className="first-run-mock-cite">行业研究报告.docx</span>
                <span className="first-run-mock-cite">用户访谈记录.md</span>
              </div>
            </div>
            <p className="first-run-hint">每条结论都能回到原文，不必接受一段没有出处的回答。</p>
          </li>

          <li className="first-run-step">
            <span className="first-run-step-number" aria-hidden="true">3</span>
            <h2>资料留给下一次</h2>
            <p>标为「长期使用」的资料，之后的对话会自动检索；只存档的文件不会被带进上下文。</p>
            <button className="first-run-secondary" type="button" onClick={onOpenLibrary}>
              打开文件库
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </li>
        </ol>

        <footer className="first-run-foot">
          <button className="first-run-done" type="button" onClick={onDismiss}>先看看，开始使用</button>
          <span>之后可以在「设置 → 模型设置」完成配置</span>
        </footer>
      </section>
    </div>
  );
}
