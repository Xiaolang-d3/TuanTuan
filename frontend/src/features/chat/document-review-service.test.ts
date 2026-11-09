import { afterEach, expect, it, vi } from "vitest";
import { createDocumentReviewService } from "./document-review-service";

afterEach(() => vi.unstubAllGlobals());
const revision = "a".repeat(64);
it("uses an existing parsed snapshot version without extracting it again", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "doc", parse_status: "parsed", source_revision: revision })));
  vi.stubGlobal("fetch", fetch);
  const service = createDocumentReviewService("/api", "owner");
  expect(await service.prepareAttachment("doc")).toEqual({ source_kind: "attachment", attachment_id: "doc", source_revision: revision });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe("/api/attachments/doc");
  expect(fetch.mock.calls[0][1].cache).toBe("no-store");
});
it("prepares an unparsed attachment before returning its version handle", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ parse_status: "pending" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ parse_status: "parsed", source_revision: revision })));
  vi.stubGlobal("fetch", fetch);
  await createDocumentReviewService("/api", "owner").prepareAttachment("doc");
  expect(fetch.mock.calls[1][0]).toBe("/api/attachments/doc/parse");
  expect(fetch.mock.calls[1][1].method).toBe("POST");
  expect(new Headers(fetch.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer owner");
});
