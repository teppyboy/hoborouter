// Top-up promo attachment UI contract (jsdom, real React, mocked network only):
// - The top-up form has NO promo input of its own: the attached code arrives as
//   the `promoCode` prop (set by the credits page promo panel after a preview);
//   with no attachment the POST body stays byte-identical to the pre-promo
//   shape (no promo_code key at all);
// - An attached code rides the exact server contract for both VND and USD
//   top-ups, manual and payos providers — the raw code is sent verbatim
//   (no client normalization or 32-hex gate; server truth);
// - Server promo-apply failures map to friendly messages via onPromoError and
//   never complete the flow; success always detaches the consumed code via
//   onPromoApplied (a voucher is consumed at payment creation, per spec);
// - On success the authoritative voucher snapshot from the response
//   (original credit, discount, final due) is shown verbatim — never
//   recomputed client-side — and the flow (toast/navigation) is preserved;
// - The form reports its effective VND amount via onAmountVndChange so the
//   promo panel can request a server-side discount preview.
import { test, expect, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  document: Document;
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  localStorage: Storage;
  close: () => void;
}
const W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as JsdomRealm;

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  Node: W.Node,
  Element: W.Element,
  HTMLElement: W.HTMLElement,
  HTMLInputElement: W.HTMLInputElement,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
jsdomWindow = W;

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");
const { TopUpForm } = await import("../apps/web/src/pages/billing/credits");
type PaymentConfig = import("../apps/web/src/pages/billing/credits").PaymentConfig;

// --- harness -------------------------------------------------------------

