import type { ReactNode } from "react";
import {
  ArrowLeft,
  Blocks,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Folder,
  Info,
  KeyRound,
  MessageCircle,
  Palette,
  TriangleAlert
} from "lucide-react";
import type { LibraryEditor } from "../../types";
import type { SettingsPage } from "../../routing";
import { productIntroHash } from "../../app/public-routing";
import "./settings-workspace.css";

type WorkspaceProps = {
  page: SettingsPage;
  children: ReactNode;
  onBack: () => void;
};

const pageLabels: Record<Exclude<SettingsPage, "overview">, string> = {
  extensions: "扩展中心",
  channels: "消息渠道",
  appearance: "外观",
  account: "账号与安全",
  library: "文件库管理",
  model: "模型设置",
  agent: "Agent 执行记录"
};

export function SettingsWorkspace({ page, children, onBack }: WorkspaceProps) {
  return (
    <section className={`settings-workspace settings-${page}`}>
      {page !== "overview" ? (
        <nav className="settings-breadcrumb" aria-label="设置路径">
          <button type="button" onClick={onBack}><ArrowLeft size={14} />设置</button>
          <ChevronRight size={13} aria-hidden="true" />
          <span aria-current="page">{pageLabels[page]}</span>
        </nav>
      ) : null}
      {children}
    </section>
  );
}

type OverviewProps = {
  library: LibraryEditor;
  libraryReady: boolean | null;
  sourceTitle?: string;
  fileCount?: number;
  onOpen: (page: Exclude<SettingsPage, "overview">) => void;
  accountEmail?: string;
  accountName?: string;
  modelName?: string;
  apiKeyConfigured?: boolean;
};

export function SettingsOverview({
  onOpen,
  accountEmail,
  accountName,
  modelName,
  apiKeyConfigured
}: OverviewProps) {
  const accountLabel = accountName?.trim() || accountEmail || "尚未设置昵称";
  const configuredModel = modelName?.trim() || "尚未设置模型";
  return (
    <div className="settings-overview">
      <div className="settings-overview-grid">
        <button className="settings-entry-card extensions" type="button" onClick={() => onOpen("extensions")}>
          <span className="settings-entry-icon"><Blocks size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy"><span className="settings-entry-title"><strong>扩展中心</strong></span><span className="settings-entry-primary">技能、插件与 MCP</span></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button className="settings-entry-card channels" type="button" onClick={() => onOpen("channels")}>
          <span className="settings-entry-icon"><MessageCircle size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy"><span className="settings-entry-title"><strong>消息渠道</strong></span><span className="settings-entry-primary">连接微信，接收任务与回答</span></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button className="settings-entry-card account" type="button" onClick={() => onOpen("account")}>
          <span className="settings-entry-icon"><KeyRound size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy">
            <span className="settings-entry-title"><strong>账号与安全</strong></span>
            <span className="settings-entry-primary" title={accountLabel}>{accountLabel}</span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button className="settings-entry-card library" type="button" onClick={() => onOpen("library")}>
          <span className="settings-entry-icon"><Folder size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy">
            <span className="settings-entry-title"><strong>文件库管理</strong></span>
            <span className="settings-entry-primary">文件、主题集合与知识</span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button className="settings-entry-card model" type="button" onClick={() => onOpen("model")}>
          <span className="settings-entry-icon"><Cpu size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy">
            <span className="settings-entry-title">
              <strong>模型设置</strong>
            </span>
            <span className="settings-entry-meta">
              <span className="settings-entry-primary" title={configuredModel}>{configuredModel}</span>
              <em className={`settings-entry-status ${apiKeyConfigured ? "success" : "warning"}`}>
                {apiKeyConfigured ? <CheckCircle2 size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
                {apiKeyConfigured ? "密钥已配置" : "待配置密钥"}
              </em>
            </span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button className="settings-entry-card appearance" type="button" onClick={() => onOpen("appearance")}>
          <span className="settings-entry-icon"><Palette size={20} aria-hidden="true" /></span>
          <span className="settings-entry-copy"><span className="settings-entry-title"><strong>外观</strong></span><span className="settings-entry-primary">全局主题</span></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
      <a className="settings-product-link" href={productIntroHash}>
        <Info size={17} aria-hidden="true" /><span>了解 团团</span><ChevronRight size={16} aria-hidden="true" />
      </a>
    </div>
  );
}
