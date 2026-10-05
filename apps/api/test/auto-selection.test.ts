// Focused unit/integration tests for the auto-router model selector
// (apps/api/src/auto-resolve.ts resolveAutoModel) over real catalog fixtures:
// cheapest-wins ranking, SUM context bound (input estimate + max output),
// key-model permissions, both auto aliases excluded as targets, capability
// fit, and honest health (known-bad skip, unknown when no history).
import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { isAutoPublicId } from "@hoborouter/catalog";
import { resolveAutoModel } from "../src/auto-resolve";

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const NOW = 1_700_000_000_000;
const FX = 26000;

// Fresh DB per test: fixtures are immutable in real deployments (model_prices
// is append-only via trigger) so rows cannot be cleaned between tests; a
// per-test database (~240ms) keeps every ranking assertion isolated.
beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-auto', 'auto-test', 'active', ${NOW})`,
  );
});

afterAll(async () => {
  await t.drop();
});

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

type ModelSpec = {
  public_id: string;
  input?: number; // usd micro / 1m, default 1000
  output?: number;
  context_window?: number | null;
  capabilities?: string[] | null;
  auto_eligible?: boolean;
  published?: boolean;
  enabled?: boolean;
  prompt_caching?: "inherit" | "on" | "off";
  mapped?: boolean;
  price_effective_at?: number;
  price_retired?: boolean;
};

async function addModel(spec: ModelSpec): Promise<string> {
  const id = nextId("mdl");
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, capabilities, context_window, enabled, published, auto_eligible, prompt_caching, created_at, updated_at)
      VALUES (${id}, ${spec.public_id}, ${spec.public_id}, ${spec.public_id}, 'prov',
        ${spec.capabilities == null ? null : JSON.stringify(spec.capabilities)},
        ${spec.context_window === undefined ? 100000 : spec.context_window},
        ${spec.enabled === false ? false : true}, ${spec.published === false ? false : true},
        ${spec.auto_eligible === false ? false : true}, ${spec.prompt_caching ?? "inherit"}, ${NOW}, ${NOW})`,
  );
  if (spec.mapped !== false) {
    await db.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
        VALUES (${nextId("map")}, ${id}, 'prov', ${spec.public_id + "-upstream"}, true, ${NOW}, ${NOW})`,
    );
  }
  await db.execute(
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)
      VALUES (${nextId("price")}, ${id}, ${spec.input ?? 1000}, ${spec.output ?? 2000},
        ${Math.floor((spec.input ?? 1000) / 2)}, ${spec.output ?? 2000}, 100000,
        ${spec.price_effective_at ?? NOW - 10}, ${spec.price_retired ? NOW - 5 : null})`,
  );
  return id;
}

async function addKey(modelIds: string[] = []): Promise<string> {
  const id = nextId("key");
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
      VALUES (${id}, 'ws-auto', ${id}, 'p', 'k', 'enabled', ${NOW})`,
  );
  for (const m of modelIds) {
    await db.execute(
      sql`INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES (${id}, ${m}, ${NOW})`,
    );
  }
  return id;
}

async function addRequests(
  modelId: string,
  statuses: string[],
  createdAt = NOW - 60_000,
): Promise<void> {
  for (const status of statuses) {
    await db.execute(
      sql`INSERT INTO requests (id, workspace_id, api_key_id, model_id, endpoint, mode, status, dispatch_state, created_at)
        VALUES (${nextId("req")}, 'ws-auto', NULL, ${modelId}, '/v1/chat/completions', 'non-stream', ${status}, 'terminal', ${createdAt})`,
    );
  }
}

const BASE_BODY = { model: "hoborouter/auto", messages: [{ role: "user", content: "hi" }] };
// ~100 byte body -> 100 estimated input tokens under the 1-token-per-byte bound.
const BODY_BYTES = 100;

async function resolve(
  body: Record<string, unknown> = BASE_BODY,
  apiKeyId = "unrestricted-key",
  opts: { now?: number } = {},
) {
  return resolveAutoModel(db, {
    apiKeyId,
    body,
    bodyBytes: BODY_BYTES,
    fxRate: FX,
    now: opts.now ?? NOW,
  });
}

