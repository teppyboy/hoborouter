// In-process chat attachment GC (owner decision: bounded batch, no worker).
// Two sweeps per run, both idempotent and tombstone-based (metadata rows are
// never hard-deleted — history snapshots retain expired/deleted refs):
//  1. expired: 30-day TTL passed  -> tombstone + unlink bytes
//  2. orphans: uploaded >24h ago, never referenced by any CURRENT chat
//     conversation jsonb (reference truth is the conversation store, never a
//     client claim) -> tombstone + unlink, freeing the user's live quota.
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { chatAttachments, chatConversations } from "@hoborouter/db";
import { attachmentDir, removeAttachmentFile } from "./chat-attachment-store";

import { CHAT_ATTACHMENT_ORPHAN_TTL_MS } from "@hoborouter/shared";

export const ATTACHMENT_GC_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_BATCH = 100;

/**
 * One bounded GC pass. `nowMs`/`limit` are injectable for tests. Returns the
 * number of rows tombstoned in this run. A failed unlink is retried by the
 * next sweep (rows are already tombstoned, so quota is freed immediately).
 */
export async function runAttachmentGc(
  db: Db,
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
  limit: number = DEFAULT_BATCH,
): Promise<{ expired: number; orphaned: number }> {
  const dir = attachmentDir(env);
  let expired = 0;
  let orphaned = 0;

  const tombstone = async (id: string) => {
    await db
      .update(chatAttachments)
      .set({ deleted_at: nowMs })
      .where(and(eq(chatAttachments.id, id), isNull(chatAttachments.deleted_at)));
    try {
      removeAttachmentFile(dir, id);
    } catch {
      /* next sweep retries the unlink; tombstone is already durable */
    }
  };

  // 1) 30-day TTL expiry, oldest first, bounded batch.
  const expiredRows = await db
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .where(and(lt(chatAttachments.expires_at, nowMs), isNull(chatAttachments.deleted_at)))
    .orderBy(asc(chatAttachments.expires_at))
    .limit(limit);
  for (const row of expiredRows) {
    await tombstone(row.id);
    expired++;
  }

  // 2) Orphan uploads: older than 24h and absent from every current chat
  //    conversation's messages jsonb. jsonb text containment is exact for a
  //    UUID (36 chars, no escaping ambiguity in serialized jsonb).
  const orphanRows = await db
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .where(
      and(
        lt(chatAttachments.created_at, nowMs - CHAT_ATTACHMENT_ORPHAN_TTL_MS),
        isNull(chatAttachments.deleted_at),
      ),
    )
    .orderBy(asc(chatAttachments.created_at))
    .limit(limit);
  for (const row of orphanRows) {
    const [ref] = await db
      .select({ one: sql<number>`1` })
      .from(chatConversations)
      .where(sql`${chatConversations.messages}::text LIKE ${"%" + row.id + "%"}`)
      .limit(1);
    if (ref) continue; // referenced by current history: keep live
    await tombstone(row.id);
    orphaned++;
  }

  return { expired, orphaned };
}

/**
 * Start the hourly sweep loop: one immediate run, then every interval.
 * Returns a stop function (never throws after stop). Wired in production
 * boot (src/index.ts) by the integration owner; tests call runAttachmentGc
 * directly and never hold timers.
 */
export function startAttachmentGc(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const tick = () => {
    runAttachmentGc(db, env).catch((e) =>
      console.error(`[hoborouter] attachment GC sweep failed: ${String(e)}`),
    );
  };
  tick();
  const timer = setInterval(tick, ATTACHMENT_GC_INTERVAL_MS);
  return () => clearInterval(timer);
}
