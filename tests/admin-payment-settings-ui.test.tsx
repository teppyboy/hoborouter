// Admin payment-controls UI contract: three bounded integer fields (timeout
// 1–1440, max amount, USD rate) render current values with per-field Save
// buttons; every field submits its own single-key PUT (atomic per field — the
// backend validates the whole body and never partially persists).
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaymentControlsCard } from "../apps/web/src/pages/admin/settings";

interface AdminSettings {
  prompt_caching_enabled: boolean;
  first_topup_bonus_enabled: boolean;
  first_topup_bonus_amount_vnd: number | null;
  payment_timeout_minutes: number;
  payment_max_amount_vnd: number;
  payment_usd_vnd_rate: number;
}

const SETTINGS: AdminSettings = {
  prompt_caching_enabled: true,
  first_topup_bonus_enabled: true,
  first_topup_bonus_amount_vnd: null,
  payment_timeout_minutes: 30,
  payment_max_amount_vnd: 100_000_000,
  payment_usd_vnd_rate: 26_000,
};

function render(query?: { data?: AdminSettings; isPending: boolean; error: unknown }): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PaymentControlsCard query={query ?? { data: SETTINGS, isPending: false, error: null }} />
    </QueryClientProvider>,
  );
}

test("payment controls: three labeled fields with current values and bounds hint", () => {
  const html = render();
  expect(html).toContain("Payment timeout (minutes)");
  expect(html).toContain("1–1440");
  expect(html).toContain("Max top-up amount (VND)");
  expect(html).toContain("USD → VND rate");
  // Current values render as input values (dirty state shows the edit).
  expect(html).toContain('value="30"');
  expect(html).toContain('value="100000000"');
  expect(html).toContain('value="26000"');
  // Not dirty yet: all three Save buttons start disabled (count exact-attribute
  // occurrences — Tailwind "disabled:" class names would inflate a loose match).
  expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
});

test("payment controls: pending and error states render instead of fields", () => {
  expect(render({ isPending: true, error: null })).toContain("Loading…");
  const err = render({ isPending: false, error: new Error("Forbidden") });
  expect(err).toContain("Forbidden");
  expect(err).not.toContain("Payment timeout (minutes)");
});
