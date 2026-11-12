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
  if (props.locked) {
    return (
      <button type="button" className="kernel-pill kernel-pill--locked" title="内核在对话创建后不可更改，可新建对话换内核">
        <Cpu size={15} aria-hidden="true" />
        <span>{current?.name ?? "团团内核"}</span>
      </button>
    );
  }
  const choose = (kernel: "tuantuan" | "dsh") => {
    setOpen(false);
    props.onChange(kernel);
  };
  return (
    <div className="kernel-picker" ref={rootRef}>
      <button
        type="button"
        className="kernel-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen((value) => !value)}
        title="选择 Agent 内核"
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
                  disabled={props.busy || !choice.available}
                  className={`kernel-option${choice.id === props.selected ? " is-selected" : ""}`}
                  title={choice.available ? choice.name : choice.reason}
                  onClick={() => choose(choice.id)}
                >
                  <span className="kernel-option-copy">
                    <span className="kernel-option-name">{choice.name}</span>
                    {!choice.available ? <small className="kernel-option-note">{choice.reason}</small> : null}
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
