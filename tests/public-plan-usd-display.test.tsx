import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "../apps/web/src/pages/public/pricing";
import type { PublicSubscriptionPlan } from "../apps/web/src/lib/public-queries";

// Exact public payload shape: the API intentionally exposes the required
// daily grant terms (frozen derived VND + exact authored USD text) alongside
// the price/credit fields, so the fixture carries both grant fields too.
const publicPlan = (over: Partial<PublicSubscriptionPlan>): PublicSubscriptionPlan => ({
  id: "pp1",
  name: "Pro",
  price_vnd: 259_750,
  credit_per_period_vnd: 312_012,
  period_days: 30,
  price_usd: "9.99",
  daily_grant_vnd: 130_000,
  daily_grant_usd: "5",
  ...over,
});

test("public pricing shows authored USD plan price and keeps the VND quote as an estimate", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[]}
      modelsState="ready"
      plans={[publicPlan({})]}
      plansState="ready"
    />,
  );
  expect(html).toContain("$9.99");
  expect(html).toContain("≈ 259.750 ₫ (VND estimate)");
  // No authored credit metadata: the frozen VND grant stays.
  expect(html).toContain("312.012 ₫ credit / 30 days");
  // Authored USD daily grant renders its exact text plus the frozen VND grant.
  expect(html).toContain("+ $5.00 / day");
  expect(html).toContain("VND grant 130.000 ₫ fixed at creation");
});

test("authored per-period credit renders its exact USD metadata, never rate-recomputed", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[]}
      modelsState="ready"
      plans={[publicPlan({ credit_per_period_usd: "12", credit_per_period_vnd: 312_012 })]}
      plansState="ready"
    />,
  );
  // Exact authored credit text; the frozen VND grant is the secondary line.
  expect(html).toContain("$12.00 credit / 30 days");
  expect(html).toContain("VND grant 312.012 ₫ fixed at creation");
  // Price field unchanged: own metadata, exact text + VND estimate.
  expect(html).toContain("$9.99");
  expect(html).toContain("≈ 259.750 ₫ (VND estimate)");
});

test("mixed row: VND price with authored USD per-period credit stays field-independent", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[]}
      modelsState="ready"
      plans={[
        publicPlan({
          price_usd: null,
          price_vnd: 259_750,
          credit_per_period_usd: "12",
        }),
      ]}
      plansState="ready"
    />,
  );
  // Price keeps pure VND (no estimate line); credit shows exact authored USD.
  expect(html).toContain("259.750 ₫");
  expect(html).not.toContain("VND estimate");
  expect(html).toContain("$12.00 credit / 30 days");
  // Daily grant metadata is field-independent of the price currency.
  expect(html).toContain("+ $5.00 / day");
});

test("public pricing keeps the legacy VND plan display and untouched model token prices", () => {
  const html = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[
        {
          public_id: "openai/gpt-4o-mini",
          display_name: "GPT-4o mini",
          provider: "openai",
          description: "",
          capabilities: ["chat"],
          context_window: 128_000,
          price_vnd_per_1m: { input: 3_900, output: 15_600, cached_input: 975, reasoning: 0 },
        },
      ]}
      modelsState="ready"
      plans={[publicPlan({ price_usd: null })]}
      plansState="ready"
    />,
  );
  expect(html).toContain("259.750 ₫");
  expect(html).not.toContain("VND estimate");
  expect(html).toContain("3.900 ₫"); // model token price unchanged (server-converted)
  expect(html).toContain("+ $5.00 / day");
});

test("VND-only daily grant renders the frozen VND amount; zero grant renders nothing", () => {
  const vndOnly = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[]}
      modelsState="ready"
      plans={[publicPlan({ daily_grant_usd: null })]}
      plansState="ready"
    />,
  );
  expect(vndOnly).toContain("+ 130.000 ₫ / day");
  expect(vndOnly).not.toContain("fixed at creation");

  const zeroGrant = renderToStaticMarkup(
    <Pricing
      instance={null}
      models={[]}
      modelsState="ready"
      plans={[publicPlan({ daily_grant_usd: null, daily_grant_vnd: 0 })]}
      plansState="ready"
    />,
  );
  expect(zeroGrant).not.toContain("/ day");
});
