// Cheapest-first automatic routing for the `hoborouter/auto` public id.
// Resolution is ONE-TIME selection of a single published model BEFORE the
// wallet cap/reservation: the gateway then bills and routes through the
// unchanged existing path exactly as if the client had named the resolved
// public model. No upstream retry, no provider conversion, no second router.
//
// Honest heuristics only: context fit uses the same 1 token per body byte
// bound as billing, capability fit reads declared catalog capabilities, and
// health reads recent request outcomes. There is no fake exact tokenizer and
// no per-request CPA health API call (too expensive); with no history the
// health label is "unknown", never a fabricated "healthy".
import type { Db } from "@hoborouter/db";
import { requests } from "@hoborouter/db";
import { isModelAllowed } from "@hoborouter/keys";
import { estimateCapVnd } from "@hoborouter/wallet";
import {
  isAutoPublicId,
  listAutoCandidates,
  type MappingRow,
  type ModelRow,
  type PriceRow,
} from "@hoborouter/catalog";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { instanceSettings } from "@hoborouter/db";

export type AutoResolved = {
  model: ModelRow;
  mapping: MappingRow;
  price: PriceRow;
  /** "unknown" = too little recent history to judge; never fabricated. */
  health: "healthy" | "unknown";
};

// Health window: a candidate is "known bad" only with enough recent completed
// requests AND a majority of upstream_error outcomes (provider/model failure —
// client_abort and unknown outcomes are not the model's fault).
const HEALTH_WINDOW_MS = 15 * 60 * 1000;
const HEALTH_MIN_SAMPLES = 3;
const HEALTH_FAILURE_RATE = 0.5;

/**
 * Conservative input-size heuristic, shared with the gateway's billing bound:
 * a JSON body of N bytes can never tokenize to MORE than N tokens (1 token per
 * byte). We therefore treat bodyBytes as the worst-case input token count —
 * no exact tokenizer, no under-estimate, never a fabricated precision.
 */
const TOKENS_PER_BODY_BYTE = 1;

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Effective prompt caching for a model, IDENTICAL semantics to the gateway's
 * and public-catalog's effectiveCachingOn: per-model 'on'/'off' wins, 'inherit'
 * follows instance_settings.prompt_caching_enabled (default true when unset).
 * Duplicated here (not imported) because the readers live in route modules the
 * resolver must not depend on; the setting key is the single shared contract.
 */
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

function firstPositiveInt(values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1) return v;
  }
  return null;
}

/** True when any message carries image content (chat or responses shape). */
function wantsVision(body: Record<string, unknown>): boolean {
  const messages = body.messages ?? body.input;
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (typeof m !== "object" || m === null) return false;
    const content = (m as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as Record<string, unknown>).type === "image_url" ||
          (p as Record<string, unknown>).type === "input_image"),
    );
  });
}

/**
 * Capability fit. needs starts at "chat" (both gateway protocols are
 * chat-shaped); declared capabilities must cover every need. Null capabilities
 * declare no restrictions: plain chat passes, tools/vision do not
 * (conservative — we cannot know an undeclared model supports them).
 */
function capabilityOk(caps: string[] | null, needs: string[]): boolean {
  if (caps === null) return needs.every((n) => n === "chat");
  return needs.every((n) => caps.includes(n));
}

type Candidate = { model: ModelRow; mapping: MappingRow; price: PriceRow };

/**
 * Resolve ONE eligible candidate for an auto request, or null when nothing
 * is eligible (caller falls back to the configured `hoborouter/auto` model).
 * Candidates are filtered by context fit, capability fit, and the calling
 * key's model permissions (an auto candidate must be allowed by key, not
 * just by alias), then ranked by canonical calculateCharge-based worst-case
 * estimate — cheapest first. A candidate with a recent majority-failure
 * history is skipped when a healthier candidate exists.
 */