describe("isAutoPublicId", () => {
  test("recognizes both public aliases, nothing else", () => {
    expect(isAutoPublicId("hoborouter/auto")).toBe(true);
    expect(isAutoPublicId("auto")).toBe(true);
    expect(isAutoPublicId("openai/gpt-4o")).toBe(false);
    expect(isAutoPublicId("Auto")).toBe(false);
    expect(isAutoPublicId("auto/extra")).toBe(false);
  });
});

describe("resolveAutoModel: eligibility + cheapest selection", () => {
  test("picks the cheapest eligible auto_eligible model", async () => {
    await addModel({ public_id: "expensive", input: 5000, output: 9000 });
    await addModel({ public_id: "cheap", input: 100, output: 200 });
    await addModel({ public_id: "not-eligible", input: 1, output: 1, auto_eligible: false });
    const r = await resolve();
    expect(r).not.toBeNull();
    expect(r!.model.public_id).toBe("cheap");
    expect(r!.mapping.model_id).toBe(r!.model.id);
    expect(r!.price.model_id).toBe(r!.model.id);
  });

  test("excludes BOTH auto aliases (bare 'auto' and 'hoborouter/auto') as candidates", async () => {
    // Contrived: alias ids marked auto_eligible must never be selected.
    await addModel({ public_id: "auto", input: 1, output: 1 });
    await addModel({ public_id: "hoborouter/auto", input: 1, output: 1 });
    await addModel({ public_id: "real-model", input: 900, output: 900 });
    const r = await resolve();
    expect(r!.model.public_id).toBe("real-model");
  });

  test("requires published+enabled+mapped+currently-priced (retired price excluded)", async () => {
    await addModel({ public_id: "unpublished", input: 1, published: false });
    await addModel({ public_id: "disabled", input: 1, enabled: false });
    await addModel({ public_id: "unmapped", input: 1, mapped: false });
    await addModel({ public_id: "retired-price", input: 1, price_retired: true });
    await addModel({ public_id: "survivor", input: 700 });
    const r = await resolve();
    expect(r!.model.public_id).toBe("survivor");
  });

  test("future-effective price is not current (model excluded)", async () => {
    await addModel({ public_id: "future-priced", input: 1, price_effective_at: NOW + 60_000 });
    await addModel({ public_id: "priced-now", input: 800 });
    const r = await resolve();
    expect(r!.model.public_id).toBe("priced-now");
  });
});

describe("resolveAutoModel: context fit is a SUM bound", () => {
  test("input estimate + requested max output must fit together", async () => {
    // 100 input tokens + 1000 max output = 1100: window 1050 fits neither sum.
    await addModel({ public_id: "too-small-sum", input: 1, context_window: 1050 });
    // Window exactly at the sum boundary fits.
    await addModel({ public_id: "fits-exactly", input: 2, context_window: 1100 });
    const r = await resolve({ ...BASE_BODY, max_tokens: 1000 });
    expect(r!.model.public_id).toBe("fits-exactly");
  });

  test("each part fitting alone is NOT enough (not independent bounds)", async () => {
    // window 600 > 100 input tokens AND > 500 output tokens, but 100+500=600 sum check:
    // use window 590: holds 100 input alone and 500 output alone, not the 600 sum.
    await addModel({ public_id: "parts-fit-only", input: 1, context_window: 590 });
    const r = await resolve({ ...BASE_BODY, max_tokens: 500 });
    expect(r).toBeNull();
  });

  test("unset max output uses the 4096 default against the sum", async () => {
    await addModel({ public_id: "default-exceeds", input: 1, context_window: BODY_BYTES + 4095 });
    await addModel({ public_id: "default-fits", input: 2, context_window: BODY_BYTES + 4096 });
    const r = await resolve();
    expect(r!.model.public_id).toBe("default-fits");
  });

  test("null context_window excludes the model", async () => {
    await addModel({ public_id: "no-context", input: 1, context_window: null });
    const r = await resolve();
    expect(r).toBeNull();
  });
});

