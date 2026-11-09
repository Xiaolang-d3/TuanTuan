import { Check, ChevronRight, ChevronUp, RefreshCw, Settings2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ChatWorkspaceProps, ServiceModelCatalog } from "./types";
import { ComposerModelParameters, type ComposerModelSettings } from "./ComposerModelParameters";
import { MODEL_CATEGORIES, modelCategories, type ModelCategory } from "./model-categories";

type ModelProfileOption = { id: string; model_name: string; connection_name: string; connection_id?: string; capabilities?: Record<string, unknown> | null };
type ModelOption = { id?: string; model_name: string; categories: ModelCategory[] };

type Props = {
  configured: boolean;
  currentModelName?: string;
  defaultModelName?: string;
  profiles: ModelProfileOption[];
  serviceModels?: ChatWorkspaceProps["serviceModels"];
  additionalServiceModels?: ChatWorkspaceProps["additionalServiceModels"];
  onDiscover?: (refresh?: boolean) => Promise<void>;
  onServiceChange?: ChatWorkspaceProps["onServiceModelChange"];
  selectedProfileId: string | null;
  profileDisabled: boolean;
  serviceUnavailable: boolean;
  busy: boolean;
  canSelect: boolean;
  onChange: (profileId: string | null) => void | Promise<void>;
  onOpenSettings?: () => void;
  modelSettings?: ComposerModelSettings;
};

