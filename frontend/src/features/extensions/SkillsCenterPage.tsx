import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, ImagePlus, Presentation, Settings } from "lucide-react";
import type { createApiClient } from "../../api/client";
import type { AgentCapabilities } from "../../types";
import { createImageStudioApi } from "../product/imageStudioApi";
import { studioPreviewReason, useStudioModelPreview } from "../product/StudioModelPicker";
import { useExtensionPreview } from "./ExtensionPreviewContext";
import type { ExtensionExecution } from "./extension-service";
import type { ExtensionSummary } from "./types";
import "./extensions.css";
import "./skills-center.css";

type Status = { label: string; reason?: string; available: boolean };
type Props = {
  apiBase: string;
  accessToken: string;
  fetchJson: ReturnType<typeof createApiClient>;
  capabilities: AgentCapabilities | null;
  conversationBusy: boolean;
  onOpenExtensions: () => void;
  onOpenModelSettings: (purpose: "chat" | "image") => void;
  onOpenImage: () => void;
  onOpenSkill: (id: string) => Promise<void>;
};

function unavailable(label: string, reason: string): Status {
  return { label, reason, available: false };
}

function skillStatus(skill: ExtensionSummary, catalogCurrent: boolean, execution: ExtensionExecution | null, capabilities: AgentCapabilities | null): Status {
  if (!catalogCurrent) return unavailable("待确认", "请先确认当前账号的技能状态。");
  if (skill.unavailableReason || (skill.status && skill.status !== "installed")) {
    return unavailable("依赖未就绪", skill.unavailableReason || "技能依赖尚未就绪，请在扩展中心查看。");
  }
  if (!skill.enabled) return unavailable("已停用", "请先在扩展中心启用这项技能。");
  if (skill.user_invocable === false) return unavailable("不可手动选择", "这项技能未开放手动调用，不能从技能中心打开。");
  if (skill.id === "ppt-master") {
    return execution?.available ? { label: "可使用", available: true }
      : unavailable("制作环境未就绪", execution?.reason || "尚未确认 PPT 制作环境可用。");
  }
  if (capabilities?.configured !== true) {
    return unavailable(capabilities ? "模型未配置" : "待确认", capabilities?.setup_message || (capabilities ? "请先配置可用的对话模型。" : "尚未确认对话模型可用。"));
  }
  return { label: "可使用", available: true };
}

function CapabilityCard({ name, icon, status, description, input, permission, action, busy, onOpen, remedy }: {
  name: string;
  icon: ReactNode;
  status: Status;
  description: string;
  input: string;
  permission: string;
  action: string;
  busy?: boolean;
  onOpen: () => void;
  remedy?: ReactNode;
}) {
  return <article className="skills-center-card" aria-label={name}>
    <div className="skills-center-card-heading">
      <span className="skills-center-icon" aria-hidden="true">{icon}</span>
      <h2>{name}</h2>
      <span className="extension-tag">{status.label}</span>
    </div>
    <p>{description}</p>
    <dl>
      <dt>需要提供</dt><dd>{input}</dd>
      <dt>权限与数据</dt><dd>{permission}</dd>
    </dl>
    {status.reason && <p className="skills-center-reason">{status.reason}</p>}
    <div className="skills-center-actions">
      <button className={`extension-button${status.available ? " primary" : ""}`} type="button"
        disabled={!status.available || busy} onClick={onOpen}>{action}<ArrowRight size={15} aria-hidden="true" /></button>
      {remedy}
    </div>
  </article>;
}

