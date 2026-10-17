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

export function userLockCount(): number {
  return userLocks.size;
}

export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  userLocks.set(userId, tail);
  void tail.then(() => {
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  });
  return run;
}

/**
 * Write to a restrictive temp file, let `commit` finish its database transaction
 * around `finalize`, then atomically rename into place.
 */
export function persistAttachmentFile<T>(
  dir: string,
  id: string,
  bytes: Uint8Array,
  commit: (finalize: () => void) => Promise<T>,
): Promise<T> {
  const tmp = `${attachmentPath(dir, id)}.tmp`;
  return (async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    let renamed = false;
    try {
      const result = await commit(() => {
        renameSync(tmp, attachmentPath(dir, id));
        renamed = true;
      });
      if (!renamed) {
        renameSync(tmp, attachmentPath(dir, id));
        renamed = true;
      }
      return result;
    } catch (e) {
      for (const path of [tmp, ...(renamed ? [attachmentPath(dir, id)] : [])]) {
        try {
          unlinkSync(path);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
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
