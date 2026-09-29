// sk-hbr- API key generation/verification (Task 4).
// Plaintext format: `sk-hbr-` + 32 hex chars (CSPRNG). Only SHA-256 hex is stored.
import type { Database } from "bun:sqlite";

const PREFIX = "sk-hbr-";

function randomHex(nBytes: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(nBytes));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashApiKey(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = PREFIX + randomHex(16); // 16 bytes = 32 hex chars
  return { plaintext, hash: hashApiKey(plaintext), prefix: displayPrefix(plaintext) };
}

export function displayPrefix(plaintext: string): string {
  return PREFIX + "…" + plaintext.slice(-4);
}

export interface ApiKeyRecord {
  api_key_id: string;
  workspace_id: string;
  status: string;
}

/** Hash + lookup. Returns null for unknown/revoked keys. Used by /v1 auth (Task 7). */
export function verifyApiKey(db: Database, plaintext: string): ApiKeyRecord | null {
  if (typeof plaintext !== "string" || !plaintext.startsWith(PREFIX)) return null;
  const row = db
    .prepare(
      "SELECT id AS api_key_id, workspace_id, status FROM api_keys WHERE key_hash = ? AND status = 'active'",
    )
    .get(hashApiKey(plaintext)) as ApiKeyRecord | undefined;
  return row ?? null;
}
