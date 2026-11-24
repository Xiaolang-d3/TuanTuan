import { useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Conversation } from "../types";
import { ActionButton } from "./ui";
import { AlertDialog, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/Dialog";

export type ConversationDialogState =
  | { kind: "rename"; conversation: Conversation }
  | { kind: "delete"; conversation: Conversation };

type ConversationDialogProps = {
  dialog: ConversationDialogState;
  busy?: boolean;
  onClose: () => void;
  onRename: (conversation: Conversation, title: string) => void;
  onDelete: (conversation: Conversation) => void;
};

export function ConversationDialog(props: ConversationDialogProps) {
  const { kind, conversation } = props.dialog;
  return <ConversationDialogContent key={`${kind}:${conversation.id}:${conversation.title}`} {...props} />;
}

function ConversationDialogContent({ dialog, busy = false, onClose, onRename, onDelete }: ConversationDialogProps) {
  const [title, setTitle] = useState(dialog.conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isRename = dialog.kind === "rename";
  const Root = isRename ? Dialog : AlertDialog;
  const cleanTitle = title.trim();
  const canRename = Boolean(cleanTitle) && cleanTitle !== dialog.conversation.title && !busy;

  return (
    <Root
      open
      onOpenChange={(open, event) => {
        if (open) return;
        if (busy) event.cancel();
        else onClose();
      }}
    >
      <DialogContent
        className={`action-dialog ${isRename ? "is-rename" : "is-delete"}`}
        backdropClassName="action-dialog-backdrop"
        aria-modal="true"
        initialFocus={isRename ? () => {
          inputRef.current?.select();
          return inputRef.current;
        } : cancelRef}
      >
        <div className="action-dialog-heading">
          <div>
            <DialogTitle>{isRename ? "重命名对话" : "删除对话"}</DialogTitle>
            <DialogDescription>{isRename ? "用一个容易识别的名称保存这段准备。" : `删除“${dialog.conversation.title}”后无法恢复。`}</DialogDescription>
          </div>
          <DialogClose className="action-dialog-close" type="button" aria-label="关闭" disabled={busy}><X size={16} /></DialogClose>
        </div>

        {isRename ? (
          <label className="action-dialog-field">
            <span>对话名称</span>
            <input
              ref={inputRef}
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRename) onRename(dialog.conversation, cleanTitle);
              }}
            />
          </label>
        ) : null}

        <div className="action-dialog-actions">
          <DialogClose ref={cancelRef} render={<ActionButton variant="ghost" />} disabled={busy}>取消</DialogClose>
          {isRename ? (
            <ActionButton variant="primary" onClick={() => onRename(dialog.conversation, cleanTitle)} disabled={!canRename}>保存</ActionButton>
          ) : (
            <ActionButton variant="danger" icon={<Trash2 size={15} />} onClick={() => onDelete(dialog.conversation)} disabled={busy}>删除</ActionButton>
          )}
        </div>
      </DialogContent>
    </Root>
  );
}
