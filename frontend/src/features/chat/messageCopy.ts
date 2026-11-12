export class MessageCopyInProgressError extends Error {}

// Do not queue writes: the clipboard call must retain the user's gesture.
let copyInProgress = false;

export async function copyMessageText(text: string): Promise<void> {
  if (copyInProgress) throw new MessageCopyInProgressError();
  copyInProgress = true;
  try {
    // A rejected modern write can mean permission was denied; do not bypass it.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const previousFocus = document.activeElement;
    const editable = previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement ? previousFocus : null;
    const textSelection = editable && editable.selectionStart !== null && editable.selectionEnd !== null
      ? { start: editable.selectionStart, end: editable.selectionEnd, direction: editable.selectionDirection ?? undefined }
      : null;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const anchorNode = selection?.anchorNode;
    const anchorOffset = selection?.anchorOffset ?? 0;
    const focusNode = selection?.focusNode;
    const focusOffset = selection?.focusOffset ?? 0;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    Object.assign(input.style, { position: "fixed", top: "0", left: "-9999px" });
    document.body.appendChild(input);

    try {
      input.focus({ preventScroll: true });
      input.select();
      if (!document.execCommand("copy")) throw new Error("Copy command failed");
    } finally {
      input.remove();
      try {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
        if (editable?.isConnected && textSelection) {
          editable.setSelectionRange(textSelection.start, textSelection.end, textSelection.direction);
        }
        if (selection && anchorNode?.isConnected && focusNode?.isConnected && ranges.length) {
          selection.removeAllRanges();
          selection.addRange(ranges[0]);
          if (typeof selection.setBaseAndExtent === "function") {
            selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
          }
          for (const range of ranges.slice(1)) selection.addRange(range);
        }
      } catch {
        // The original selection may have changed or detached during the copy event.
      }
    }
  } finally {
    copyInProgress = false;
  }
}
