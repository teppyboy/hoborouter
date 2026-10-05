// Public (unauthenticated) API surface: catalog pricing, instance info, and
// the admin support/channel settings that feed it.
// Contracts under test:
// - GET /api/v1/public/catalog lists ONLY published+enabled+mapped+priced
//   models, exposes no upstream ids, and its VND per-1M prices are computed
//   with the SAME calculateCharge math billing uses (exact BigInt rounding).
// - GET /api/v1/public/instance reports the trusted configured base URL
//   (never the request Host) and the configured support channels only.
// - /api/v1/admin/support-settings: instance-admin only, strict validation,
//   whole-body validation before ANY persist, every change audited, and no
//   money-history (ledger) writes ever.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { Elysia } from "elysia";
import { createTestDb, type Db } from "@hoborouter/db";
import { calculateCharge, type PriceSnapshot } from "@hoborouter/wallet";
import { createAuth } from "../src/auth";
import { publicCatalogRoutes } from "../src/routes/public-catalog";
import { supportSettingsRoutes } from "../src/routes/support-settings";

async function q<T = Record<string, unknown>>(db: Db, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const buildTestApp = (db: Db, auth: ReturnType<typeof createAuth>) =>
  new Elysia()
    .get("/api/auth/*", ({ request }) => auth.handler(request))
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(supportSettingsRoutes(db, auth))
    .use(publicCatalogRoutes(db));
let app: ReturnType<typeof buildTestApp>;
let adminCookie = "";
let userCookie = "";

const now = Date.now();

async function seed() {
  const model = (
    id: string,
    publicId: string,
    opts: { enabled?: boolean; published?: boolean } = {},
  ) =>
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, description, capabilities, context_window, enabled, published, created_at, updated_at) VALUES (${id}, ${publicId}, ${id + "-slug"}, ${id}, 'openai', ${"d-" + id}, ${JSON.stringify(["chat", "tools"])}, 128000, ${opts.enabled ?? true}, ${opts.published ?? true}, ${now}, ${now})`;
  const mapping = (id: string, modelId: string, upstream: string) =>
    sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (${id}, ${modelId}, 'openai', ${upstream}, true, ${now}, ${now})`;
  // input $1/M, cached $0.1/M, output $2/M, reasoning $0.5/M, markup 1x
  const price = (id: string, modelId: string) =>
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES (${id}, ${modelId}, 1000000, 2000000, 100000, 500000, 1000000, ${now - 1000}, NULL)`;

  // Visible: published + enabled + mapped + priced.
  await db.execute(model("mdl-pub", "openai/pub"));
  await db.execute(mapping("map-pub", "mdl-pub", "upstream-secret-pub"));
  await db.execute(price("price-pub", "mdl-pub"));
  // Unpublished.
  await db.execute(model("mdl-hidden", "openai/hidden", { published: false }));
  await db.execute(mapping("map-hidden", "mdl-hidden", "upstream-secret-hidden"));
  await db.execute(price("price-hidden", "mdl-hidden"));
  // Disabled.
  await db.execute(model("mdl-off", "openai/off", { enabled: false }));
  await db.execute(mapping("map-off", "mdl-off", "upstream-secret-off"));
  await db.execute(price("price-off", "mdl-off"));
  // No enabled mapping.
  await db.execute(model("mdl-nomap", "openai/nomap"));
  await db.execute(price("price-nomap", "mdl-nomap"));
  // No current price.
  await db.execute(model("mdl-noprice", "openai/noprice"));
  await db.execute(mapping("map-noprice", "mdl-noprice", "upstream-secret-noprice"));
  // Active + inactive subscription plans (public plans list must exclude inactive).
  const plan = (
    id: string,
    name: string,
    priceVnd: number,
    credit: number,
    active: boolean,
    rate: number,
  ) =>
    sql`INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, active, created_at) VALUES (${id}, ${name}, ${priceVnd}, ${credit}, 30, ${rate}, ${active}, ${now})`;
  await db.execute(plan("plan-a", "Starter", 99000, 100000, true, 15));
  await db.execute(plan("plan-b", "Group", 199000, 220000, true, 30));
  await db.execute(plan("plan-dead", "Old", 49000, 50000, false, 15));
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  process.env.HBR_USD_VND_RATE = "26000";
  await seed();
  const auth = createAuth(db);
  app = buildTestApp(db, auth);
  const signUp = async (email: string) => {
    const res = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "Correct-Horse-Battery-Staple-1", name: "U" }),
      }),
    );
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };
  userCookie = await signUp("pub-user@example.com");
  adminCookie = await signUp("pub-admin@example.com");
  const [row] = await q<{ id: string }>(
    db,
    sql`SELECT id FROM users WHERE email = 'pub-admin@example.com'`,
  );
  await db.execute(
    sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${row!.id}, ${Date.now()})`,
  );
}, 30000);

