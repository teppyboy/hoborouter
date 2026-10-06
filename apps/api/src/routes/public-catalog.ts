// Unauthenticated public routes (BMC P1-1/P1-3): published catalog pricing and
// instance contact info for landing/pricing/support pages.
// - Catalog: ONLY published+enabled+mapped+priced models; prices are computed
//   with the SAME calculateCharge math billing uses (canonical FX from
//   HBR_USD_VND_RATE + the immutable price row's markup, BigInt ceiling at the
//   same steps as settlement) — never a second price path, never raw upstream
//   rates or secondary float. No upstream model ids, no markup/FX internals.
// - Instance: display name + support links from instance_settings; api_base_url
//   comes ONLY from trusted configured env (same source as auth baseURL) —
//   never from the untrusted request Host or other headers. No credentials.
import { Elysia } from "elysia";
import { type Db } from "@hoborouter/db";
import { eq } from "drizzle-orm";
import { instanceSettings, subscriptionPlans } from "@hoborouter/db";
import {
  listPublicModels,
  getCurrentPrice,
  type ModelRow,
  type PriceRow,
} from "@hoborouter/catalog";
import { calculateCharge, type PriceSnapshot, type UsageTokens } from "@hoborouter/wallet";
import { parseUsdCents, usdCentsToVndCeiling } from "@hoborouter/payments";
import { readPaymentLimits } from "../payment-creation";

// Public API shapes (consumed by the public web pages; mirrored in the web
// client during integration — keep byte-compatible with the handlers below).
export type PublicCatalogItem = {
  public_id: string;
  display_name: string;
  provider: string;
  description: string | null;
  capabilities: string[];
  context_window: number | null;
  /** Effective prompt-caching mode for billing right now. */
  prompt_caching: "on" | "off";
  price_vnd_per_1m: { input: number; output: number; cached_input: number; reasoning: number };
};
export type PublicInstanceInfo = {
  name: string;
  api_base_url: string;
  support: {
    email: string | null;
    telegram: string | null;
    facebook: string | null;
    threads: string | null;
  };
};
export type PublicSubscriptionPlan = {
  id: string;
  name: string;
  /** USD rows: the current server quote at the canonical rate; legacy: stored VND. */
  price_vnd: number;
  credit_per_period_vnd: number;
  /** USD authoring group; all null for legacy VND rows. */
  price_usd: string | null;
  credit_per_period_usd: string | null;
  creation_fx_rate_vnd_per_usd: number | null;
  period_days: number;
  rate_limit_per_minute: number;
};

// Same FX source billing uses (v1-gateway): trusted env with the same
// fallback/semantics, never request-supplied data.
const intEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
const fxRate = () => BigInt(intEnv("HBR_USD_VND_RATE", 26000));

// Trusted configured base (identical expression to auth.ts / payments.ts).
const trustedBaseUrl = () =>
  process.env.BETTER_AUTH_URL || process.env.HBR_BASE_URL || "http://localhost:3000";

type Category = "input" | "output" | "cached_input" | "reasoning";

const MILLION = 1_000_000n;

// Exactly 1M tokens billed in the category's rate slot — calculateCharge then
// yields the customer-facing VND per 1M including FX + markup and the same
// ceiling rounding as a real settlement.
const CATEGORY_USAGE: Record<Category, UsageTokens> = {
  input: { inputTokens: MILLION, cachedInputTokens: 0n, outputTokens: 0n, reasoningTokens: 0n },
  output: { inputTokens: 0n, cachedInputTokens: 0n, outputTokens: MILLION, reasoningTokens: 0n },
  cached_input: {
    inputTokens: MILLION,
    cachedInputTokens: MILLION,
    outputTokens: 0n,
    reasoningTokens: 0n,
  },
  reasoning: {
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: MILLION,
    reasoningTokens: MILLION,
  },
};

export const vndPer1m = (category: Category, price: PriceRow, usdVndRate: bigint): number => {
  const snapshot: PriceSnapshot = {
    inputUsdMicroPer1m: BigInt(price.input_usd_micro_per_1m),
    outputUsdMicroPer1m: BigInt(price.output_usd_micro_per_1m),
    cachedInputUsdMicroPer1m: BigInt(price.cached_input_usd_micro_per_1m),
    reasoningUsdMicroPer1m: BigInt(price.reasoning_usd_micro_per_1m),
    usdVndRate,
    markupPpm: BigInt(price.markup_ppm),
  };
  return Number(calculateCharge(CATEGORY_USAGE[category], snapshot).chargedVnd);
};

function parseCaps(v: unknown): string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string") ? (v as string[]) : [];
}

// Effective prompt caching for billing: per-model 'on'/'off' overrides the
// global toggle; 'inherit' follows instance_settings.prompt_caching_enabled
// (default on). Same semantics as the gateway's billing decision.
async function effectiveCachingOn(db: Db, promptCaching: string): Promise<boolean> {
  if (promptCaching === "on") return true;
  if (promptCaching === "off") return false;
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "prompt_caching_enabled"))
    .limit(1);
  return rows[0] ? rows[0].value === "true" : true;
}