interface FetchCall {
  url: string;
  body: unknown;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>;

const CONFIG: PaymentConfig = {
  timeout_minutes: 30,
  max_amount_vnd: 100_000_000,
  usd_vnd_rate: 26_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mount(opts: { payosAvailable?: boolean; promoCode?: string | null } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  let navigatedTo: string | null = null;
  const applied: number[] = [];
  const errors: (string | null)[] = [];
  const amounts: (number | null)[] = [];
  const render = () =>
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TopUpForm
            workspaceId="ws_1"
            payosAvailable={opts.payosAvailable ?? false}
            rate={undefined}
            paymentConfig={CONFIG}
            onNavigate={(href) => {
              navigatedTo = href;
            }}
            promoCode={opts.promoCode ?? null}
            onPromoApplied={() => applied.push(1)}
            onPromoError={(message) => errors.push(message)}
            onAmountVndChange={(vnd) => amounts.push(vnd)}
          />
        </QueryClientProvider>,
      );
    });
  render();

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = async () =>
    jsonResponse(201, {
      id: "pay_1",
      amount: 100_000,
      status: "pending",
      provider: "manual",
      provider_order_code: "M-pay_1",
      checkout_url: "/billing/payments?payment=pay_1",
    });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(String(url), init);
  }) as typeof fetch;

  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const currencyButton = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

  return {
    container,
    fetchCalls,
    get navigatedTo() {
      return navigatedTo;
    },
    get applied() {
      return applied;
    },
    get errors() {
      return errors;
    },
    get amounts() {
      return amounts;
    },
    setFetch: (h: FetchHandler) => {
      handler = h;
    },
    get submitButton() {
      return submitButton();
    },
    async clickButton(label: string) {
      await act(async () => {
        currencyButton(label).dispatchEvent(
          new W.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async choosePayos() {
      const radio = container.querySelector<HTMLInputElement>(
        'input[type="radio"][value="payos"]',
      )!;
      await act(async () => {
        radio.dispatchEvent(new W.Event("change", { bubbles: true }));
        radio.click();
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async typeUsd(value: string) {
      await act(async () => {
        const usdInput = () => container.querySelector<HTMLInputElement>("#topup_usd_amount")!;
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(usdInput(), value);
        usdInput().dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async submit() {
      await act(async () => {
        submitButton().dispatchEvent(
          new W.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
  };
}

const ATTACHED = "SUMMER SALE 2026";

const voucherResponse = (status = 201) =>
  jsonResponse(status, {
    id: "pay_1",
    amount: 97_000,
    status: "pending",
    provider: "manual",
    provider_order_code: "M-pay_1",
    checkout_url: "/billing/payments?payment=pay_1",
    original_amount_vnd: 100_000,
    discount_vnd: 3_000,
    promo_code_id: "promo_1",
  });

// --- body contract: attached code rides the payment creation --------------

test("no attached code: VND manual body stays exactly {amount} (no promo_code key)", async () => {
  const h = mount();
  try {
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({ amount: 100_000 });
  } finally {
    h.cleanup();
  }
});

test("attached code: VND manual body is {amount, promo_code} verbatim (spaces preserved)", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({ amount: 100_000, promo_code: ATTACHED });
  } finally {
    h.cleanup();
  }
});

test("attached code: USD manual body is {usd_amount, promo_code} verbatim", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    await h.clickButton("USD");
    await h.typeUsd("5");
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({ usd_amount: "5", promo_code: ATTACHED });
  } finally {
    h.cleanup();
  }
});

test("attached code: payos VND body is {amount, provider, promo_code}", async () => {
  const h = mount({ payosAvailable: true, promoCode: ATTACHED });
  try {
    await h.choosePayos();
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({
      amount: 100_000,
      provider: "payos",
      promo_code: ATTACHED,
    });
  } finally {
    h.cleanup();
  }
});

test("attached code: payos USD body is {usd_amount, provider, promo_code}", async () => {
  const h = mount({ payosAvailable: true, promoCode: ATTACHED });
  try {
    await h.clickButton("USD");
    await h.typeUsd("5");
    await h.choosePayos();
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({
      usd_amount: "5",
      provider: "payos",
      promo_code: ATTACHED,
    });
  } finally {
    h.cleanup();
  }
});

// --- effective VND amount reporting for the server preview ---------------

test("onAmountVndChange reports the effective VND amount; USD reports null", async () => {
  const h = mount();
  try {
    expect(h.amounts.at(-1)).toBe(100_000);
    await h.clickButton("USD");
    expect(h.amounts.at(-1)).toBeNull();
  } finally {
    h.cleanup();
  }
});

// --- friendly server error mapping ---------------------------------------

test("promo-apply failure (409 ALREADY_REDEEMED): friendly message via onPromoError, no detach, no navigation", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    h.setFetch(async () =>
      jsonResponse(409, {
        error: { code: "ALREADY_REDEEMED", message: "Promo code already used by this workspace" },
      }),
    );
    await h.submit();
    expect(h.errors.at(-1)).toContain("already");
    expect(h.applied.length).toBe(0);
    expect(h.navigatedTo).toBeNull();
  } finally {
    h.cleanup();
  }
});

test("unmapped promo failure surfaces the server message via onPromoError", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    h.setFetch(async () =>
      jsonResponse(400, {
        error: { code: "INVALID", message: "promo_code is not valid for this payment" },
      }),
    );
    await h.submit();
    expect(h.errors.at(-1)).toContain("promo_code is not valid for this payment");
  } finally {
    h.cleanup();
  }
});

test("non-promo failure does not route the error through onPromoError", async () => {
  const h = mount({ promoCode: null });
  try {
    h.setFetch(async () =>
      jsonResponse(400, { error: { code: "INVALID", message: "amount too small" } }),
    );
    await h.submit();
    expect(h.errors.length).toBe(0);
    expect(h.container.textContent).toContain("amount too small");
  } finally {
    h.cleanup();
  }
});

// --- authoritative voucher snapshot display -------------------------------

test("voucher success: original/discount/due shown from the response snapshot, code detached, flow preserved", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    h.setFetch(async () => voucherResponse());
    await h.submit();
    const text = h.container.textContent ?? "";
    // Server truth only: original credit, snapshot discount, final due.
    expect(text).toContain("100.000 ₫");
    expect(text).toContain("3.000 ₫");
    expect(text).toContain("97.000 ₫");
    // The pre-existing manual flow is preserved: navigate to the payment page.
    expect(h.navigatedTo).toBe("/billing/payments?payment=pay_1");
    // The voucher is consumed at payment creation: always detached on success.
    expect(h.applied.length).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("plain success without voucher echo detaches the code but shows no voucher numbers", async () => {
  const h = mount({ promoCode: ATTACHED });
  try {
    await h.submit();
    expect(h.container.textContent).not.toContain("97.000 ₫");
    expect(h.navigatedTo).toBe("/billing/payments?payment=pay_1");
    expect(h.applied.length).toBe(1);
  } finally {
    h.cleanup();
  }
});

// --- focused helper: error mapping is total -------------------------------

test("promoApplyErrorKey maps every server promo failure to a dictionary key", async () => {
  const { promoApplyErrorKey } = await import("../apps/web/src/pages/billing/credits");
  const { ApiError } = await import("../apps/web/src/lib/api");
  expect(promoApplyErrorKey(new ApiError(409, "ALREADY_REDEEMED", "x"))).toBe("errPromoReplay");
  expect(promoApplyErrorKey(new ApiError(409, "PROMO_EXPIRED", "x"))).toBe("errPromoExpired");
  expect(promoApplyErrorKey(new ApiError(409, "PROMO_EXHAUSTED", "x"))).toBe("errPromoExhausted");
  expect(promoApplyErrorKey(new ApiError(409, "PROMO_INACTIVE", "x"))).toBe("errPromoInactive");
  expect(promoApplyErrorKey(new ApiError(403, "WORKSPACE_SUSPENDED", "x"))).toBe(
    "errPromoSuspended",
  );
  expect(promoApplyErrorKey(new ApiError(404, "NOT_FOUND", "x"))).toBe("errPromoNotFound");
  expect(promoApplyErrorKey(new ApiError(409, "PROMO_NOT_PERCENT", "x"))).toBe("errPromoFixed");
  expect(promoApplyErrorKey(new ApiError(400, "INVALID", "x"))).toBeNull();
  expect(promoApplyErrorKey(new TypeError("boom"))).toBeNull();
});
