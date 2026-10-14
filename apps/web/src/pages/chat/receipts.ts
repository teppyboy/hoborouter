// Per-request billing receipts: GET /api/v1/workspaces/:id/chat-receipts/:requestId.
// Wire shape mirrors ChatReceipt in packages/shared/src/chat.ts (frozen DTO;
// the web app keeps local type mirrors, see conversations.ts). Money rules:
// charged_vnd is NULL while pending — never 0, because a pending hold has no
// settled amount and displaying 0 would lie about money. Failed requests
// still report the ACTUAL charged amount (full hold). Only the public model
// ID ever reaches the client; no provider keys, no raw upstream payloads.
// Framework-free so tests drive it with an injected fetch.
import { formatVnd } from "../../lib/format";
import { ConversationError, type ConversationsFetch } from "./conversations";

export type ChatReceiptStatus = "pending" | "settled" | "failed";

export interface ChatReceipt {
  request_id: string;
  status: ChatReceiptStatus;
  /** NULL while pending; actual VND (integer) even for failed full-hold turns. */
  charged_vnd: number | null;
  public_model: string | null;
  created_at: number;
}

const STATUSES: readonly ChatReceiptStatus[] = ["pending", "settled", "failed"];

function isReceiptStatus(v: string): v is ChatReceiptStatus {
  return (STATUSES as readonly string[]).includes(v);
}

function parseReceipt(body: unknown): ChatReceipt {
  const b = body as {
    request_id?: unknown;
    status?: unknown;
    charged_vnd?: unknown;
    public_model?: unknown;
    created_at?: unknown;
  } | null;
  if (
    typeof b?.request_id === "string" &&
    b.request_id !== "" &&
    typeof b?.status === "string" &&
    isReceiptStatus(b.status) &&
    (b.charged_vnd === null || typeof b.charged_vnd === "number") &&
    (b.public_model === null || typeof b.public_model === "string") &&
    typeof b?.created_at === "number"
  ) {
    return {
      request_id: b.request_id,
      status: b.status,
      charged_vnd: b.charged_vnd,
      public_model: b.public_model,
      created_at: b.created_at,
    };
  }
  throw new ConversationError("invalid", "Chat service returned an unexpected response.");
}

/** Fetch one receipt for a chat generation. Session-cookie only; a foreign
 *  request ID is a 404 (never distinguishable from a missing one). */
export async function fetchChatReceipt(
  workspaceId: string,
  requestId: string,
  opts?: ConversationsFetch,
): Promise<ChatReceipt> {
  const doFetch = opts?.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat-receipts/${encodeURIComponent(requestId)}`,
      { method: "GET", credentials: "include", signal: opts?.signal },
    );
  } catch {
    throw new ConversationError(
      "network",
      "Could not reach the server. Check your connection and try again.",
    );
  }
  if (!res.ok) {
    const kind =
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "forbidden"
          : res.status === 404
            ? "notFound"
            : "invalid";
    throw new ConversationError(kind, `Chat request failed (${res.status})`, res.status);
  }
  try {
    return parseReceipt(JSON.parse(await res.text()));
  } catch (e) {
    if (e instanceof ConversationError) throw e;
    throw new ConversationError("invalid", "Chat service returned an unexpected response.");
  }
}

/** Safe receipt line for one completed turn. Pending → null (render nothing,
 *  never "0 ₫"). Settled/failed → the ACTUAL charged VND via the shared
 *  formatter. No provider/model internals beyond the public ID. */
export function chargedVndLabel(receipt: ChatReceipt): string | null {
  if (receipt.status === "pending") return null;
  if (receipt.charged_vnd === null) return null;
  return formatVnd(receipt.charged_vnd);
}