export function SkillsCenterPage({ apiBase, accessToken, fetchJson, capabilities, conversationBusy, onOpenExtensions, onOpenModelSettings, onOpenImage, onOpenSkill }: Props) {
  const { isPreview, error, items, execution, loading, refresh } = useExtensionPreview();
  const api = useMemo(() => createImageStudioApi(apiBase, accessToken, fetchJson), [apiBase, accessToken, fetchJson]);
  const image = useStudioModelPreview(api, !isPreview, { operation: "image.generate", profile_id: null });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [checked, setChecked] = useState<{ refresh: typeof refresh; revision: number }>();
  const [openError, setOpenError] = useState("");

  useEffect(() => {
    if (isPreview) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setChecked({ refresh, revision: catalogRevision });
    });
    return () => controller.abort();
  }, [refresh, catalogRevision, isPreview]);

  const checkingCatalog = !isPreview && (loading || checked?.refresh !== refresh || checked.revision !== catalogRevision);
  const catalogCurrent = !isPreview && !checkingCatalog && !error;
  const skills = isPreview ? [] : items.filter(item => item.kind === "skill" && item.source !== "example");
  const defaultImageReady = Boolean(image.data?.eligible && image.data.selection?.service_name && image.data.selection.sizes.length && image.data.comparison_key);
  const canChooseImage = image.data?.candidates.some(candidate => candidate.eligible);
  const imageStatus = isPreview ? unavailable("不可用", "连接团团服务并登录后，才能检查图片模型。")
    : image.loading ? unavailable("检查中", "正在确认图片模型及其权限配置。")
    : image.error ? unavailable("暂不可用", image.error)
    : defaultImageReady ? { label: "可使用", available: true }
    : canChooseImage ? { label: "需选择模型", available: true, reason: "打开后请选择一个可用的图片模型。" }
    : unavailable("模型不可用", studioPreviewReason(image.data));

  async function openSkill(id: string) {
    setOpenError("");
    try { await onOpenSkill(id); }
    catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setOpenError(caught instanceof Error ? caught.message : "暂时无法打开对话，请重试。");
      }
    }
  }

  return <div className="extensions-page skills-center">
    <header className="extensions-heading">
      <div><h1>技能中心</h1><p>查看当前账号可使用的能力。打开只进入工作区或选中技能，不会发送任务或开始生成。</p></div>
      <button type="button" className="extension-button" onClick={onOpenExtensions}><Settings size={16} aria-hidden="true" />管理扩展</button>
    </header>
    {isPreview && <p className="extension-muted">未连接执行服务，预览技能不会出现在这里。</p>}
    {checkingCatalog && <p className="extension-muted" role="status">正在检查已安装技能…</p>}
    {!checkingCatalog && !isPreview && error && <div className="extension-error" role="alert">
      <span>{error}</span><button type="button" className="extension-text-button" onClick={() => setCatalogRevision(value => value + 1)}>重新读取技能</button>
    </div>}
    {openError && <p className="extension-error" role="alert">{openError}</p>}
    <div className="skills-center-grid">
      <CapabilityCard name="图片生成" icon={<ImagePlus size={22} />} status={imageStatus}
        description="把文字描述变成图片，适合做封面、配图或视觉草稿。"
        input="图片描述、模型和该模型支持的画幅。"
        permission="你提交后，描述会发送给选定的图片模型服务。打开工作区不会提交描述或读取知识库。"
        action="打开图片工作区" onOpen={onOpenImage}
        remedy={image.error ? <button type="button" className="extension-text-button" onClick={() => image.refresh()}>重新检查图片模型</button>
          : !isPreview && !image.loading && !defaultImageReady ? <button type="button" className="extension-text-button" onClick={() => onOpenModelSettings("image")}>管理图片模型</button> : null} />
      {skills.map(skill => {
        const ppt = skill.id === "ppt-master";
        const quick = execution?.adapter === "quick-ppt";
        const status = skillStatus(skill, catalogCurrent, execution, capabilities);
        const permissions = skill.permissions.length ? `声明：${skill.permissions.join("、")}。声明不等于授权。` : "未声明额外权限。";
        const needsModel = catalogCurrent && !status.available && (ppt ? execution?.code === "model_unavailable" : status.label === "模型未配置");
        return <CapabilityCard key={skill.id} name={skill.name} icon={ppt ? <Presentation size={22} /> : <BookOpen size={22} />}
          status={status} description={skill.description}
          input={ppt ? (quick ? "主题、文字描述或当前对话上传的 DOCX、文字版 PDF、TXT、Markdown。" : "主题、受众、页数和风格。") : "在对话中说明任务和预期结果；按技能说明补充必要材料。"}
          permission={ppt && quick ? `制作时仅使用你在当前对话提交的主题和所选资料，系统提取脱敏文本。${permissions}`
            : ppt ? `制作时使用你确认的需求，依赖可用的文本模型和本机 PPT 制作环境。${permissions}`
            : `发送任务后，团团按对话流程使用该技能的说明。${permissions}`}
          action="在新对话中选择" busy={conversationBusy} onOpen={() => void openSkill(skill.id)}
          remedy={needsModel ? <button className="extension-text-button" type="button" onClick={() => onOpenModelSettings("chat")}>管理对话模型</button> : null} />;
      })}
    </div>
    {catalogCurrent && !skills.length && <p className="extension-muted">当前账号尚未安装对话技能。可前往扩展中心发现或导入技能。</p>}
  </div>;
}
