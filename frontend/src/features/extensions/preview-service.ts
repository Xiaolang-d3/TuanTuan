import type { ExtensionPreviewStore, ExtensionSummary, McpDraft, PresentationBrief, SlidePreview } from "./types";

const examples: ExtensionSummary[] = [
  { id: "ppt-master", kind: "skill", name: "PPT Master", description: "从需求和大纲出发，制作、预览并修改演示文稿。", source: "example", enabled: true, permissions: ["读取选定资料", "生成演示文件"], instructions: "需求确认 → 大纲确认 → 页面制作 → 检查与修改 → 导出\n\n此处为交互示例，尚未加载或执行 PPT Master 工作流。" },
  { id: "document-summary", kind: "skill", name: "资料整理", description: "将资料归纳为结构清晰的摘要与行动清单。", source: "example", enabled: false, permissions: ["读取选定资料"], instructions: "阅读用户提供的资料，归纳关键信息并标明出处。\n\n此处为技能结构示例，尚未连接执行服务。" },
  { id: "presentation-kit", kind: "plugin", name: "演示文稿工具包", description: "将技能、模板和导出工具组织为一个扩展包。", source: "example", enabled: false, version: "示例", permissions: ["生成演示文件"], instructions: "包含内容：PPT 制作技能、页面模板、文件导出工具。\n\n此处仅展示插件信息结构，尚未安装插件。" }
];

export function createExtensionPreview(): ExtensionPreviewStore {
  let items = examples.map((entry) => ({ ...entry, permissions: [...entry.permissions] }));
  return {
    list: () => items.map((entry) => ({ ...entry, permissions: [...entry.permissions] })),
    add(entry) {
      if (items.some((item) => item.id === entry.id)) throw new Error("同名扩展已存在，请更换名称或标识。");
      items = [...items, { ...entry, permissions: [...entry.permissions], enabled: false }];
    },
    toggle(id) { items = items.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item); },
    remove(id) { items = items.filter((item) => item.id !== id || item.source === "example"); }
  };
}

const metadataLimit = 100_000;
function checkSize(content: string) {
  if (content.length > metadataLimit) throw new Error("预览内容过长，请使用小于 100 KB 的元数据文件。");
}

export function parseSkill(content: string): ExtensionSummary {
  checkSize(content);
  const match = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 需要以 --- 包围的 name 和 description 元数据。");
  const field = (key: string) => {
    const value = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
    return value.replace(/^(["'])(.*)\1$/, "$2");
  };
  const name = field("name");
  const description = field("description");
  if (!name || !description || name.length > 100 || description.length > 1000) throw new Error("SKILL.md 需要有效的 name（最多 100 字）和 description（最多 1000 字）。预览仅支持单行元数据。");
  return { id: `skill:${name}`, kind: "skill", name, description, source: "import", enabled: false, permissions: [], instructions: match[2].trim() };
}

export function parsePlugin(content: string): ExtensionSummary {
  checkSize(content);
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("请填写有效的 JSON 插件清单。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("插件清单必须是 JSON 对象。");
  const data = value as Record<string, unknown>;
  for (const key of ["id", "name", "version"]) {
    if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > 100) throw new Error(`插件清单需要有效的 ${key}（最多 100 字）。`);
  }
  if (data.permissions !== undefined && (!Array.isArray(data.permissions) || data.permissions.some((item) => typeof item !== "string" || item.length > 100))) throw new Error("permissions 必须是权限名称数组。");
  if (data.description !== undefined && (typeof data.description !== "string" || data.description.length > 1000)) throw new Error("description 必须是最多 1000 字的说明。");
  return { id: `plugin:${String(data.id).trim()}`, kind: "plugin", name: String(data.name).trim(), version: String(data.version).trim(), description: typeof data.description === "string" ? data.description : "自定义插件清单", source: "import", enabled: false, permissions: (data.permissions as string[] | undefined) ?? [], instructions: content };
}

export function validateMcp(draft: Omit<McpDraft, "id" | "status">): McpDraft {
  if (!draft.name.trim() || draft.name.length > 100) throw new Error("请填写名称，最多 100 字。");
  if (!draft.endpoint.trim() || draft.endpoint.length > 2000) throw new Error("请填写服务地址或启动命令，最多 2000 字。");
  if (draft.transport === "http") {
    let url: URL;
    try { url = new URL(draft.endpoint); } catch { throw new Error("请填写有效的 HTTP 或 HTTPS 服务地址。"); }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("仅支持 HTTP 或 HTTPS 服务地址。");
    if (url.username || url.password || url.search || url.hash) throw new Error("请勿在地址中填写凭据、查询参数或片段；凭据配置将在后端接入后提供。");
  }
  return { ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim(), id: crypto.randomUUID(), status: "draft" };
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("已取消", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 450);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function previewPresentation(onProgress: (step: number) => void, signal: AbortSignal, failExport = false): Promise<void> {
  for (let step = 1; step <= 4; step++) {
    await pause(signal);
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (step === 4 && failExport) throw new Error("模拟导出失败。可重试预览；真实导出将在后端接入后提供。");
    onProgress(step);
  }
}

export function buildSlidePreviews(brief: PresentationBrief): SlidePreview[] {
  const topics = ["背景与目标", "现状与发现", "核心策略", "实施路径", "里程碑", "资源与协作", "风险与应对", "下一步行动"];
  return Array.from({ length: brief.pages }, (_, index) => index === 0
    ? { title: brief.topic, subtitle: `面向${brief.audience || "团队成员"}的演示`, points: ["明确目标", "聚焦关键问题", "形成行动共识"] }
    : { title: topics[(index - 1) % topics.length], subtitle: brief.topic, points: [`${brief.topic}：待补充的关键观点`, "在此补充事实、数据或案例", "明确负责人、时间与预期结果"] });
}
