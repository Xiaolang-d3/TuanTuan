import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import type { ReactNode } from "react";
import { ChatTurn, EditMessageComposer, RunProcess } from "../../features/chat/MessagePresentation";
import type { ChatWorkspaceProps } from "../../features/chat/types";
import type { useConversationScroll } from "../../features/chat/useConversationScroll";

type ChatThreadProps = Pick<ChatWorkspaceProps,
  "chatBusy" | "chatEndRef" | "density" | "hiddenMessageCount" | "messages" | "onLoadMore" | "taskCancelBusy"
> & {
  scrolling: ReturnType<typeof useConversationScroll>;
  modelFeedback: ReactNode;
  children: ReactNode;
};

/** 展示会话消息、运行过程和滚动控件，并在消息后的同一滚动区域嵌入扩展内容。 */
export function ChatThread({ scrolling, modelFeedback, children, ...props }: ChatThreadProps) {
  return (
    <>
      <div className="chat-thread-surface">
        <ThreadPrimitive.Viewport ref={scrolling.viewportRef} onScroll={scrolling.onScroll} autoScroll={false} scrollToBottomOnInitialize={false} scrollToBottomOnThreadSwitch={false} scrollToBottomOnRunStart={false} className="chat-thread" role="log" aria-live="polite" aria-relevant="additions">
          <div ref={scrolling.contentRef} className="chat-thread-content">
            {props.messages.length === 0 && props.density === "dock" ? (
              <div className="chat-welcome"><span className="assistant-welcome-mark" aria-hidden="true">✦</span><h2>有什么可以帮你？</h2><p>提问、整理资料，或一起完成一段创作。</p></div>
            ) : null}
            {props.hiddenMessageCount > 0 ? (
              <button className="load-history-button" onClick={props.onLoadMore}>
                查看更早消息 · 还有 {props.hiddenMessageCount} 条
              </button>
            ) : null}
            {props.messages.length === 0 ? null : (
              <ThreadPrimitive.Messages>
                {({ message }) => message.composer.isEditing
                  ? <EditMessageComposer />
                  : <ChatTurn state={message} chatBusy={props.chatBusy} stopping={props.taskCancelBusy} />}
              </ThreadPrimitive.Messages>
            )}
            {props.chatBusy && (!props.messages.length || props.messages.at(-1)?.role === "user")
              && !props.messages.some((message) => message.role === "assistant" && message.id < 0) ? (
              <div className="message assistant"><div className="message-content"><RunProcess streaming stopping={props.taskCancelBusy} /></div></div>
            ) : null}
            {children}
            <div ref={props.chatEndRef} />
          </div>
        </ThreadPrimitive.Viewport>
      </div>
      {scrolling.away || modelFeedback ? (
        <div className="chat-thread-overlay">
          {modelFeedback}
          {scrolling.away ? (
            <button
              type="button"
              className="chat-jump-latest"
              data-unread={scrolling.unread || undefined}
              aria-label={scrolling.unread ? "有新内容 · 回到最新" : "回到最新"}
              onClick={scrolling.jumpToLatest}
            >
              <span className="chat-jump-latest-label">{scrolling.unread ? "有新内容 · 回到最新" : "回到最新"}</span>
              <ArrowDown size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
