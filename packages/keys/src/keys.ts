// sk-hbr- API key generation/verification.
// Plaintext format: `sk-hbr-` + 43 base64url chars (32 CSPRNG bytes, no padding).
// Only SHA-256 hex is stored. Status: 'active' is legacy and treated as enabled.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { apiKeys, apiKeyModelPermissions, type Db, type Tx } from "@hoborouter/db";

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
  purpose: "generic" | "chat";
}

/** Hash + lookup. Returns null for unknown/disabled/revoked/removed keys. Used by /v1 auth. */
export async function verifyApiKey(db: Db | Tx, plaintext: string): Promise<ApiKeyRecord | null> {
  if (typeof plaintext !== "string" || !plaintext.startsWith(PREFIX)) return null;
  const rows = await db
    .select({
      api_key_id: apiKeys.id,
      workspace_id: apiKeys.workspace_id,
      status: apiKeys.status,
      purpose: apiKeys.purpose,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.key_hash, hashApiKey(plaintext)),
        inArray(apiKeys.status, ["active", "enabled"]),
        // soft-deleted (removed) keys must never authenticate even if their
        // status column still reads 'enabled'
        isNull(apiKeys.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Zero permission rows = unrestricted (true); otherwise model must be in the set. */
export async function isModelAllowed(
  db: Db | Tx,
  apiKeyId: string,
  modelId: string,
): Promise<boolean> {
  const hasAny = await db
    .select({ x: apiKeyModelPermissions.api_key_id })
    .from(apiKeyModelPermissions)
    .where(eq(apiKeyModelPermissions.api_key_id, apiKeyId))
    .limit(1);
  if (hasAny.length === 0) return true;
  const hit = await db
    .select({ x: apiKeyModelPermissions.model_id })
    .from(apiKeyModelPermissions)
    .where(
      and(
        eq(apiKeyModelPermissions.api_key_id, apiKeyId),
        eq(apiKeyModelPermissions.model_id, modelId),
      ),
    )
    .limit(1);
  return hit.length > 0;
}