afterAll(async () => {
  // Guard: if beforeAll was interrupted (e.g. DB unreachable) there is nothing
  // to drop — don't mask the real failure with a teardown TypeError.
  if (t) await t.drop();
}, 30000);

// Env isolation: FX is read per request from process.env, so every test that
// could observe it sets what it needs and afterEach restores the baseline.
const ENV_KEYS = ["HBR_USD_VND_RATE", "BETTER_AUTH_URL", "HBR_BASE_URL"];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HBR_USD_VND_RATE = "26000";
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const req = (
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
};

describe("GET /api/v1/public/catalog", () => {
  test("unauthenticated, published+enabled+mapped+priced only, no upstream leak", async () => {
    const res = await req("/api/v1/public/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.map((m) => m.public_id)).toEqual(["openai/pub"]);
    // Exact item shape: no slug, no internal id, no upstream ids, no FX internals.
    expect(Object.keys(body.data[0]!).sort()).toEqual(
      [
        "capabilities",
        "context_window",
        "description",
        "display_name",
        "price_vnd_per_1m",
        "prompt_caching",
        "provider",
        "public_id",
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("upstream-secret");
    expect(JSON.stringify(body)).not.toContain("slug");
    expect(JSON.stringify(body)).not.toContain("markup");
  });

  test("price_vnd_per_1m == calculateCharge on 1M tokens (exact, canonical FX/markup)", async () => {
    const res = await req("/api/v1/public/catalog");
    const body = (await res.json()) as {
      data: { price_vnd_per_1m: Record<string, number> }[];
    };
    // Exact numbers: µUSD/M * 26000 * 1x markup -> input 26000, output 52000, cached 2600, reasoning 13000 VND.
    expect(body.data[0]!.price_vnd_per_1m).toEqual({
      input: 26000,
      output: 52000,
      cached_input: 2600,
      reasoning: 13000,
    });
    // Independent cross-check: same math the billing path runs.
    const snapshot: PriceSnapshot = {
      inputUsdMicroPer1m: 1000000n,
      outputUsdMicroPer1m: 2000000n,
      cachedInputUsdMicroPer1m: 100000n,
      reasoningUsdMicroPer1m: 500000n,
      usdVndRate: 26000n,
      markupPpm: 1000000n,
    };
    const per1m = (usage: Parameters<typeof calculateCharge>[0]) =>
      Number(calculateCharge(usage, snapshot).chargedVnd);
    const M = 1_000_000n;
    expect(body.data[0]!.price_vnd_per_1m.input).toBe(
      per1m({ inputTokens: M, cachedInputTokens: 0n, outputTokens: 0n, reasoningTokens: 0n }),
    );
    expect(body.data[0]!.price_vnd_per_1m.output).toBe(
      per1m({ inputTokens: 0n, cachedInputTokens: 0n, outputTokens: M, reasoningTokens: 0n }),
    );
    expect(body.data[0]!.price_vnd_per_1m.cached_input).toBe(
      per1m({ inputTokens: M, cachedInputTokens: M, outputTokens: 0n, reasoningTokens: 0n }),
    );
    expect(body.data[0]!.price_vnd_per_1m.reasoning).toBe(
      per1m({ inputTokens: 0n, cachedInputTokens: 0n, outputTokens: M, reasoningTokens: M }),
    );
  });

  test("cached_input follows prompt-caching semantics (global + per-model override)", async () => {
    const setGlobal = async (v: string | null) => {
      await q(db, sql`DELETE FROM instance_settings WHERE key = 'prompt_caching_enabled'`);
      if (v !== null)
        await q(
          db,
          sql`INSERT INTO instance_settings (key, value, updated_at) VALUES ('prompt_caching_enabled', ${v}, ${Date.now()})`,
        );
    };
    const setModel = (v: string) =>
      q(db, sql`UPDATE models SET prompt_caching = ${v} WHERE id = 'mdl-pub'`);
    try {
      const prices = async () => {
        const res = await req("/api/v1/public/catalog");
        const body = (await res.json()) as {
          data: { prompt_caching: string; price_vnd_per_1m: Record<string, number> }[];
        };
        return body.data[0]!;
      };
      // inherit + unset global -> ON: cached billed at the cached rate.
      let item = await prices();
      expect(item.prompt_caching).toBe("on");
      expect(item.price_vnd_per_1m.cached_input).toBe(2600);
      // global off -> cached tokens bill at the full input rate.
      await setGlobal("false");
      item = await prices();
      expect(item.prompt_caching).toBe("off");
      expect(item.price_vnd_per_1m.cached_input).toBe(26000);
      // per-model 'on' overrides global off; 'off' overrides global on.
      await setModel("on");
      item = await prices();
      expect(item.prompt_caching).toBe("on");
      expect(item.price_vnd_per_1m.cached_input).toBe(2600);
      await setGlobal("true");
      await setModel("off");
      item = await prices();
      expect(item.prompt_caching).toBe("off");
      expect(item.price_vnd_per_1m.cached_input).toBe(26000);
    } finally {
      await setGlobal(null);
      await setModel("inherit");
    }
  });
});

describe("GET /api/v1/public/instance", () => {
  test("defaults without settings; trusted base URL, no credentials", async () => {
    const res = await req("/api/v1/public/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["api_base_url", "name", "support"].sort());
    expect(body.name).toBe("Hoborouter");
    // Configured/auth base only — never derived from request headers.
    expect(body.api_base_url).toBe("http://localhost:3000");
    expect(body.support).toEqual({
      email: null,
      telegram: null,
      facebook: null,
      threads: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|key|credential/i);
  });

  test("request Host header is ignored for api_base_url", async () => {
    const res = await req("/api/v1/public/instance", { headers: { host: "evil.example" } });
    const body = (await res.json()) as { api_base_url: string };
    expect(body.api_base_url).toBe("http://localhost:3000");
  });

  test("reflects admin-configured support settings", async () => {
    await req("/api/v1/admin/support-settings", {
      method: "PUT",
      cookie: adminCookie,
      body: {
        display_name: "My Router",
        support_email: "help@hoborouter.dev",
        support_telegram: "https://t.me/hoborouter",
      },
    });
    const res = await req("/api/v1/public/instance");
    const body = (await res.json()) as {
      name: string;
      support: Record<string, string | null>;
    };
    expect(body.name).toBe("My Router");
    expect(body.support.email).toBe("help@hoborouter.dev");
    expect(body.support.telegram).toBe("https://t.me/hoborouter");
    expect(body.support.facebook).toBeNull();
    expect(body.support.threads).toBeNull();
  });
});

describe("GET /api/v1/public/subscription-plans", () => {
  test("unauthenticated active plans only, exact shape, cheapest first", async () => {
    const res = await req("/api/v1/public/subscription-plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.map((p) => p.id)).toEqual(["plan-a", "plan-b"]);
    for (const p of body.data) {
      expect(Object.keys(p).sort()).toEqual(
        [
          "credit_per_period_vnd",
          "id",
          "name",
          "period_days",
          "price_vnd",
          "rate_limit_per_minute",
        ].sort(),
      );
    }
    expect(body.data[0]).toEqual({
      id: "plan-a",
      name: "Starter",
      price_vnd: 99000,
      credit_per_period_vnd: 100000,
      period_days: 30,
      rate_limit_per_minute: 15,
    });
    expect(JSON.stringify(body)).not.toContain("plan-dead");
  });
});

describe("admin support-settings", () => {
  test("unauthenticated -> 401; non-admin -> 403", async () => {
    expect((await req("/api/v1/admin/support-settings")).status).toBe(401);
    expect((await req("/api/v1/admin/support-settings", { cookie: userCookie })).status).toBe(403);
    expect(
      (
        await req("/api/v1/admin/support-settings", {
          method: "PUT",
          cookie: userCookie,
          body: { display_name: "Nope" },
        })
      ).status,
    ).toBe(403);
  });

  test("strict validation: bad email, non-HTTPS, credential URLs rejected", async () => {
    const bad: Record<string, unknown>[] = [
      { support_email: "not-an-email" },
      { support_email: "spaces not@allowed.com" },
      { support_telegram: "http://t.me/hoborouter" },
      { support_telegram: "javascript:alert(1)" },
      { support_telegram: "data:text/html,hi" },
      { support_facebook: "https://user:pass@facebook.com/x" },
      { support_threads: "https://localhost/x" },
      // Protocol-relative and backslash tricks must never be stored.
      { support_telegram: "//t.me/hoborouter" },
      { support_telegram: "https:\\evil.example/x" },
      { support_facebook: "https://facebook.com\\@evil.example" },
      { display_name: "bad\u0007name" },
    ];
    for (const body of bad) {
      const res = await req("/api/v1/admin/support-settings", {
        method: "PUT",
        cookie: adminCookie,
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  test("whole body validated before persist: mixed valid+invalid writes NOTHING", async () => {
    // Start from a clean slate (this route only — earlier tests may have set values).
    await req("/api/v1/admin/support-settings", {
      method: "PUT",
      cookie: adminCookie,
      body: {
        display_name: null,
        support_email: null,
        support_telegram: null,
        support_facebook: null,
        support_threads: null,
      },
    });
    await req("/api/v1/admin/support-settings", {
      method: "PUT",
      cookie: adminCookie,
      body: { support_email: "clear@hoborouter.dev" },
    });
    const res = await req("/api/v1/admin/support-settings", {
      method: "PUT",
      cookie: adminCookie,
      body: {
        support_email: "https://wrong-type.example",
        support_telegram: "http://insecure.example",
      },
    });
    expect(res.status).toBe(400);
    const g = await req("/api/v1/admin/support-settings", { cookie: adminCookie });
    const body = (await g.json()) as { support: Record<string, string | null> };
    // The valid key in the mixed PUT was NOT persisted either.
    expect(body.support.email).toBe("clear@hoborouter.dev");
    expect(body.support.telegram).toBeNull();
  });

  test("roundtrip + audit, no money history writes", async () => {
    const [auditsBefore] = await q<{ c: number }>(
      db,
      sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = 'settings.update' AND target IN ('display_name','support_email','support_telegram','support_facebook','support_threads')`,
    );
    const res = await req("/api/v1/admin/support-settings", {
      method: "PUT",
      cookie: adminCookie,
      body: {
        display_name: "Round Router",
        support_email: "round@hoborouter.dev",
        support_facebook: "https://facebook.com/hoborouter",
        support_threads: "https://threads.net/@hoborouter",
      },
    });
    expect(res.status).toBe(200);
    const put = (await res.json()) as {
      display_name: string | null;
      support: Record<string, string | null>;
    };
    expect(put).toEqual({
      display_name: "Round Router",
      support: {
        email: "round@hoborouter.dev",
        telegram: null,
        facebook: "https://facebook.com/hoborouter",
        threads: "https://threads.net/@hoborouter",
      },
    });
    const g = await req("/api/v1/admin/support-settings", { cookie: adminCookie });
    expect(await g.json()).toEqual(put);

    const audits = await q<{ target: string; detail: string }>(
      db,
      sql`SELECT target, detail FROM audit_log WHERE action = 'settings.update' AND target IN ('display_name','support_email','support_telegram','support_facebook','support_threads') ORDER BY ctid OFFSET ${auditsBefore!.c}`,
    );
    const targets = audits.map((a) => a.target).sort();
    expect(targets).toEqual([
      "display_name",
      "support_email",
      "support_facebook",
      "support_threads",
    ]);
    // Every change is audited with before/after.
    const emailAudit = audits.find((a) => a.target === "support_email")!;
    expect(JSON.parse(emailAudit.detail)).toEqual({
      before: "clear@hoborouter.dev",
      after: "round@hoborouter.dev",
    });

    // Settings are not money history: ledger untouched.
    const [ledger] = await q<{ c: number }>(db, sql`SELECT COUNT(*)::int AS c FROM ledger_entries`);
    expect(ledger!.c).toBe(0);
  });
});
