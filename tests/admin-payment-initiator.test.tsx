// Admin payments initiator UI contract: the initiator (actual creator from the
// payment.create audit) renders as an email-only User column next to the
// workspace name; search resolves through the email string via the column
// accessorFn, not the initiator object.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../apps/web/src/components/ui/tooltip";
import { PaymentsTable } from "../apps/web/src/pages/admin/payments";
import type { AdminPayment } from "../apps/web/src/pages/admin/payments";

function payment(partial: Partial<AdminPayment>): AdminPayment {
  return {
    id: "pay_1",
    workspace_id: "ws_1",
    workspace_name: "Acme",
    amount: 50000,
    status: "pending",
    provider: "manual",
    provider_order_code: "MANUAL-pay_1",
    created_at: 1700000000000,
    expires_at: null,
    initiator: null,
    ...partial,
  };
}

function render(payments: AdminPayment[], props?: { search?: string }): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={0}>
        <PaymentsTable payments={payments} search={props?.search} onSearchChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const creator = { id: "u_1", name: "Dana", email: "dana@example.com" };

test("initiator email renders in User column; workspace stays name-only", () => {
  const html = render([payment({ initiator: creator })]);
  expect(html).toContain("dana@example.com");
  expect(html).toContain("User");
  // Workspace cell keeps the bare name; the actor name lives only in the
  // tooltip (radix portals do not SSR), never appended inline.
  expect(html).toContain("Acme");
  expect(html).not.toContain("Dana");
});

test("missing initiator renders em dash and keeps the row", () => {
  const html = render([payment({ workspace_name: "Beta" })]);
  expect(html).toContain("—");
  expect(html).toContain("Beta");
  expect(html).toContain("50.000 ₫");
  expect(html).not.toContain("null");
});

test("search filters on the initiator email via the column accessorFn", () => {
  const rows = [
    payment({ workspace_name: "Acme", initiator: creator }),
    payment({ id: "pay_2", workspace_name: "Beta" }),
  ];
  const hit = render(rows, { search: "dana@example.com" });
  expect(hit).toContain("Acme");
  expect(hit).not.toContain("Beta");
  const miss = render(rows, { search: "zzz-no-match" });
  expect(miss).not.toContain("Acme");
  expect(miss).not.toContain("Beta");
});

test("tooltip trigger is focusable", () => {
  const html = render([payment({ initiator: creator })]);
  expect(html).toContain('tabindex="0"');
});
