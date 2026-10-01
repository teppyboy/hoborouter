// sk-hbr- API key generation/verification.
// Plaintext format: `sk-hbr-` + 43 base64url chars (32 CSPRNG bytes, no padding).
// Only SHA-256 hex is stored. Status: 'active' is legacy and treated as enabled.
import type { Database } from "bun:sqlite";

const PREFIX = "sk-hbr-";

export function hashApiKey(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = PREFIX + Buffer.from(bytes).toString("base64url"); // 43 chars
  return { plaintext, hash: hashApiKey(plaintext), prefix: displayPrefix(plaintext) };
}

export function displayPrefix(plaintext: string): string {
  const secret = plaintext.startsWith(PREFIX) ? plaintext.slice(PREFIX.length) : plaintext;
  return PREFIX + secret.slice(0, 4) + "..." + secret.slice(-6);
}

export interface ApiKeyRecord {
  api_key_id: string;
  workspace_id: string;
  status: string;
}

/** Hash + lookup. Returns null for unknown/disabled/revoked keys. Used by /v1 auth. */
export function verifyApiKey(db: Database, plaintext: string): ApiKeyRecord | null {
  if (typeof plaintext !== "string" || !plaintext.startsWith(PREFIX)) return null;
  const row = db
    .prepare(
      "SELECT id AS api_key_id, workspace_id, status FROM api_keys WHERE key_hash = ? AND status IN ('active','enabled')",
    )
    .get(hashApiKey(plaintext)) as ApiKeyRecord | undefined;
  return row ?? null;
}

/** Zero permission rows = unrestricted (true); otherwise model must be in the set. */
export function isModelAllowed(db: Database, apiKeyId: string, modelId: string): boolean {
  const hasAny = db
    .prepare("SELECT 1 FROM api_key_model_permissions WHERE api_key_id = ? LIMIT 1")
    .get(apiKeyId);
  if (!hasAny) return true;
  return (
    db
      .prepare(
        "SELECT 1 FROM api_key_model_permissions WHERE api_key_id = ? AND model_id = ? LIMIT 1",
      )
      .get(apiKeyId, modelId) != null
  );
}
