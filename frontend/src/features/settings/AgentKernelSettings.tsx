import { Bot, CircleAlert } from "lucide-react";
import "./agent-kernel-settings.css";

export type KernelChoice = {
  id: "tuantuan" | "dsh";
  name: string;
  available: boolean;
  reason: string;
};

type Props = {
  choices: KernelChoice[];
  defaultKernel: "tuantuan" | "dsh";
  busy: boolean;
  onChange: (kernel: "tuantuan" | "dsh") => void;
};

export function AgentKernelSettings({ choices, defaultKernel, busy, onChange }: Props) {
  const current = choices.find((choice) => choice.id === defaultKernel);
  const options = choices.length
    ? choices
    : [{ id: defaultKernel, name: defaultKernel === "dsh" ? "DeepSeek Harness" : "团团内核", available: false, reason: "正在读取可用内核" }];

  return (
    <section className="settings-card agent-kernel-settings" aria-labelledby="agent-kernel-settings-title">
      <div className="agent-kernel-settings-heading">
        <span aria-hidden="true"><Bot size={18} /></span>
        <div>
          <h3 id="agent-kernel-settings-title">Agent 内核</h3>
          <p>设置新建对话的默认执行内核；已有对话会保持自己的内核和上下文。</p>
        </div>
      </div>
      <label htmlFor="default-agent-kernel">
        <span>新对话默认内核</span>
        <select
          id="default-agent-kernel"
          value={defaultKernel}
          disabled={busy}
          onChange={(event) => onChange(event.target.value as "tuantuan" | "dsh")}
        >
          {options.map((choice) => (
            <option key={choice.id} value={choice.id} disabled={!choice.available}>
              {choice.name}{choice.available ? "" : "（" + choice.reason + "）"}
            </option>
          ))}
        </select>
      </label>
      {current?.available === false ? (
        <p className="agent-kernel-settings-warning" role="status"><CircleAlert size={14} />当前默认内核暂不可用；新对话会先使用团团内核。</p>
      ) : (
        <p className="agent-kernel-settings-note">切换已有且已有消息的对话时，系统会新建一条带上下文摘要的分支，原任务不会中断。</p>
      )}
    </section>
  );
}