describe("resolveAutoModel: capability fit (no request conversion)", () => {
  test("tools request only fits models declaring tools", async () => {
    await addModel({ public_id: "chat-only", input: 1, capabilities: ["chat"] });
    await addModel({ public_id: "chat-tools", input: 2, capabilities: ["chat", "tools"] });
    const r = await resolve({
      ...BASE_BODY,
      tools: [{ type: "function", function: { name: "f" } }],
    });
    expect(r!.model.public_id).toBe("chat-tools");
  });

  test("null capabilities = plain chat only: vision request excludes", async () => {
    await addModel({ public_id: "caps-null", input: 1, capabilities: null });
    await addModel({ public_id: "vision-cap", input: 2, capabilities: ["chat", "vision"] });
    const vision = {
      ...BASE_BODY,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
        },
      ],
    };
    const r = await resolve(vision);
    expect(r!.model.public_id).toBe("vision-cap");
  });

  test("null capabilities pass plain chat", async () => {
    await addModel({ public_id: "plain", input: 1, capabilities: null });
    const r = await resolve();
    expect(r!.model.public_id).toBe("plain");
  });
});

describe("resolveAutoModel: key-model permissions", () => {
  test("cheapest model not permitted by key is skipped for a permitted one", async () => {
    const cheapId = await addModel({ public_id: "cheap-forbidden", input: 10 });
    const okId = await addModel({ public_id: "pricier-allowed", input: 900 });
    const key = await addKey([okId]);
    const r = await resolve(BASE_BODY, key);
    expect(r!.model.public_id).toBe("pricier-allowed");
    expect(r!.model.id).not.toBe(cheapId);
  });

  test("no permitted eligible model -> null (no fallback to a forbidden model)", async () => {
    await addModel({ public_id: "forbidden-only", input: 10 });
    // A restricted key: >=1 permission row exists, none matching the candidate.
    const other = await addModel({ public_id: "other", input: 5, auto_eligible: false });
    const key = await addKey([other]);
    const r = await resolve(BASE_BODY, key);
    expect(r).toBeNull();
  });
});

describe("resolveAutoModel: honest health", () => {
  test("majority-failure recent history (>=3 samples) is skipped for a healthy candidate", async () => {
    const bad = await addModel({ public_id: "recently-bad", input: 1 });
    await addRequests(bad, ["upstream_error", "upstream_error", "ok"]);
    const good = await addModel({ public_id: "recently-ok", input: 900 });
    await addRequests(good, ["ok", "ok", "ok"]);
    const r = await resolve();
    expect(r!.model.public_id).toBe("recently-ok");
    expect(r!.health).toBe("healthy");
  });

  test("all candidates known-bad -> null, never routes to a known-bad model", async () => {
    const bad1 = await addModel({ public_id: "bad-1", input: 1 });
    const bad2 = await addModel({ public_id: "bad-2", input: 2 });
    await addRequests(bad1, ["upstream_error", "upstream_error", "upstream_error"]);
    await addRequests(bad2, ["upstream_error", "upstream_error", "ok"]);
    const r = await resolve();
    expect(r).toBeNull();
  });

  test("fewer than 3 samples is NOT known-bad and health is 'unknown', never fabricated 'healthy'", async () => {
    const flaky = await addModel({ public_id: "two-errors", input: 1 });
    await addRequests(flaky, ["upstream_error", "upstream_error"]);
    const r = await resolve();
    expect(r).not.toBeNull();
    expect(r!.model.public_id).toBe("two-errors");
    expect(r!.health).toBe("unknown");
  });

  test("no history at all -> selected, health 'unknown'", async () => {
    await addModel({ public_id: "fresh", input: 500 });
    const r = await resolve();
    expect(r!.model.public_id).toBe("fresh");
    expect(r!.health).toBe("unknown");
  });

  test("failures outside the health window do not brand a model known-bad", async () => {
    const old = await addModel({ public_id: "old-failures", input: 1 });
    await addRequests(
      old,
      ["upstream_error", "upstream_error", "upstream_error"],
      NOW - 30 * 60_000,
    );
    const r = await resolve();
    expect(r!.model.public_id).toBe("old-failures");
    expect(r!.health).toBe("unknown");
  });

  test("client_abort/unknown outcomes are not the model's fault", async () => {
    const aborted = await addModel({ public_id: "client-aborts", input: 1 });
    await addRequests(aborted, ["client_abort", "client_abort", "unknown"]);
    const r = await resolve();
    expect(r!.model.public_id).toBe("client-aborts");
  });
});
