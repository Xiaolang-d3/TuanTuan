import type { VoiceTranscript } from "./voiceInput";

type Selection = { start: number; end: number };
type Range = Selection & { segmentId: number; revision: number; draft: string; detached: boolean; final: boolean };

function separator(left: string, right: string): string {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? " " : "";
}

/** Own only the current speech range. An overlapping manual edit takes ownership. */
export class VoiceDraftEditor {
  private range?: Range;

  observe(draft: string): void {
    const range = this.range;
    if (range && draft !== range.draft) {
      const previous = range.draft;
      let first = 0;
      while (first < previous.length && first < draft.length && previous[first] === draft[first]) first += 1;
      let suffix = 0;
      while (suffix < previous.length - first && suffix < draft.length - first && previous[previous.length - 1 - suffix] === draft[draft.length - 1 - suffix]) suffix += 1;
      const oldEnd = previous.length - suffix;
      const delta = draft.length - previous.length;
      // Insertions at either edge belong to the user and remain outside speech.
      if (oldEnd <= range.start) { range.start += delta; range.end += delta; }
      else if (first < range.end) range.detached = true;
      range.draft = draft;
    }
  }

  apply(draft: string, update: VoiceTranscript, selection: Selection, maxLength = 200_000): { text: string; selection: Selection } | null {
    this.observe(draft);
    let range = this.range;
    if (range && update.segmentId < range.segmentId) return null;
    if (range && update.segmentId === range.segmentId) {
      if (update.revision <= range.revision || range.detached || range.final) return null;
    } else {
      if (!update.text) return null;
      const start = Math.max(0, Math.min(draft.length, selection.start));
      // Dictation never deletes an existing selection. Insert at its end.
      const end = Math.max(start, Math.min(draft.length, selection.end));
      range = { start: end, end, segmentId: update.segmentId, revision: -1, draft, detached: false, final: false };
      this.range = range;
    }
    const before = draft.slice(0, range.start);
    const after = draft.slice(range.end);
    const spoken = update.text.trim();
    const insertion = spoken ? separator(before, spoken) + spoken + separator(spoken, after) : "";
    const text = before + insertion + after;
    if (text.length > maxLength) return null;
    const oldEnd = range.end;
    const delta = insertion.length - (oldEnd - range.start);
    const remap = (index: number) => index >= oldEnd ? index + delta : index <= range.start ? index : range.start + insertion.length;
    range.end = range.start + insertion.length;
    range.revision = update.revision;
    range.final = update.final;
    range.draft = text;
    return { text, selection: { start: remap(selection.start), end: remap(selection.end) } };
  }
}
