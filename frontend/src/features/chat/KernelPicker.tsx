import { Check, Cpu } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type KernelChoice = {
  id: "tuantuan" | "dsh";
  name: string;
  available: boolean;
  reason: string;
};

type Props = {
  choices: KernelChoice[];
  selected: string;
  locked: boolean;
  busy: boolean;
  onChange: (kernel: "tuantuan" | "dsh") => void;
};

export function KernelPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = props.choices.find((choice) => choice.id === props.selected);
  const choose = (kernel: "tuantuan" | "dsh") => {
    setOpen(false);
    props.onChange(kernel);
  };
  return (
    <div className="kernel-picker" ref={rootRef}>
      <button
        type="button"
        className={props.locked ? "kernel-pill kernel-pill--locked" : "kernel-pill"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen((value) => !value)}
        title={props.locked ? "当前对话的内核已锁定；选择其他内核会新建对话" : "选择 Agent 内核"}
      >
        <Cpu size={15} aria-hidden="true" />
        <span>{current?.name ?? "团团内核"}</span>
      </button>
      {open
        ? createPortal(
            <div className="kernel-menu" id={listId} role="dialog" aria-label="Agent 内核">
              {props.choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="option"
                  aria-selected={choice.id === props.selected}
                  disabled={props.busy || !choice.available || (props.locked && choice.id === props.selected)}
                  className={`kernel-option${choice.id === props.selected ? " is-selected" : ""}`}
                  title={!choice.available ? choice.reason : props.locked && choice.id !== props.selected ? "将新建对话并继承文本上下文" : choice.name}
                  onClick={() => choose(choice.id)}
                >
                  <span className="kernel-option-copy">
                    <span className="kernel-option-name">{choice.name}</span>
                    {!choice.available ? <small className="kernel-option-note">{choice.reason}</small> : null}
                    {choice.available && props.locked && choice.id !== props.selected ? <small className="kernel-option-note">将在新对话中继续</small> : null}
                  </span>
                  {choice.id === props.selected ? <Check size={15} className="kernel-option-check" aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
