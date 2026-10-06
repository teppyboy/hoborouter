import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "../apps/web/src/pages/public/pricing";
import type { PublicSubscriptionPlan } from "../apps/web/src/lib/public-queries";

const publicPlan = (over: Partial<PublicSubscriptionPlan>): PublicSubscriptionPlan => ({
  id: "pp1",
  name: "Pro",
  price_vnd: 259_750,
  credit_per_period_vnd: 312_012,
  period_days: 30,
  price_usd: "9.99",
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
  // The credit grant stays the frozen VND amount.
  expect(html).toContain("312.012 ₫ credit / 30 days");
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
});
