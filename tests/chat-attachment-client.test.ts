// Attachment upload client (apps/web/src/pages/chat/attachment-client.ts):
// raw-bytes POST with percent-encoded filename header, local validation BEFORE
// the network, typed failure mapping from server statuses, and the
// pick→read→upload composite that yields a local attachment plus its
// serverRef. No live provider, no real server — fetch is injected.
import { test, expect } from "bun:test";
import {
  AttachmentUploadError,
  attachmentRefOf,
  createPersistedAttachment,
  uploadChatAttachment,
} from "../apps/web/src/pages/chat/attachment-client";
import { ATTACHMENT_LIMITS, type ChatAttachment } from "../apps/web/src/pages/chat/attachments";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

const pngFile = () => new File([PNG], "shot.png", { type: "image/png" });

const dto = () => ({
  id: "att-1",
  name: "shot.png",
  kind: "image" as const,
  bytes: PNG.byteLength,
  mime: "image/png",
  expires_at: 1_800_000_000_000,
  workspace_id: "ws-1",
  created_at: 1_700_000_000_000,
  deleted_at: null,
});

function spyFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  urls: string[];
  inits: RequestInit[];
} {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const i = init ?? {};
    inits.push(i);
    return handler(url, i);
  }) as unknown as typeof fetch;
  return { fetch: fn, urls, inits };
}

test("uploads raw bytes with percent-encoded filename header; returns the canonical DTO", async () => {
  const { fetch, urls, inits } = spyFetch(async (_url, init) => {
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
    expect(bytes.slice(0, 8)).toEqual(PNG.slice(0, 8));
    return new Response(JSON.stringify(dto()), { status: 201 });
  });
  const res = await uploadChatAttachment("ws-1", pngFile(), { fetch });
  expect(res).toEqual(dto());
  expect(urls[0]).toBe("/api/v1/workspaces/ws-1/attachments");
  const headers = new Headers(inits[0]?.headers);
  expect(headers.get("content-type")).toBe("image/png");
  expect(headers.get("x-hbr-filename")).toBe(encodeURIComponent("shot.png"));
});

test("local validation rejects before any network call", async () => {
  let called = 0;
  const { fetch } = spyFetch(() => {
    called++;
    return new Response("{}", { status: 201 });
  });
  const huge = new File([new Uint8Array(ATTACHMENT_LIMITS.maxImageBytes + 1)], "big.png", {
    type: "image/png",
  });
  let caught: unknown;
  try {
    await uploadChatAttachment("ws-1", huge, { fetch });
  } catch (e) {
    caught = e;
  }
  expect((caught as AttachmentUploadError).kind).toBe("tooLarge");
  expect(called).toBe(0);
});

test("413 quota errors map to quota while other 413 errors map to tooLarge", async () => {
  const cases: Array<[unknown, AttachmentUploadError["kind"]]> = [
    [{ error: { code: "QUOTA_EXCEEDED", message: "Attachment storage quota exceeded" } }, "quota"],
    [{ error: { code: "TOO_LARGE", message: "Attachment exceeds size limit" } }, "tooLarge"],
  ];
  for (const [body, kind] of cases) {
    const { fetch } = spyFetch(() => new Response(JSON.stringify(body), { status: 413 }));
    let caught: unknown;
    try {
      await uploadChatAttachment("ws-1", pngFile(), { fetch });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AttachmentUploadError);
    expect((caught as AttachmentUploadError).kind).toBe(kind);
    expect((caught as AttachmentUploadError).status).toBe(413);
  }
});

test("server statuses map to typed failures", async () => {
  const cases: Array<[number, AttachmentUploadError["kind"]]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [413, "tooLarge"],
    [415, "unsupported"],
    [507, "quota"],
    [500, "invalid"],
  ];
  for (const [status, kind] of cases) {
    const { fetch } = spyFetch(() => new Response("nope", { status }));
    let caught: unknown;
    try {
      await uploadChatAttachment("ws-1", pngFile(), { fetch });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AttachmentUploadError);
    expect((caught as AttachmentUploadError).kind).toBe(kind);
    expect((caught as AttachmentUploadError).status).toBe(status);
  }
});

test("a malformed success body is never trusted", async () => {
  const { fetch } = spyFetch(() => new Response('{"id":"x"}', { status: 201 }));
  let caught: unknown;
  try {
    await uploadChatAttachment("ws-1", pngFile(), { fetch });
  } catch (e) {
    caught = e;
  }
  expect((caught as AttachmentUploadError).kind).toBe("invalid");
});

test("network failure maps to a retryable 'network' failure (nothing cached)", async () => {
  const boom = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await uploadChatAttachment("ws-1", pngFile(), { fetch: boom });
  } catch (e) {
    caught = e;
  }
  expect((caught as AttachmentUploadError).kind).toBe("network");
});

test("createPersistedAttachment returns the renderable local bytes plus serverRef", async () => {
  const { fetch } = spyFetch(() => new Response(JSON.stringify(dto()), { status: 201 }));
  const att: ChatAttachment = await createPersistedAttachment("ws-1", pngFile(), { fetch });
  expect(att.kind).toBe("image");
  expect(att.dataUrl).toStartWith("data:image/png;base64,");
  expect(att.serverRef).toEqual(attachmentRefOf(dto()));
});

test("attachmentRefOf projects the wire ref (user-message attachments[] entry)", () => {
  const d = dto();
  expect(attachmentRefOf(d)).toEqual({
    id: d.id,
    name: d.name,
    kind: d.kind,
    bytes: d.bytes,
    mime: d.mime,
    expires_at: d.expires_at,
  });
});
