import type { ReactNode, RefObject } from "react";
import { X } from "lucide-react";
import { AlertDialog, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";

export { DialogDescription as LibraryDialogDescription };

type LibraryDialogProps = {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
  alert?: boolean;
  container?: RefObject<HTMLElement | null>;
};

export function LibraryDialog({ title, children, close, busy = false, alert = false, container }: LibraryDialogProps) {
  const Root = alert ? AlertDialog : Dialog;
  return (
    <Root
      open
      onOpenChange={(open, event) => {
        if (open) return;
        if (busy) event.cancel();
        else close();
      }}
    >
      <DialogContent
        className="fl-dialog"
        backdropClassName="fl-dialog-backdrop"
        container={container}
        aria-modal="true"
      >
        <header>
          <DialogTitle>{title}</DialogTitle>
          <DialogClose type="button" aria-label="关闭弹窗" disabled={busy}>
            <X size={20} />
          </DialogClose>
        </header>
        {children}
      </DialogContent>
    </Root>
  );
}
