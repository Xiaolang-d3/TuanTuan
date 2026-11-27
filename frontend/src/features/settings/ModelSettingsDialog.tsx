import { useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../../components/ui/Dialog";
import "./model-settings.css";

export function ModelSettingsDialog({ title, open, locked = false, onClose, trigger, children }: {
  title: string;
  open: boolean;
  locked?: boolean;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(open, event) => {
        if (open) return;
        if (locked) event.cancel();
        else onClose();
      }}
    >
      <DialogContent
        render={<section />}
        className="model-settings-page model-settings-dialog"
        backdropClassName="model-dialog-backdrop"
        aria-modal="true"
        initialFocus={() => body.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled)") ?? true}
        finalFocus={() => trigger.current ?? true}
      >
        <header className="model-dialog-heading">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose type="button" aria-label="关闭模型设置" disabled={locked}><X size={18} /></DialogClose>
        </header>
        <div ref={body} className="model-dialog-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
