import { describe, expect, test } from "bun:test";
import { createDb, migrate } from "@hoborouter/db";
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

function seededKey(status: string) {
  const db = createDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws1','w','active',1)",
  ).run();
  const { plaintext } = generateApiKey();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,'hash','pfx','k',?,1)",
  ).run(id, "ws1", status);
  db.prepare("UPDATE api_keys SET key_hash = ? WHERE id = ?").run(hashApiKey(plaintext), id);
  return { db, id, plaintext };
}

describe("verifyApiKey", () => {
  test("active (legacy) key resolves workspace", () => {
    const { db, id, plaintext } = seededKey("active");
    const hit = verifyApiKey(db, plaintext);
    expect(hit?.workspace_id).toBe("ws1");
    expect(hit?.api_key_id).toBe(id);
  });

  test("enabled key verifies", () => {
    const { db, plaintext } = seededKey("enabled");
    expect(verifyApiKey(db, plaintext)).not.toBeNull();
  });

  test("disabled → null", () => {
    const { db, plaintext } = seededKey("disabled");
    expect(verifyApiKey(db, plaintext)).toBeNull();
  });

  test("revoked → null", () => {
    const { db, plaintext } = seededKey("revoked");
    expect(verifyApiKey(db, plaintext)).toBeNull();
  });

  test("unknown plaintext → null", () => {
    const { db } = seededKey("enabled");
    expect(verifyApiKey(db, "sk-hbr-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });
});

function withModels(keyId: string, models: string[]) {
  const db = createDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws1','w','active',1)",
  ).run();
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,'h','p','k','enabled',1)",
  ).run(keyId, "ws1");
  for (const m of models) {
    db.prepare(
      "INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at) VALUES (?,?,'s','d','p',1,1)",
    ).run(m, m);
    if (m.endsWith("-perm")) {
      db.prepare(
        "INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES (?,?,1)",
      ).run(keyId, m);
    }
  }
  return db;
}

describe("isModelAllowed", () => {
  test("zero permission rows = unrestricted", () => {
    const db = withModels("k1", ["m-a"]);
    expect(isModelAllowed(db, "k1", "m-a")).toBe(true);
    expect(isModelAllowed(db, "k1", "m-anything")).toBe(true);
  });

  test("with permission rows: allowed only for listed models", () => {
    const db = withModels("k1", ["m-a-perm", "m-b-perm", "m-c"]);
    expect(isModelAllowed(db, "k1", "m-a-perm")).toBe(true);
    expect(isModelAllowed(db, "k1", "m-b-perm")).toBe(true);
    expect(isModelAllowed(db, "k1", "m-c")).toBe(false);
  });
});
