import type { createApiClient } from "../../api/client";
import { ImageWorkspace } from "./ImageWorkspace";
import { useImageWorkspace } from "./useImageWorkspace";

export function ImageWorkspacePage({ apiBase, accessToken, fetchJson, ready, refreshConversations, onLibraryChanged, onOpenConversation, onOpenSettings }: {
  apiBase: string;
  accessToken: string;
  fetchJson: ReturnType<typeof createApiClient>;
  ready: boolean;
  refreshConversations: () => Promise<unknown>;
  onLibraryChanged: () => Promise<void>;
  onOpenConversation: (conversationId: number) => void;
  onOpenSettings: () => void;
}) {
  const workspace = useImageWorkspace({ apiBase, accessToken, fetchJson, ready, refreshConversations, onLibraryChanged });
  return <ImageWorkspace
    ready={ready}
    busy={workspace.busy}
    error={workspace.error}
    images={workspace.images}
    resultPrompt={workspace.resultPrompt}
    hasConversation={workspace.conversationId !== null}
    onGenerate={workspace.generate}
    onLoadImage={workspace.loadImage}
    onOpenConversation={() => { if (workspace.conversationId !== null) onOpenConversation(workspace.conversationId); }}
    onOpenSettings={onOpenSettings}
  />;
}
