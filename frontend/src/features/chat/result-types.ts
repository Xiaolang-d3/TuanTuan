import { createContext } from "react";
import type { LibraryFolder, LibrarySourceDetail } from "../../types";
import type { ChatAttachment } from "./types";
import type { DocumentService, SavedDocument } from "./document-service";

export type ChatArtifact = {
  selector: string;
  kind: "answer" | "code" | "diagram" | "attachment" | "image";
  asset?: ChatAttachment;
  assets?: ChatAttachment[];
  filename: string;
  mime_type: string;
  content?: string;
  attachment_id?: string;
  can_index: boolean;
};
export type ArtifactManifest = { message_id: number; snapshot: string; incomplete: boolean; artifacts: ChatArtifact[]; folders?: LibraryFolder[]; sources?: unknown[] };
export type SaveResultRequest = { selector: string; snapshot: string; filename: string; folder_id: number | null; enabled: boolean };
export type ResultServices = {
  documentService?: DocumentService;
  onEditDocument?: (messageId: number) => void;
  onContinueDocument?: (document: SavedDocument, signal: AbortSignal) => Promise<void>;
  onDocumentArchived?: () => void;
  onLoadAttachment?: (attachment: ChatAttachment, signal?: AbortSignal) => Promise<{ file: Blob; parsedText?: string }>;
  onLoadResults?: (messageId: number, signal?: AbortSignal) => Promise<ArtifactManifest>;
  onSaveResult?: (messageId: number, request: SaveResultRequest, signal?: AbortSignal) => Promise<{ source: LibrarySourceDetail; reused: boolean }>;
  onOpenSavedResult?: (sourceId: number) => void;
  resultFolders?: LibraryFolder[];
};
export const ResultActionsContext = createContext<((messageId: number, selector?: string, saving?: boolean) => void) | null>(null);
export const DocumentActionsContext = createContext<((messageId: number) => void) | null>(null);
