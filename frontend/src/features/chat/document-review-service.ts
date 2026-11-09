import { createApiClient } from "../../api/client";
import type { BackgroundJob } from "../extensions/activity-service";
import type { LocalEvidence } from "./local-evidence";

export type DocumentReviewTarget = { source_kind: "library"; source_id: number; source_revision: string }
  | { source_kind: "attachment"; attachment_id: string; source_revision: string };
export type ReviewBudget = { calls: number; input_tokens: number; output_tokens: number; active_seconds: number };
export const DEFAULT_REVIEW_BUDGET: Readonly<ReviewBudget> = { calls: 32, input_tokens: 200000, output_tokens: 32000, active_seconds: 1800 };
export type DocumentCoverage = {
  status: "complete" | "partial" | "interrupted";
  total_blocks: number; completed_blocks: number; failed_blocks: number;
  extraction_complete: boolean; unprocessed_ranges: Record<string, unknown>[];
};
export type DocumentReviewResult = { coverage: DocumentCoverage; summary?: string; local_evidence?: LocalEvidence[] };
export type DocumentReviewJob = Omit<BackgroundJob, "request" | "checkpoint"> & {
  kind: "document.review";
  request: { target: DocumentReviewTarget; conversation_id?: number; budget?: ReviewBudget };
  source_title?: string;
  checkpoint?: { review?: DocumentReviewResult; budget_exhausted?: boolean; external_outcome?: string };
  result?: DocumentReviewResult | null;
  model_budget?: { calls_used: number; calls_limit: number; input_tokens_used: number; input_tokens_limit: number; output_tokens_used: number; output_tokens_limit: number; active_seconds: number; active_seconds_limit: number };
};
export interface DocumentReviewService {
  prepareAttachment(id: string): Promise<DocumentReviewTarget>;
  create(input: { target: DocumentReviewTarget; conversation_id?: number; budget: ReviewBudget; idempotency_key: string }): Promise<DocumentReviewJob>;
  list(conversationId?: number, signal?: AbortSignal): Promise<{ jobs: DocumentReviewJob[] }>;
  get(id: string, signal?: AbortSignal): Promise<DocumentReviewJob>;
  confirm(id: string, stageId: string, revision: number, answer: { budget: ReviewBudget; idempotency_key: string }): Promise<DocumentReviewJob>;
  cancel(id: string): Promise<DocumentReviewJob>;
  resume(id: string): Promise<DocumentReviewJob>;
}
export function createDocumentReviewService(apiBase: string, accessToken: string): DocumentReviewService {
  const request = createApiClient(apiBase, accessToken);
  const path = (id: string) => `/document-reviews/${encodeURIComponent(id)}`;
  const post = <T,>(url: string, body?: unknown) => request<T>(url, { method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return {
    async prepareAttachment(id) {
      type AttachmentVersion = { parse_status: string; source_revision?: string };
      const url = `/attachments/${encodeURIComponent(id)}`;
      let attachment = await request<AttachmentVersion>(url, { cache: "no-store" });
      if (attachment.parse_status !== "parsed" || !attachment.source_revision) attachment = await post<AttachmentVersion>(`${url}/parse`);
      if (attachment.parse_status !== "parsed" || !/^[0-9a-f]{64}$/.test(attachment.source_revision || "")) throw new Error("资料版本尚未就绪，请完成提取后重试");
      return { source_kind: "attachment", attachment_id: id, source_revision: attachment.source_revision! };
    },
    create: input => post("/document-reviews", input),
    list: (conversationId, signal) => request(`/document-reviews${conversationId === undefined ? "" : `?conversation_id=${conversationId}`}`, { signal }),
    get: (id, signal) => request(path(id), { signal }),
    confirm: (id, stageId, revision, answer) => post(`/jobs/${encodeURIComponent(id)}/confirm`, { stage_id: stageId, revision, answer }),
    cancel: id => post(`/jobs/${encodeURIComponent(id)}/cancel`),
    resume: id => post(`/jobs/${encodeURIComponent(id)}/resume`),
  };
}
