import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { generateApiKey, hashApiKey, verifyApiKey, isModelAllowed } from "../src/keys";

describe("generateApiKey", () => {
  test("format: sk-hbr- + 43 base64url chars (32 CSPRNG bytes, no padding)", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext).toMatch(/^sk-hbr-[A-Za-z0-9_-]{43}$/);
  });

  test("hash is SHA-256 hex of plaintext; hashApiKey unchanged", () => {
    const { plaintext, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(plaintext));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two generations differ (entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateApiKey().plaintext);
    expect(seen.size).toBe(50);
  });

  test("prefix shows first4 + ... + last6 of secret, never full plaintext", () => {
    const { plaintext, prefix } = generateApiKey();
    const secret = plaintext.slice("sk-hbr-".length);
    expect(prefix).toBe("sk-hbr-" + secret.slice(0, 4) + "..." + secret.slice(-6));
    expect(prefix).not.toContain(secret);
  });
});

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws1','w','active',1)`,
  );
});

afterAll(async () => {
  await drop();
});

/** Insert an api_keys row; key_hash set after so the trigger-safe seed mirrors the old flow. */
async function seededKey(status: string) {
  const { plaintext } = generateApiKey();
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
    VALUES (${id}, 'ws1', 'hash', 'pfx', 'k', ${status}, 1)`);
  await db.execute(sql`UPDATE api_keys SET key_hash = ${hashApiKey(plaintext)} WHERE id = ${id}`);
  return { id, plaintext };
}

describe("verifyApiKey", () => {
  test("active (legacy) key resolves workspace", async () => {
    const { id, plaintext } = await seededKey("active");
    const hit = await verifyApiKey(db, plaintext);
    expect(hit?.workspace_id).toBe("ws1");
    expect(hit?.api_key_id).toBe(id);
  });

  test("enabled key verifies", async () => {
    const { plaintext } = await seededKey("enabled");
    expect(await verifyApiKey(db, plaintext)).not.toBeNull();
  });

  test("disabled → null", async () => {
    const { plaintext } = await seededKey("disabled");
    expect(await verifyApiKey(db, plaintext)).toBeNull();
  });

  test("revoked → null", async () => {
    const { plaintext } = await seededKey("revoked");
    expect(await verifyApiKey(db, plaintext)).toBeNull();
  });

  test("unknown plaintext → null", async () => {
    await seededKey("enabled");
    expect(
      await verifyApiKey(db, "sk-hbr-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    ).toBeNull();
  });
});

async function withModels(keyId: string, models: string[]) {
  await db.execute(sql`
    INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
    VALUES (${keyId}, 'ws1', ${keyId}, 'p', 'k', 'enabled', 1)`);
  for (const m of models) {
    await db.execute(sql`
      INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at)
      VALUES (${m}, ${m}, 's', 'd', 'p', 1, 1)`);
    if (m.endsWith("-perm")) {
      await db.execute(sql`
        INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at)
        VALUES (${keyId}, ${m}, 1)`);
    }
  }
}

describe("isModelAllowed", () => {
  test("zero permission rows = unrestricted", async () => {
    await withModels("k1", ["m-a"]);
    expect(await isModelAllowed(db, "k1", "m-a")).toBe(true);
    expect(await isModelAllowed(db, "k1", "m-anything")).toBe(true);
  });

  test("with permission rows: allowed only for listed models", async () => {
    await withModels("k1b", ["m-a-perm", "m-b-perm", "m-c"]);
    expect(await isModelAllowed(db, "k1b", "m-a-perm")).toBe(true);
    expect(await isModelAllowed(db, "k1b", "m-b-perm")).toBe(true);
    expect(await isModelAllowed(db, "k1b", "m-c")).toBe(false);
  });
});
