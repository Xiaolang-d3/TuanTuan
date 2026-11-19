import { useMemo } from "react";
import type { createApiClient } from "../../api/client";
import { createImageStudioApi } from "./imageStudioApi";
import { ImageWorkspace } from "./ImageWorkspace";

export type StudioConnection = { apiBase:string; accessToken:string; fetchJson:ReturnType<typeof createApiClient>; ready:boolean; active?:boolean };
export type ImagePageActions = { accountKey:string|number; refreshConversations:()=>Promise<unknown>; onLibraryChanged:()=>Promise<void>;
  onOpenSettings:()=>void; onOpenWorks:()=>void; onOpenConversation:(id:number)=>void };
export function ImageWorkspacePage({apiBase,accessToken,fetchJson,ready,active=true,...actions}:StudioConnection & ImagePageActions) {
  const api=useMemo(()=>createImageStudioApi(apiBase,accessToken,fetchJson),[apiBase,accessToken,fetchJson]);
  return <ImageWorkspace key={actions.accountKey} {...actions} api={api} enabled={ready&&active}/>;
}
