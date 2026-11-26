import { useMemo } from "react";
import type { createApiClient } from "../../api/client";
import { createImageStudioApi } from "./imageStudioApi";
import { ImageWorkspace } from "./ImageWorkspace";

export type StudioConnection = { apiBase:string; accessToken:string; fetchJson:ReturnType<typeof createApiClient>; ready:boolean; active?:boolean };
export type ImageDraftSettings = { profileId?: string | null; size?: string };
export type ImageCreationDraft = { id: string; content: string; settings?: ImageDraftSettings };
export type ImagePageActions = { accountKey:string|number; refreshConversations:()=>Promise<unknown>; onLibraryChanged:()=>Promise<void>;
  onOpenSettings:()=>void; onOpenWorks:()=>void; onOpenConversation:(id:number)=>void;
  creationDraft?: ImageCreationDraft; onCreationDraftConsumed?: (id: string) => void;
  initialTaskId?: string; onCloseInitialTask?: () => void };
export function ImageWorkspacePage({apiBase,accessToken,fetchJson,ready,active=true,...actions}:StudioConnection & ImagePageActions) {
  const api=useMemo(()=>createImageStudioApi(apiBase,accessToken,fetchJson),[apiBase,accessToken,fetchJson]);
  return <ImageWorkspace {...actions} api={api} enabled={ready&&active&&Boolean(accessToken)}/>;
}
