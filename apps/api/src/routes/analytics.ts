// Bounded usage/activity analytics (Task 5, OpenRouter parity plan).
// Workspace-authorized (member+, session cookie — same gate as dashboard):
// every query is filtered by workspace_id server-side; cross-workspace access
// and non-members both get 403. Bounded in every dimension: date span capped
// (MAX_SPAN_MS), limit capped (MAX_LIMIT), and keyset cursor pagination
// (opaque base64url of the last dimension tuple) so no query can scan without
// bounds. Privacy: only public_model / key_prefix / UTC day dimensions and
// request/token/charged-VND metrics — never upstream_model, provider internals,
// upstream costs/markup, or key hashes (zod strictObject rejects unknown fields).
import { Elysia, t } from "elysia";
import { z } from "zod";
import type { Db } from "@hoborouter/db";
import { apiKeys, usageLogs } from "@hoborouter/db";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { jsonError, requireSession, requireWsRole } from "../authz";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SPAN_MS = 366 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DIMENSIONS = ["public_model", "key_prefix", "day"] as const;
const METRICS = [
  "requests",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
  "charged_vnd",
] as const;

type Dimension = (typeof DIMENSIONS)[number];
type Metric = (typeof METRICS)[number];

const queryBodySchema = z
  .strictObject({
    workspace_id: z.string().min(1),
    metrics: z.array(z.enum(METRICS)).min(1).max(METRICS.length),
    dimensions: z.array(z.enum(DIMENSIONS)).min(1).max(3),
    date_from: z.number().int().nonnegative(),
    date_to: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().max(512).optional(),
  })
  .refine((b) => b.date_to > b.date_from, { message: "date_to must be after date_from" })
  .refine((b) => b.date_to - b.date_from <= MAX_SPAN_MS, {
    message: `date range exceeds ${MAX_SPAN_MS / DAY_MS} days`,
  })
  .refine((b) => new Set(b.dimensions).size === b.dimensions.length, {
    message: "dimensions must be unique",
  });

