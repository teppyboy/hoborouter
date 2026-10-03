// Admin payments reject UI contract: pending rows offer both Mark paid and
// Reject; succeeded/rejected rows render no approval or reject controls; the
// rejected status displays as "Rejected". The confirm dialog uses the radix
// Dialog primitives (DialogTitle/DialogDescription -> accessible name and
// description) and renders nothing into the markup while closed.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../apps/web/src/components/ui/tooltip";
import { PaymentsTable } from "../apps/web/src/pages/admin/payments";
import type { AdminPayment } from "../apps/web/src/pages/admin/payments";

function payment(partial: Partial<AdminPayment> = {}): AdminPayment {
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

function render(payments: AdminPayment[]): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={0}>
        <PaymentsTable payments={payments} onSearchChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

test("pending row offers both Mark paid and Reject", () => {
  const html = render([payment()]);
  expect(html).toContain("Mark paid");
  expect(html).toContain("Reject");
});

test("succeeded row renders no approval or reject controls", () => {
  const html = render([payment({ status: "succeeded" })]);
  expect(html).not.toContain("Mark paid");
  expect(html).not.toContain(">Reject<");
});

test("rejected row renders no approval or reject controls and a Rejected badge", () => {
  const html = render([payment({ status: "rejected" })]);
  expect(html).not.toContain("Mark paid");
  expect(html).not.toContain(">Reject<");
  expect(html).toContain("Rejected");
});

test("confirm dialog is closed-state only in initial markup", () => {
  const html = render([payment()]);
  expect(html).not.toContain("Reject payment?");
  expect(html).not.toContain("no balance will be credited");
});
