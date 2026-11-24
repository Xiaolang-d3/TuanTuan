import { useRef } from "react";
import { AlertDialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";

export function DiscardDraftDialog({ open, description, onCancel, onDiscard }: {
  open: boolean;
  description: string;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  return <AlertDialog open={open} onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent
      className="chat-result-dialog chat-discard-draft-dialog"
      backdropClassName="chat-result-backdrop chat-discard-draft-backdrop"
      forceBackdrop
      aria-modal="true"
      initialFocus={cancelButton}
    >
      <DialogTitle>放弃草稿？</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
      <div className="chat-discard-draft-actions">
        <DialogClose ref={cancelButton} type="button">保留草稿</DialogClose>
        <button type="button" className="chat-discard-draft-confirm" onClick={onDiscard}>放弃草稿</button>
      </div>
    </DialogContent>
  </AlertDialog>;
}
