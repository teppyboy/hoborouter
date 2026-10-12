// Admin reasoning-route form contract: payload mirrors the server's
// POST /api/v1/admin/catalog/models/:id/reasoning-routes validation
// (effort ladder, required upstream model, optional provider/upstream effort).
import { test, expect } from "bun:test";
import {
  adminModelsCopy,
  reasoningRoutePayload,
  type ReasoningRouteRow,
} from "../apps/web/src/pages/admin/models";
import { REASONING_EFFORTS } from "../apps/web/src/pages/chat/reasoning";

test("payload accepts a minimal route: effort + upstream model only", () => {
  const r = reasoningRoutePayload({
    public_effort: "high",
    upstream_model: "z-ai/glm-5.3-flash",
    provider: "",
    upstream_effort: null,
  });
  expect(r).toEqual({
    ok: true,
    body: { public_effort: "high", upstream_model: "z-ai/glm-5.3-flash" },
  });
});

test("upstream_effort omitted when 'same as public' so the server fills it", () => {
  const r = reasoningRoutePayload({
    public_effort: "low",
    upstream_model: "upstream/x",
    provider: "  ",
    upstream_effort: null,
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect("upstream_effort" in r.body).toBe(false);
    expect("provider" in r.body).toBe(false);
  }
});

test("explicit upstream_effort and trimmed provider are forwarded", () => {
  const r = reasoningRoutePayload({
    public_effort: "medium",
    upstream_model: " upstream/x ",
    provider: " vertex ",
    upstream_effort: "xhigh",
  });
  expect(r).toEqual({
    ok: true,
    body: {
      public_effort: "medium",
      upstream_model: "upstream/x",
      provider: "vertex",
      upstream_effort: "xhigh",
    },
  });
});

test("empty upstream_effort string behaves like null (same as public)", () => {
  const r = reasoningRoutePayload({
    public_effort: "high",
    upstream_model: "upstream/x",
    provider: "",
    upstream_effort: "",
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect("upstream_effort" in r.body).toBe(false);
});

test("unknown public effort is rejected before any request is built", () => {
  expect(
    reasoningRoutePayload({
      public_effort: "ultra",
      upstream_model: "upstream/x",
      provider: "",
      upstream_effort: null,
    }),
  ).toEqual({ ok: false, error: "effortRequired" });
  expect(
    reasoningRoutePayload({
      public_effort: "",
      upstream_model: "upstream/x",
      provider: "",
      upstream_effort: null,
    }),
  ).toEqual({ ok: false, error: "effortRequired" });
});

test("blank upstream model is rejected", () => {
  expect(
    reasoningRoutePayload({
      public_effort: "high",
      upstream_model: "   ",
      provider: "",
      upstream_effort: null,
    }),
  ).toEqual({ ok: false, error: "upstreamModelRequired" });
});

test("invalid explicit upstream effort is rejected; ladder values pass", () => {
  expect(
    reasoningRoutePayload({
      public_effort: "high",
      upstream_model: "upstream/x",
      provider: "",
      upstream_effort: "extreme",
    }),
  ).toEqual({ ok: false, error: "upstreamEffortInvalid" });
  for (const e of REASONING_EFFORTS) {
    const r = reasoningRoutePayload({
      public_effort: e,
      upstream_model: "upstream/x",
      provider: "",
      upstream_effort: e,
    });
    expect(r.ok).toBe(true);
  }
});

test("every payload error key has bilingual copy in adminModelsCopy", () => {
  for (const key of ["effortRequired", "upstreamEffortInvalid", "upstreamModelRequired"] as const) {
    expect(adminModelsCopy[key].en.length).toBeGreaterThan(0);
    expect(adminModelsCopy[key].vi.length).toBeGreaterThan(0);
  }
});

test("history rows carry an enabled flag so replaced routes stay visible", () => {
  const row: ReasoningRouteRow = {
    id: "r1",
    public_effort: "high",
    provider: "cpa",
    upstream_model: "upstream/x",
    upstream_effort: "high",
    enabled: false,
    created_at: 1,
    updated_at: 2,
  };
  expect(row.enabled).toBe(false);
});
