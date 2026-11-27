import { useEffect, useRef, useState } from "react";
import { webSourcesFromAgent, type WebSource } from "../../features/chat/MessagePresentation";
import type { AgentRunResult, ChatAttachment, ChatWorkspaceProps } from "../../features/chat/types";
import { useConversationScroll } from "../../features/chat/useConversationScroll";

type WorkspacePanelOptions = Pick<ChatWorkspaceProps, "chatInputRef" | "currentConversationId" | "focused" | "latestAgent" | "messages"> & {
  pendingAttachments: ChatAttachment[];
};

/** 管理会话内的历史、来源及预览面板，并在关闭来源详情后恢复阅读位置。 */
export function useWorkspacePanels(props: WorkspacePanelOptions) {
  const [expandedPreview, setExpandedPreview] = useState<ChatAttachment | null>(null);
  const [resultSelection, setResultSelection] = useState<{ messageId: number; selector?: string; saving?: boolean; editing?: boolean } | null>(null);
  const generatedGallery = expandedPreview?.origin === "generated" ? props.messages.find(message => message.payload?.agent?.assets?.some(asset => asset.id === expandedPreview.id))?.payload?.agent?.assets ?? [] : null;
  const gallery = expandedPreview?.kind === "image" ? (generatedGallery ?? props.messages.find(message => message.payload?.attachments?.some(attachment => attachment.id === expandedPreview.id))?.payload?.attachments ?? props.pendingAttachments).filter(item => item.kind === "image") : [];
  const [conversationListOpen, setConversationListOpen] = useState(false);
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const scrolling = useConversationScroll(props.currentConversationId, props.messages, researchPanelOpen);
  const researchReturn = useRef<{ top: number; element: HTMLElement | null } | null>(null);
  const [researchSelection, setResearchSelection] = useState<{
    agent?: AgentRunResult;
    sources: WebSource[];
    selectedSource: number;
  } | null>(null);
  const latestAssistant = [...props.messages].reverse().find((message) => message.role === "assistant");
  const defaultResearchAgent = props.latestAgent ?? latestAssistant?.payload?.agent;
  const defaultResearchSources = webSourcesFromAgent(defaultResearchAgent);
  const activeResearch = researchSelection ?? {
    agent: defaultResearchAgent,
    sources: defaultResearchSources,
    selectedSource: 0
  };

  function openResearchDetails(agent = defaultResearchAgent, sources = defaultResearchSources, selectedSource = 0) {
    if (!researchPanelOpen) researchReturn.current = {
      top: scrolling.viewportRef.current?.scrollTop ?? 0,
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    setConversationListOpen(false);
    setResearchSelection({ agent, sources, selectedSource });
    setResearchPanelOpen(true);
  }

  function closeResearchDetails(restoreFocus = true) {
    setResearchPanelOpen(false);
    const saved = researchReturn.current;
    window.requestAnimationFrame(() => {
      // 会话切换或重新打开详情后，不恢复旧面板的滚动位置与焦点。
      if (researchReturn.current !== saved) return;
      if (saved) scrolling.restorePosition(saved.top);
      if (restoreFocus) (saved?.element?.isConnected ? saved.element : props.chatInputRef.current)?.focus({ preventScroll: true });
    });
  }

  useEffect(() => {
    setExpandedPreview(null);
    setResultSelection(null);
    setConversationListOpen(false);
    setResearchPanelOpen(false);
    setResearchSelection(null);
    researchReturn.current = null;
  }, [props.currentConversationId]);

  useEffect(() => {
    if (!props.focused) setConversationListOpen(false);
  }, [props.focused]);

  useEffect(() => {
    if (!conversationListOpen && !researchPanelOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (conversationListOpen) setConversationListOpen(false);
      if (researchPanelOpen) closeResearchDetails();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversationListOpen, researchPanelOpen]);

  return {
    expandedPreview, setExpandedPreview, gallery, resultSelection, setResultSelection,
    conversationListOpen, setConversationListOpen, researchPanelOpen, activeResearch,
    scrolling, openResearchDetails, closeResearchDetails,
  };
}