// Dimension SQL expressions. All are coalesced to non-null text so the keyset
// row-tuple comparison and JSON cursors are well-defined; key_prefix "" maps
// back to null in responses (no key attribution is a legitimate state).
const dimensionExpr = (d: Dimension): SQL => {
  switch (d) {
    case "public_model":
      return sql`${usageLogs.public_model}`;
    case "key_prefix":
      return sql`coalesce(${apiKeys.key_prefix}, '')`;
    case "day":
      return sql`to_char(to_timestamp(${usageLogs.created_at} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  }
};

const num = (e: SQL) => e.mapWith(Number);

const metricExpr = (m: Metric): SQL => {
  switch (m) {
    case "requests":
      return num(sql`count(*)`);
    case "input_tokens":
      return num(sql`coalesce(sum(${usageLogs.input_tokens}), 0)`);
    case "output_tokens":
      return num(sql`coalesce(sum(${usageLogs.output_tokens}), 0)`);
    case "cached_input_tokens":
      return num(sql`coalesce(sum(${usageLogs.cached_input_tokens}), 0)`);
    case "reasoning_tokens":
      return num(sql`coalesce(sum(${usageLogs.reasoning_tokens}), 0)`);
    case "charged_vnd":
      return num(sql`coalesce(sum(coalesce(${usageLogs.charged_vnd}, 0)), 0)`);
  }
};

// Integer-bounded money/token columns -> sums stay in safe number range, so
// Number mapping cannot drift VND values.
const cacheHitExpr = () =>
  sql<
    number | null
  >`case when coalesce(sum(${usageLogs.input_tokens}), 0) = 0 then null else sum(${usageLogs.cached_input_tokens})::double precision / sum(${usageLogs.input_tokens}) end`.mapWith(
    (v) => (v === null ? null : Number(v)),
  );

function encodeCursor(values: string[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  dimensions: number,
): { ok: true; values: string[] } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== dimensions ||
      parsed.some((v) => typeof v !== "string")
    ) {
      return { ok: false };
    }
    return { ok: true, values: parsed as string[] };
  } catch {
    return { ok: false };
  }
}

const parseBoundedWindow = (fromRaw?: string, toRaw?: string) => {
  const now = Date.now();
  const to = toRaw === undefined ? now : Number.parseInt(toRaw, 10);
  const from = fromRaw === undefined ? to - 30 * DAY_MS : Number.parseInt(fromRaw, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return null;
  if (to - from > MAX_SPAN_MS) return null;
  return { from, to };
};

const parseLimitParam = (raw?: string) => {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};

interface RunOpts {
  db: Db;
  workspaceId: string;
  from: number;
  to: number;
  limit: number;
  dimensions: Dimension[];
  metrics?: Metric[]; // undefined = activity's fixed set + cache hit rate
  cursor?: string;
}

// Shared bounded rollup engine for /analytics/activity and /analytics/query.
// Keyset pagination: rows ordered by the dimension tuple; the cursor is the
// last returned tuple and the next page continues strictly after it, so deep
// paging stays O(limit) per request with a stable order.
async function runAnalytics(opts: RunOpts) {
  const { db, workspaceId, from, to, limit } = opts;
  const dimensions = opts.dimensions;
  const exprs = dimensions.map(dimensionExpr);

  let cursorTuple: string[] | null = null;
  if (opts.cursor !== undefined) {
    const decoded = decodeCursor(opts.cursor, dimensions.length);
    if (!decoded.ok) return { error: jsonError(400, "INVALID", "Invalid cursor") } as const;
    cursorTuple = decoded.values;
  }

  const selection: Record<string, SQL | ReturnType<typeof num>> = {};
  exprs.forEach((e, i) => {
    selection[`d${i}`] = e;
  });
  if (opts.metrics) {
    for (const m of opts.metrics) selection[m] = metricExpr(m);
  } else {
    selection.requests = metricExpr("requests");
    selection.input_tokens = metricExpr("input_tokens");
    selection.output_tokens = metricExpr("output_tokens");
    selection.charged_vnd = metricExpr("charged_vnd");
    selection.cache_hit_rate = cacheHitExpr();
  }

  const rows = (await db
    .select(selection)
    .from(usageLogs)
    .leftJoin(apiKeys, eq(apiKeys.id, usageLogs.api_key_id))
    .where(
      and(
        eq(usageLogs.workspace_id, workspaceId),
        gte(usageLogs.created_at, from),
        lte(usageLogs.created_at, to),
        cursorTuple
          ? sql`(${sql.join(exprs, sql`, `)}) > (${sql.join(
              cursorTuple.map((v) => sql`${v}`),
              sql`, `,
            )})`
          : undefined,
      ),
    )
    // Group and order both use the exact dimension tuple so the keyset cursor
    // (last tuple, strictly-after comparison) is stable across pages.
    .groupBy(...exprs)
    .orderBy(...exprs)
    .limit(limit + 1)) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const data = page.map((row) => {
    const values = exprs.map((_, i) => {
      const v = row[`d${i}`];
      return v === "" ? null : (v as string);
    });
    if (opts.metrics) {
      const metrics: Record<string, number> = {};
      for (const m of opts.metrics) metrics[m] = row[m] as number;
      return { dimensions: values, metrics };
    }
    return {
      group: values[0],
      requests: row.requests as number,
      input_tokens: row.input_tokens as number,
      output_tokens: row.output_tokens as number,
      charged_vnd: row.charged_vnd as number,
      cache_hit_rate: row.cache_hit_rate as number | null,
    };
  });

  const last = page[page.length - 1] as Record<string, unknown> | undefined;
  const nextCursor =
    hasMore && last ? encodeCursor(exprs.map((_, i) => String(last[`d${i}`] ?? ""))) : null;
  return { data, next_cursor: nextCursor } as const;
}

export const analyticsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "analytics" })
    .get(
      "/api/v1/analytics/activity",
      {
        query: t.Object({
          workspace_id: t.String(),
          group_by: t.Optional(t.String()),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          cursor: t.Optional(t.String()),
        }),
        detail: {
          tags: ["Analytics"],
          summary: "Workspace activity rollup",
          description:
            "Bounded rollup (requests/tokens/charged VND/cache hit rate) grouped by public model, key prefix, or UTC day (member+).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, query }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, query.workspace_id, gate.session.user.id, "member");
        if (denied) return denied;
        const groupBy = (query.group_by ?? "day") as Dimension;
        if (!DIMENSIONS.includes(groupBy))
          return jsonError(400, "INVALID", "group_by must be one of " + DIMENSIONS.join(", "));
        const win = parseBoundedWindow(query.from, query.to);
        if (!win)
          return jsonError(
            400,
            "INVALID",
            `from/to must be epoch ms with a span of at most ${MAX_SPAN_MS / DAY_MS} days`,
          );
        const result = await runAnalytics({
          db,
          workspaceId: query.workspace_id,
          from: win.from,
          to: win.to,
          limit: parseLimitParam(query.limit),
          dimensions: [groupBy],
          cursor: query.cursor,
        });
        if ("error" in result) return result.error;
        return result;
      },
    )
    .post(
      "/api/v1/analytics/query",
      {
        detail: {
          tags: ["Analytics"],
          summary: "Bounded analytics query",
          description:
            "Grouped usage metrics over public dimensions with bounded dates and keyset cursor pagination (member+). Private upstream/provider fields are rejected.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const raw: unknown = await request.json().catch(() => null);
        const parsed = queryBodySchema.safeParse(raw);
        if (!parsed.success) return jsonError(400, "INVALID", "Request failed validation");
        const body = parsed.data;
        const denied = await requireWsRole(db, body.workspace_id, gate.session.user.id, "member");
        if (denied) return denied;
        const result = await runAnalytics({
          db,
          workspaceId: body.workspace_id,
          from: body.date_from,
          to: body.date_to,
          limit: body.limit ?? DEFAULT_LIMIT,
          dimensions: body.dimensions,
          metrics: body.metrics,
          cursor: body.cursor,
        });
        if ("error" in result) return result.error;
        return result;
      },
    );