const toPublicItem = async (
  db: Db,
  model: ModelRow,
  price: PriceRow,
  usdVndRate: bigint,
): Promise<PublicCatalogItem> => {
  // Cached tokens bill at the cached rate only when caching is effectively ON;
  // when OFF the gateway bills them at the full input rate, so the public
  // cached_input price follows the SAME semantics (never an unguaranteed rate).
  const cachingOn = await effectiveCachingOn(db, model.prompt_caching);
  return {
    public_id: model.public_id,
    display_name: model.display_name,
    provider: model.provider,
    description: model.description,
    capabilities: parseCaps(model.capabilities),
    context_window: model.context_window,
    prompt_caching: cachingOn ? "on" : "off",
    price_vnd_per_1m: {
      input: vndPer1m("input", price, usdVndRate),
      output: vndPer1m("output", price, usdVndRate),
      cached_input: cachingOn
        ? vndPer1m("cached_input", price, usdVndRate)
        : vndPer1m("input", price, usdVndRate),
      reasoning: vndPer1m("reasoning", price, usdVndRate),
    },
  };
};

// Read a set of instance_settings keys; missing keys map to null.
export async function getPublicSettings(db: Db, keys: readonly string[]) {
  const rows = await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = map.get(k) ?? null;
  return out;
}

export const publicCatalogRoutes = (db: Db) =>
  new Elysia({ name: "public-catalog" })
    .get(
      "/api/v1/public/catalog",
      {
        detail: {
          tags: ["System"],
          summary: "Public model catalog with VND prices",
          description:
            "Unauthenticated list of published, enabled, mapped, and priced models with per-1M VND prices computed with the billing charge math.",
        },
      },
      async () => {
        const usdVndRate = fxRate();
        const rows = await listPublicModels(db);
        const data = await Promise.all(
          rows.map(async (m) => {
            const price = (await getCurrentPrice(db, m.id))!;
            return toPublicItem(db, m, price, usdVndRate);
          }),
        );
        return { data } satisfies { data: PublicCatalogItem[] };
      },
    )
    .get(
      "/api/v1/public/instance",
      {
        detail: {
          tags: ["System"],
          summary: "Public instance info",
          description:
            "Display name, trusted API base URL, and configured support channels. Never contains credentials.",
        },
      },
      async () => {
        const s = await getPublicSettings(db, [
          "display_name",
          "support_email",
          "support_telegram",
          "support_facebook",
          "support_threads",
        ]);
        const body: PublicInstanceInfo = {
          name: s.display_name?.trim() || "Hoborouter",
          api_base_url: trustedBaseUrl(),
          support: {
            email: s.support_email ?? null,
            telegram: s.support_telegram ?? null,
            facebook: s.support_facebook ?? null,
            threads: s.support_threads ?? null,
          },
        };
        return body;
      },
    )
    .get(
      "/api/v1/public/subscription-plans",
      {
        detail: {
          tags: ["System"],
          summary: "Public subscription plans",
          description:
            "Unauthenticated list of active subscription plans (price, credit, period, rate limit) as configured by the instance admin. No tiers invented, no session required.",
        },
      },
      async () => {
        // Canonical payment-settings rate: the same rate checkout resolves
        // charges with, so listed quotes can never disagree with purchase.
        const limits = await readPaymentLimits(db);
        const rows = await db
          .select({
            id: subscriptionPlans.id,
            name: subscriptionPlans.name,
            price_vnd: subscriptionPlans.price_vnd,
            credit_per_period_vnd: subscriptionPlans.credit_per_period_vnd,
            price_usd: subscriptionPlans.price_usd,
            credit_per_period_usd: subscriptionPlans.credit_per_period_usd,
            creation_fx_rate_vnd_per_usd: subscriptionPlans.creation_fx_rate_vnd_per_usd,
            period_days: subscriptionPlans.period_days,
            rate_limit_per_minute: subscriptionPlans.rate_limit_per_minute,
            created_at: subscriptionPlans.created_at,
          })
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.active, true))
          .orderBy(subscriptionPlans.created_at);
        // Cheapest first is defined on the RETURNED price: USD rows reprice at
        // the current canonical rate, so ordering on the stored fallback VND
        // can disagree with displayed prices after an FX change. Quote first,
        // sort by quote, created_at breaks ties deterministically.
        const quoted = rows
          .map((r) => ({
            row: r,
            priceVnd:
              r.price_usd !== null
                ? (usdCentsToVndCeiling(parseUsdCents(r.price_usd)!, limits.usdVndRate) ??
                   Number(r.price_vnd))
                : Number(r.price_vnd),
          }))
          .sort(
            (a, b) =>
              a.priceVnd - b.priceVnd || Number(a.row.created_at) - Number(b.row.created_at),
          );
        const data: PublicSubscriptionPlan[] = quoted.map(({ row: r, priceVnd }) => ({
          id: r.id,
          name: r.name,
          // USD rows quote at the CURRENT canonical rate (an estimate until
          // payment creation snapshots it); legacy rows keep stored price_vnd.
          price_vnd: priceVnd,
          credit_per_period_vnd: Number(r.credit_per_period_vnd),
          price_usd: r.price_usd,
          credit_per_period_usd: r.credit_per_period_usd,
          creation_fx_rate_vnd_per_usd:
            r.creation_fx_rate_vnd_per_usd === null ? null : Number(r.creation_fx_rate_vnd_per_usd),
          period_days: r.period_days,
          rate_limit_per_minute: r.rate_limit_per_minute,
        }));
        return { data, usd_vnd_rate: limits.usdVndRate };
      },
    );