export async function resolveAutoModel(
  db: Db,
  opts: {
    apiKeyId: string;
    body: Record<string, unknown>;
    bodyBytes: number;
    fxRate: number;
    now?: number;
  },
): Promise<AutoResolved | null> {
  const now = opts.now ?? Date.now();
  const requestedMax = firstPositiveInt([
    opts.body.max_tokens,
    opts.body.max_completion_tokens,
    opts.body.max_output_tokens,
  ]);
  // Context fit is a SUM bound, not independent bounds: worst-case input
  // (1 token per body byte, see TOKENS_PER_BODY_BYTE) PLUS the requested (or
  // default) max output must fit the window together — a model whose window
  // holds each part alone but not both is excluded. An unset max output uses
  // the same default the gateway bills with.
  const maxOutputTokens = requestedMax ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const needs = ["chat"];
  if (Array.isArray(opts.body.tools) && opts.body.tools.length > 0) needs.push("tools");
  if (wantsVision(opts.body)) needs.push("vision");

  const eligible: Candidate[] = [];
  let globalCaching: boolean | null = null; // read once, lazily, only if an 'inherit' model appears
  for (const c of await listAutoCandidates(db, now)) {
    // Both auto aliases are routing triggers, never routing targets.
    if (isAutoPublicId(c.model.public_id)) continue;
    const ctx = c.model.context_window;
    if (ctx === null) continue;
    // Input estimate + max output must fit the window TOGETHER (sum bound).
    if (opts.bodyBytes * TOKENS_PER_BODY_BYTE + maxOutputTokens > ctx) continue;
    if (!capabilityOk(c.model.capabilities, needs)) continue;
    // Key-model permissions must allow the candidate itself.
    if (!(await isModelAllowed(db, opts.apiKeyId, c.model.id))) continue;
    eligible.push(c);
  }
  if (eligible.length === 0) return null;

  const ranked = (
    await Promise.all(
      eligible.map(async (c) => {
        const ctx = c.model.context_window as number;
        // Effective prompt-caching prices: cached tokens bill at the cached
        // rate only when caching is effectively ON for the model; when OFF
        // they bill at the full input rate, so the estimate uses that same
        // effective rate (estimateCapVnd still folds both through max() — the
        // ranking stays a worst-case cap, never an optimistic cache-hit bet).
        const cachingOn =
          c.model.prompt_caching === "inherit"
            ? (globalCaching ??= await effectiveCachingOn(db, "inherit"))
            : await effectiveCachingOn(db, c.model.prompt_caching);
        const est = estimateCapVnd(
          {
            maxInputTokens: Math.max(1, Math.min(opts.bodyBytes * TOKENS_PER_BODY_BYTE, ctx)),
            maxOutputTokens: Math.max(1, Math.min(maxOutputTokens, ctx)),
          },
          {
            inputUsdMicroPer1m: c.price.input_usd_micro_per_1m,
            outputUsdMicroPer1m: c.price.output_usd_micro_per_1m,
            cachedInputUsdMicroPer1m: cachingOn
              ? c.price.cached_input_usd_micro_per_1m
              : c.price.input_usd_micro_per_1m,
            reasoningUsdMicroPer1m: c.price.reasoning_usd_micro_per_1m,
          },
          opts.fxRate,
          c.price.markup_ppm,
        );
        return { c, est };
      }),
    )
  ).sort((a, b) => a.est - b.est || a.c.model.public_id.localeCompare(b.c.model.public_id));

  // One grouped read; per-request CPA health probing would be too expensive.
  const ids = ranked.map((r) => r.c.model.id);
  const healthRows = (await db
    .select({
      model_id: requests.model_id,
      total: sql<string>`count(*)`,
      failures: sql<string>`count(*) filter (where ${requests.status} = 'upstream_error')`,
    })
    .from(requests)
    .where(
      and(
        inArray(requests.model_id, ids),
        gte(requests.created_at, now - HEALTH_WINDOW_MS),
        ne(requests.status, "pending"),
      ),
    )
    .groupBy(requests.model_id)) as { model_id: string; total: string; failures: string }[];
  const bad = new Set<string>();
  const sampled = new Set<string>();
  for (const r of healthRows) {
    const total = Number(r.total);
    if (total < HEALTH_MIN_SAMPLES) continue;
    sampled.add(r.model_id);
    if (Number(r.failures) / total >= HEALTH_FAILURE_RATE) bad.add(r.model_id);
  }
  const pick = ranked.find((r) => !bad.has(r.c.model.id));
  if (!pick) return null;
  return {
    ...pick.c,
    health: sampled.has(pick.c.model.id) ? "healthy" : "unknown",
  };
}
