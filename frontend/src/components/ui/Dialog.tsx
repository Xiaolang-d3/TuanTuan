import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import "./dialog.css";

// Adapted from shadcn/ui's Base UI Dialog and AlertDialog. Both primitives expose
// the same popup parts; only the root changes the role and dismissal behavior.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const AlertDialog = AlertDialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;
export const DialogDescription = DialogPrimitive.Description;
export const DialogTitle = DialogPrimitive.Title;

type DialogContentProps = DialogPrimitive.Popup.Props & {
  backdropClassName: string;
  container?: DialogPrimitive.Portal.Props["container"];
  forceBackdrop?: boolean;
};

export function DialogContent({ backdropClassName, container, forceBackdrop, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal" container={container}>
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={backdropClassName} forceRender={forceBackdrop} />
      <DialogPrimitive.Viewport className="ui-dialog-viewport">
        <DialogPrimitive.Popup data-slot="dialog-content" {...props} />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
