import { ArrowUpRight, RefreshCw, TriangleAlert } from "lucide-react";
import { ComposerClarification } from "../../features/chat/MessagePresentation";
import type { ChatClarification, ChatWorkspaceProps } from "../../features/chat/types";

type ChatComposerStatusProps = Pick<ChatWorkspaceProps,
  "chatBusy" | "currentConversationId" | "latestAgent" | "modelChecking" | "modelUnavailable" | "onCancelTask"
  | "onOpenModelSettings" | "onRetry" | "onSend" | "onSuggestedAction" | "onUndoReplacement"
  | "replacementUndo" | "retryDraft" | "sendError" | "taskCancelBusy" | "waitingForUser"
> & {
  clarification: ChatClarification | null;
  webSearchActive: boolean;
};

/** 在输入区呈现当前任务的澄清、确认和恢复操作。 */
export function ChatComposerStatus(props: ChatComposerStatusProps) {
  const { clarification, webSearchActive } = props;
  return (
    <>
      {clarification && !props.chatBusy ? (
        <ComposerClarification
          clarification={clarification}
          busy={props.taskCancelBusy}
          onChoose={(text) => { void props.onSend(text, [], [], webSearchActive); }}
          onCancel={props.onCancelTask}
        />
      ) : props.waitingForUser ? (
        <section className="task-prompt attention" aria-label="当前任务提醒">
          <span className="task-prompt-icon"><TriangleAlert size={16} /></span>
          <div className="task-prompt-copy">
            <span>需要你完成一步</span>
            <strong>当前任务正在等待你的确认</strong>
            <small>{props.latestAgent?.error?.message ?? "完成提示步骤后，Agent 会继续处理。"}</small>
          </div>
          <div className="task-prompt-actions">
            <button className="task-action-button" onClick={props.onSuggestedAction}>
              继续处理<ArrowUpRight size={14} />
            </button>
            <button className="task-cancel-button" onClick={props.onCancelTask} disabled={props.taskCancelBusy}>
              {props.taskCancelBusy ? "结束中…" : "结束任务"}
            </button>
          </div>
        </section>
      ) : null}

      {props.replacementUndo?.conversationId === props.currentConversationId && !props.chatBusy ? (
        <section className="chat-retry-prompt chat-replacement-undo" role="status" aria-label="撤销替换">
          <RefreshCw size={14} aria-hidden="true" />
          <span>已替换本轮及后续消息。生成的图片无法恢复。</span>
          <button type="button" onClick={() => void props.onUndoReplacement?.()}>撤销</button>
        </section>
      ) : null}
      {props.modelChecking ? <div className="chat-retry-prompt" role="status">正在检查模型服务…</div> : null}
      {props.modelUnavailable || props.sendError || (props.retryDraft && !props.chatBusy) ? (
        <section
          className="chat-retry-prompt"
          role={props.modelUnavailable || props.sendError ? "alert" : undefined}
          aria-label={props.modelUnavailable ? "模型服务不可用" : props.retryDraft?.reason === "interrupted" ? "任务恢复提示" : "消息发送失败"}
        >
          <TriangleAlert size={14} />
          <span>{props.modelUnavailable || props.sendError
            ? `${props.modelUnavailable || props.sendError}${props.retryDraft ? " 输入内容已保留。" : ""}`
            : props.retryDraft?.reason === "interrupted" ? "上次任务意外中断，可从最近检查点继续" : "上一条消息未发送成功"}</span>
          {props.modelUnavailable ? <button type="button" onClick={props.onOpenModelSettings}>去设置模型</button> : null}
          {props.retryDraft && !props.chatBusy ? <button type="button" onClick={() => {
            const draft = props.retryDraft;
            if (!draft) return;
            if (props.onRetry) {
              void props.onRetry(draft);
              return;
            }
            void props.onSend(draft.content, draft.attachmentIds, draft.visionAttachmentIds, webSearchActive,
              webSearchActive ? draft.webSearchTopic : undefined, webSearchActive ? draft.webSearchSourcePreference : undefined);
          }}><RefreshCw size={12} />{props.retryDraft.reason === "interrupted" ? "继续执行" : "重试"}</button> : null}
          {props.retryDraft ? <details><summary>查看保留的内容</summary><p style={{ whiteSpace: "pre-wrap" }}>{props.retryDraft.content}</p></details> : null}
        </section>
      ) : null}
    </>
  );
}
