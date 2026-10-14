// Chat attachment storage: bytes live on the filesystem at
// <data root>/chat-attachments/<uuid> (same data volume as avatars, derived
// from HBR_AVATAR_DIR — no new config field). The DB row is the only source
// of metadata; the filename is always the row UUID, never client input.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Storage base: the directory sibling to the avatar dir (data/chat-attachments). */
export function attachmentDir(env: Record<string, string | undefined> = process.env): string {
  const avatar = env.HBR_AVATAR_DIR || join(process.cwd(), "data", "avatars");
  return join(dirname(avatar), "chat-attachments");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only UUID row ids ever reach the filesystem path — no traversal, no symlinks. */
export function attachmentPath(dir: string, id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`attachment id is not a UUID: ${id}`);
  return join(dir, id);
}

/**
 * Per-user in-process lock: quota check + insert must serialize per user so
 * two concurrent uploads cannot both pass the 500 MiB check (lost update).
 */
const userLocks = new Map<string, Promise<unknown>>();

export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  userLocks.set(
    userId,
    run.catch(() => {}),
  );
  // Drop the tail entry once settled so the map cannot grow unbounded.
  void run.finally(() => {
    if (userLocks.get(userId) === run) userLocks.delete(userId);
  });
  return run;
}

/**
 * Write bytes to a temp file, let `commit` (the DB insert) run, then rename
 * into place. Any DB failure unlinks the temp file; a rename failure removes
 * the partially renamed file so no orphan bytes survive the failed upload.
 */
export function persistAttachmentFile<T>(
  dir: string,
  id: string,
  bytes: Uint8Array,
  commit: () => Promise<T>,
): Promise<T> {
  const tmp = `${attachmentPath(dir, id)}.tmp`;
  return (async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, bytes);
    try {
      const result = await commit();
      renameSync(tmp, attachmentPath(dir, id));
      return result;
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp already gone */
      }
      throw e;
    }
  })();
}

/** Idempotent unlink with one retry (Windows AV locks, transient EBUSY). */
export function removeAttachmentFile(dir: string, id: string): void {
  const p = attachmentPath(dir, id);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      unlinkSync(p);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (attempt === 1) throw e;
    }
  }
}
