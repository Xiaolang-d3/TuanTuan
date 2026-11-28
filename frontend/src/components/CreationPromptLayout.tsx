import type { ReactNode } from "react";
import "./CreationPromptLayout.css";

/** 首页和由首页发起的对话共用输入区，切换后沿用同一套布局。 */
export function CreationPromptLayout({ input, children, tools, modelPicker, actions }: {
  input: ReactNode;
  children?: ReactNode;
  tools: ReactNode;
  modelPicker?: ReactNode;
  actions: ReactNode;
}) {
  return <>
    {input}
    {children}
    <div className="creation-entry-footer">
      <div className="creation-entry-tools">{tools}</div>
      <div className="creation-entry-actions">
        {modelPicker && <div className="creation-entry-model">{modelPicker}</div>}
        {actions}
      </div>
    </div>
  </>;
}
