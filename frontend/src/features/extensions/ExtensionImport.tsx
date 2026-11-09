import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, FileText, Info, Upload } from "lucide-react";
import { PreviewDialog } from "./PreviewDialog";
import { parsePlugin, parseSkill, validateMcp } from "./preview-service";
import type { ExtensionKind, ExtensionSummary, McpDraft } from "./types";

type ImportStep = "source" | "review" | "complete";

function resultOf(value: unknown): { id?: string; name?: string } {
  if (!value || typeof value !== "object") return {};
  const result = value as Record<string, unknown>;
  return { id: typeof result.id === "string" ? result.id : undefined, name: typeof result.name === "string" ? result.name : undefined };
}

export function ExtensionImport({ kind, onAdd, onClose, live = false, onImportFile, onImported }: { kind: ExtensionKind; onAdd: (content: string) => Promise<unknown>; onClose: () => void; live?: boolean; onImportFile?: (file: File) => Promise<unknown>; onImported?: (id?: string) => void }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [step, setStep] = useState<ImportStep>("source");
  const [source, setSource] = useState<"file" | "text">("file");
  const [preview, setPreview] = useState<ExtensionSummary | null>(null);
  const [completedName, setCompletedName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const isSkill = kind === "skill";
  const parse = (value: string) => isSkill ? parseSkill(value) : parsePlugin(value);

  function moveToReview() {
    setError("");
    try { setPreview(parse(content)); setStep("review"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "无法解析内容，请检查格式。"); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "source") { moveToReview(); return; }
    if (step !== "review") return;
    setReading(true);
    try {
      const result = resultOf(await onAdd(content));
      const item = preview ?? parse(content);
      onImported?.(result.id ?? item.id);
      setCompletedName(result.name ?? item.name);
      setStep("complete");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "导入失败，请检查文件。"); }
    finally { setReading(false); }
  }

  async function handleFile(file: File) {
    const zip = /\.zip$/i.test(file.name);
    if (file.size > (zip ? 2_000_000 : 100_000)) { setError(zip ? "请选择小于 2 MB 的 ZIP。" : "请选择小于 100 KB 的文件。"); return; }
    setReading(true); setError("");
    try {
      if (zip) {
        if (!live || !onImportFile) throw new Error("ZIP 导入需要连接后端");
        const result = resultOf(await onImportFile(file));
        onImported?.(result.id);
        setCompletedName(result.name || "技能包");
        setStep("complete");
      } else {
        const value = await file.text();
        setContent(value); setSource("file");
        try { setPreview(parse(value)); setStep("review"); }
        catch (caught) { setError(caught instanceof Error ? caught.message : "无法解析文件，请检查格式。"); }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "文件读取失败，请重试。"); }
    finally { setReading(false); }
  }

  const title = isSkill ? "添加技能" : "添加插件";
  const intro = isSkill ? "技能是一份可复用的工作说明。支持直接上传文件，也可以先粘贴内容试用。" : "导入 JSON 插件清单，先检查能力与权限声明。";
  return <PreviewDialog title={title} onClose={onClose}>
    <form className="extension-wizard" onSubmit={submit}>
      <div className="extension-stepper" aria-label="导入步骤"><span className={step === "source" ? "active" : "done"}><b>{step === "source" ? "1" : <Check size={12} />}</b>选择来源</span><span className={step === "review" ? "active" : step === "complete" ? "done" : ""}><b>{step === "complete" ? <Check size={12} /> : "2"}</b>检查内容</span><span className={step === "complete" ? "active" : ""}><b><Check size={12} /></b>完成</span></div>
      {step === "source" ? <>
        <div className="extension-wizard-intro"><h3>{isSkill ? "你准备好技能了吗？" : "导入插件清单"}</h3><p>{intro}</p></div>
        <div className="extension-source-options"><button type="button" className={`extension-source-option${source === "file" ? " selected" : ""}`} onClick={() => setSource("file")}><Upload size={17} /><span><strong>上传{isSkill ? "技能文件" : "清单文件"}</strong><small>{isSkill ? "选择 SKILL.md 或技能 ZIP" : "选择 JSON 插件清单"}</small></span></button><button type="button" className={`extension-source-option${source === "text" ? " selected" : ""}`} onClick={() => setSource("text")}><FileText size={17} /><span><strong>粘贴{isSkill ? "技能内容" : "JSON 内容"}</strong><small>适合快速测试一段工作方法</small></span></button></div>
        <input ref={fileInput} type="file" accept={isSkill ? ".md,.zip,text/markdown,application/zip" : ".json,application/json"} className="extension-file-input" aria-label="选择元数据文件" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleFile(file); }} />
        {source === "file" ? <div className="extension-file-drop"><span>还没有选择文件</span><button className="extension-button compact" type="button" onClick={() => fileInput.current?.click()} disabled={reading}><Upload size={14} />{reading ? "正在读取…" : "选择文件"}</button></div> : <label className="extension-wizard-field">{isSkill ? "SKILL.md 内容" : "插件清单 JSON"}<textarea required rows={8} value={content} onChange={(event) => setContent(event.target.value)} placeholder={isSkill ? "---\nname: weekly-report\ndescription: 整理每周工作\n---\n在这里编写技能指令…" : '{\n  "api_version": 1,\n  "id": "my-plugin",\n  "name": "我的插件",\n  "version": "1.0.0",\n  "description": "插件说明",\n  "permissions": []\n}'} /></label>}
        {error ? <p className="extension-error" role="alert">{error}</p> : null}<p className="extension-wizard-note"><Info size={14} />导入时只解析信息，不会立即执行指令。</p>
        <div className="extension-actions"><button type="button" className="extension-button" onClick={onClose}>取消</button><button type="submit" className="extension-button primary" disabled={reading}>{reading ? "正在读取…" : "继续检查"}</button></div>
      </> : null}
      {step === "review" ? <>
        <div className="extension-wizard-intro"><h3>确认{isSkill ? "技能" : "插件"}内容</h3><p>确认名称和说明后再导入。{isSkill ? "技能会以停用状态保存。" : "插件清单只保存声明信息。"}</p></div>
        {preview ? <div className="extension-review"><dl><dt>名称</dt><dd>{preview.name}</dd><dt>说明</dt><dd>{preview.description}</dd><dt>权限</dt><dd>{preview.permissions.length ? preview.permissions.join(" · ") : "未声明额外权限"}</dd></dl><pre>{preview.instructions || "没有附加说明。"}</pre></div> : null}
        <p className="extension-wizard-note warning"><Info size={14} />导入后默认停用。启用后，技能才会出现在聊天里的技能选择器中。</p>{error ? <p className="extension-error" role="alert">{error}</p> : null}
        <div className="extension-actions"><button type="button" className="extension-button" onClick={() => { setStep("source"); setError(""); }}><ArrowLeft size={14} />返回修改</button><button type="submit" className="extension-button primary" disabled={reading}>{reading ? "正在导入…" : `导入${isSkill ? "技能" : "插件"}`}</button></div>
      </> : null}
      {step === "complete" ? <div className="extension-import-complete"><div className="extension-complete-icon"><Check size={23} /></div><h3>{isSkill ? "技能已导入" : "插件已保存"}</h3><p>{completedName || (isSkill ? "技能" : "插件清单")}已保存到{live ? "当前账号" : "当前会话"}，目前处于停用状态。</p><div className="extension-next-steps"><div><b>1</b><span><strong>先去启用它</strong>在扩展中心打开开关。</span></div><div><b>2</b><span><strong>回到聊天使用</strong>点输入框旁的“技能”，选择它，再发送任务。</span></div></div><div className="extension-actions"><button type="button" className="extension-text-button" onClick={onClose}>查看使用说明</button><button type="button" className="extension-button primary" onClick={onClose}>去启用</button></div></div> : null}
      {step !== "complete" ? <p className="extension-footnote">{live ? "导入后默认停用，保存在当前账号；指令不会授予额外工具权限。" : "导入后默认停用，仅保存在当前会话；刷新后清空。"}</p> : null}
    </form>
  </PreviewDialog>;
}