/** 输入框工具栏里的模型切换：按钮上方的紧凑浮层。 */
export function ComposerModelPicker(props: Props) {
  const currentProfile = props.profiles.find(profile => profile.id === props.selectedProfileId);
  const currentCategory = modelCategories(props.currentModelName || props.defaultModelName || "", props.serviceModels?.model_protocol ?? props.modelSettings?.protocol, currentProfile?.capabilities)[0];
  const [category, setCategory] = useState<ModelCategory>(currentCategory);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"models" | "parameters">("models");
  const parametersPanel = panel === "parameters" && Boolean(props.modelSettings);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const discoverRef = useRef(props.onDiscover);
  discoverRef.current = props.onDiscover;
  const services = props.serviceModels ? [props.serviceModels, ...(props.additionalServiceModels ?? []).filter(service => service.connection_id !== props.serviceModels?.connection_id)] : props.additionalServiceModels ?? [];
  const serviceSignature = JSON.stringify(services.map(service => [service.connection_id, service.revision]));

  useEffect(() => {
    if (!open) return;
    void discoverRef.current?.();
  }, [open, serviceSignature]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(parametersPanel ? 240 : 280, window.innerWidth - 16);
      setMenuStyle({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 8, width, maxHeight: Math.max(160, Math.min(360, rect.top - 16)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, parametersPanel]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { const target = event.target as Node; if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    const target = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not(:disabled):not([aria-disabled="true"])') ?? listRef.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled):not([aria-disabled="true"])') ?? listRef.current?.querySelector<HTMLElement>("input, button:not(:disabled)");
    target?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (!props.configured) {
    return (
      <button type="button" className="model-pill model-pill--setup" onClick={props.onOpenSettings} title="还没有可用的模型，先去设置添加模型连接">
        <Settings2 size={15} />
        <span>未配置模型，去设置</span>
      </button>
    );
  }

  const label = props.currentModelName || props.defaultModelName || "默认模型";
  const warning = props.profileDisabled ? "已停用" : props.serviceUnavailable ? "服务不可用" : "";
  const allGroups = services.map(service => ({ service, models: Array.from(new Set(service.models)).map((name): ModelOption => {
    const matching = props.profiles.filter(profile => profile.connection_id === service.connection_id && profile.model_name === name);
    const profile = matching.find(profile => profile.id === props.selectedProfileId) ?? matching[0];
    const entry = service.entries?.find(value => value.id === name);
    const overridden = ["chat", "image_generation", "video_generation"].some(key => ["supported", "unsupported"].includes(String(profile?.capabilities?.[key])));
    return { id: profile?.id, model_name: name, categories: entry && !overridden ? entry.output_types : modelCategories(name, service.model_protocol, profile?.capabilities) };
  }) }));
  const groups = allGroups.map(group => ({ ...group, models: group.models.filter(model => model.categories.includes(category)) })).filter(group => group.models.length || group.service.busy || group.service.error);
  const disabled = props.busy || !props.canSelect;

  const choose = (profileId: string) => {
    setOpen(false);
    rootRef.current?.querySelector<HTMLElement>(".model-pill")?.focus();
    if (profileId !== props.selectedProfileId) void props.onChange(profileId);
  };
  const chooseService = (modelName: string, connectionId: string) => {
    setOpen(false);
    rootRef.current?.querySelector<HTMLElement>(".model-pill")?.focus();
    void props.onServiceChange?.(modelName, connectionId);
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); rootRef.current?.querySelector<HTMLElement>(".model-pill")?.focus(); return; }
    if (panel !== "models" || !(event.target as HTMLElement).matches('[role="option"]')) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled):not([aria-disabled="true"])') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
  };
  const option = (id: string | undefined, name: string, service: ServiceModelCatalog) => {
    const selected = id !== undefined ? props.selectedProfileId === id : !props.selectedProfileId && props.currentModelName === name && props.serviceModels?.connection_id === service.connection_id;
    return (
      <button key={name} type="button" role="option" aria-label={name} aria-selected={selected} disabled={disabled || category === "video"} className={`model-option${selected ? " is-selected" : ""}`} onClick={() => id === undefined ? chooseService(name, service.connection_id) : choose(id)} title={category === "video" ? "视频生成接口暂未接入" : name}>
        <span className="model-option-copy">
          <span className="model-option-name">{name}</span>
          {category === "video" ? <small className="model-option-note">暂未接入</small> : null}
        </span>
        {selected ? <Check size={15} className="model-option-check" aria-hidden="true" /> : null}
      </button>
    );
  };

  return (
    <div className="model-picker" ref={rootRef}>
      {open ? createPortal(
        <div className="model-menu" id={listId} role="dialog" aria-label="模型与参数" ref={listRef} onKeyDown={onListKey} style={menuStyle}>
          {props.modelSettings ? <div className="model-menu-tabs" role="group" aria-label="模型菜单页面">
            <button type="button" aria-pressed={panel === "models"} onClick={() => setPanel("models")}>切换模型</button>
            <button type="button" aria-pressed={panel === "parameters"} onClick={() => setPanel("parameters")}>思考设置</button>
          </div> : null}
          {panel === "parameters" && props.modelSettings ? <ComposerModelParameters key={`${props.modelSettings.profile.id}:${props.modelSettings.profile.revision}`} settings={props.modelSettings} disabled={disabled} /> : <>
          <div className="model-menu-categories" role="tablist" aria-label="模型类型">
            {MODEL_CATEGORIES.map(item => <button key={item.id} type="button" role="tab" id={`${listId}-${item.id}`} aria-selected={category === item.id} aria-controls={`${listId}-results`} tabIndex={category === item.id ? 0 : -1} onClick={() => setCategory(item.id)} onKeyDown={event => {
              const index = MODEL_CATEGORIES.findIndex(value => value.id === item.id);
              const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
              if (next < 0) return;
              event.preventDefault(); setCategory(MODEL_CATEGORIES[next].id);
              (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
            }}>{item.label}</button>)}
          </div>
          <div className="model-menu-results" role="tabpanel" id={`${listId}-results`} aria-labelledby={`${listId}-${category}`}>
          <div className="model-menu-scroll" role="listbox" aria-label="选择模型">
            {category === "video" ? <p className="model-menu-status">视频生成接口暂未接入，视频模型暂不可选。</p> : null}
            {warning ? (
              <p className="model-menu-alert">
                <TriangleAlert size={14} aria-hidden="true" />
                {props.profileDisabled ? "当前模型已停用，请换一个模型" : "当前模型服务不可用，可以换一个模型或检查设置"}
              </p>
            ) : null}
            {groups.map(({ service, models }) => <div key={service.connection_id} className="model-menu-group" role="group" aria-label={service.connection_name}>
              {groups.length > 1 ? <p className="model-menu-group-title">{service.connection_name}</p> : null}
              {service.busy ? <p className="model-menu-status" role="status">{service.models.length ? "正在更新模型列表…" : "正在读取服务模型…"}</p> : null}
              {service.error ? <p className="model-menu-status model-menu-error" role="alert">{service.models.length ? "更新失败，显示上次读取的模型。" : "读取失败。"} {service.error} <button type="button" disabled={service.busy || disabled} onClick={() => void props.onDiscover?.(true)}>重试</button></p> : null}
              {models.map(profile => option(profile.id, profile.model_name, service))}
            </div>)}
            {groups.every(({ service, models }) => !models.length && !service.busy && !service.error) ? <p className="model-menu-status">{category === "chat" ? "服务尚未返回可选模型，可刷新列表或前往管理模型" : category === "image" ? "暂无图片模型，可前往管理模型添加生图服务" : "暂无视频模型"}</p> : null}
          </div>
          </div>
          </>}
          {props.onDiscover && !parametersPanel ? <button type="button" className="model-menu-footer" disabled={disabled || services.some(service => service.busy)} onClick={() => void props.onDiscover?.(true)}><RefreshCw size={14} aria-hidden="true" /><span>刷新模型列表</span></button> : null}
          {props.onOpenSettings && !parametersPanel ? (
            <button type="button" className="model-menu-footer" onClick={() => { setOpen(false); props.onOpenSettings?.(); }}>
              <Settings2 size={14} aria-hidden="true" /><span>管理模型</span><ChevronRight size={14} className="model-menu-footer-arrow" aria-hidden="true" />
            </button>
          ) : null}
        </div>,
        document.body
      ) : null}
      <button
        type="button"
        className={`model-pill${warning ? " model-pill--warning" : ""}${open ? " is-open" : ""}`}
        aria-label={`切换模型，当前 ${label}${warning ? `（${warning}）` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={warning ? `当前模型${warning}` : props.canSelect ? `当前模型：${label}` : "开始对话后可切换模型"}
        onClick={() => { if (!open) setCategory(currentCategory); setOpen((value) => !value); }}
      >
        <span className="model-pill-name">{label}</span>
        {warning ? <span className="model-pill-badge" role="status">{warning}</span> : null}
        {props.busy ? <small className="model-pill-busy" role="status">保存中…</small> : <ChevronUp size={14} aria-hidden="true" className="model-pill-caret" />}
      </button>
    </div>
  );
}
