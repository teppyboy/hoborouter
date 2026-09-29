import { describe, expect, test } from "bun:test";
import { createDb, migrate } from "@hoborouter/db";
import { generateApiKey, hashApiKey, verifyApiKey } from "../src/keys";

describe("generateApiKey", () => {
  test("format: sk-hbr- + 32 hex chars", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext).toMatch(/^sk-hbr-[0-9a-f]{32}$/);
  });

  test("hash is SHA-256 hex of plaintext", () => {
    const { plaintext, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(plaintext));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two generations differ", () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext);
  });

  test("prefix shows sk-hbr-…last4, never full plaintext", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix).toBe("sk-hbr-…" + plaintext.slice(-4));
    expect(prefix).not.toBe(plaintext);
  });
});

describe("verifyApiKey", () => {
  test("active key resolves workspace; revoked/unknown → null", () => {
    const db = createDb(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws1','w','active',1)",
    ).run();
    const { plaintext } = generateApiKey();
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,'hash','pfx','k','active',1)",
    ).run(id, "ws1");
    // wrong token → null
    expect(verifyApiKey(db, plaintext)).toBeNull();
    // bind hash
    db.prepare("UPDATE api_keys SET key_hash = ? WHERE id = ?").run(hashApiKey(plaintext), id);
    const hit = verifyApiKey(db, plaintext);
    expect(hit?.workspace_id).toBe("ws1");
    expect(hit?.api_key_id).toBe(id);
    // revoke → immediately invalid
    db.prepare("UPDATE api_keys SET status='revoked', revoked_at=2 WHERE id = ?").run(id);
    expect(verifyApiKey(db, plaintext)).toBeNull();
  });
});