export function McpImport({ onAdd, onClose, live = false }: { onAdd: (draft: McpDraft) => Promise<void>; onClose: () => void; live?: boolean }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpDraft["transport"]>("http");
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState("");
  return <PreviewDialog title="添加 MCP" onClose={onClose}>
    <form className="extension-form" onSubmit={async (event) => {
      event.preventDefault();
      try { await onAdd(validateMcp({ name, transport, endpoint })); onClose(); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败。"); }
    }}>
      <p className="extension-muted">先准备工具服务的连接信息。预览不会发起网络连接或启动本地进程。</p>
      <label>名称<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="例如：团队知识库" required /></label>
      <label>连接方式<select value={transport} onChange={(event) => { setTransport(event.target.value as McpDraft["transport"]); setEndpoint(""); setError(""); }}><option value="http">远程 HTTP</option><option value="stdio">本地 stdio</option></select></label>
      <label>{transport === "http" ? "服务地址" : "启动命令"}<input value={endpoint} maxLength={2000} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "http" ? "https://example.com/mcp" : "例如：npx my-mcp-server"} required /></label>
      <p className="extension-footnote">请勿填写令牌、密码或其他凭据。{live ? "草稿保存在当前账号，鉴权与连接测试尚未接入。" : "草稿仅保存在当前会话，后端接入后再配置鉴权与连接测试。"}</p>
      {error ? <p className="extension-error" role="alert">{error}</p> : null}
      <div className="extension-actions"><button type="button" className="extension-button" onClick={onClose}>取消</button><button type="submit" className="extension-button primary">保存草稿</button></div>
    </form>
  </PreviewDialog>;
}
