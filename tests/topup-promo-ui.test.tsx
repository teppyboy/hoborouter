// Top-up promo-code UI contract (jsdom, real React, mocked network only):
// - Optional promo code field on the top-up form: empty means the request body
//   stays byte-identical to the pre-promo shape (no promo_code key at all);
// - A typed code rides the exact server contract (32 hex chars, same body
//   otherwise) for both VND and USD top-ups, manual and payos providers;
// - Client-side format validation blocks malformed codes before any POST;
// - Server promo-apply failures (replay/expired/exhausted/inactive/suspended/
//   not-percent/not-found) map to friendly messages next to the promo field;
// - On success the authoritative voucher snapshot from the response
//   (original credit, discount, final due) is shown verbatim — never
//   recomputed client-side — and the flow (toast/navigation) is preserved.
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

function mount(opts: { payosAvailable?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  let navigatedTo: string | null = null;
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

  const promoInput = () => container.querySelector<HTMLInputElement>("#topup_promo_code")!;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const currencyButton = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

  return {
    container,
    fetchCalls,
    get navigatedTo() {
      return navigatedTo;
    },
    setFetch: (h: FetchHandler) => {
      handler = h;
    },
    get promoInput() {
      return promoInput();
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
    async typeUsd(value: string) {
      await act(async () => {
        const usdInput = () => container.querySelector<HTMLInputElement>("#topup_usd_amount")!;
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(usdInput(), value);
        usdInput().dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async typePromo(value: string) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(promoInput(), value);
        promoInput().dispatchEvent(new W.Event("input", { bubbles: true }));
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

const VALID_CODE = "a".repeat(32);

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

// --- body contract -------------------------------------------------------

test("no promo typed: VND manual body stays exactly {amount} (no promo_code key)", async () => {
  const h = mount();
  try {
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({ amount: 100_000 });
  } finally {
    h.cleanup();
  }
});

test("VND top-up with promo: body is {amount, promo_code} verbatim", async () => {
  const h = mount();
  try {
    await h.typePromo(` ${VALID_CODE} `);
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({ amount: 100_000, promo_code: VALID_CODE });
  } finally {
    h.cleanup();
  }
});

test("USD top-up with promo: body is {usd_amount, promo_code} verbatim (uppercase accepted)", async () => {
  const h = mount();
  try {
    await h.clickButton("USD");
    await h.typeUsd("5");
    await h.typePromo(VALID_CODE.toUpperCase());
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({
      usd_amount: "5",
      promo_code: VALID_CODE.toUpperCase(),
    });
  } finally {
    h.cleanup();
  }
});

test("payos provider with promo: body is {amount, provider, promo_code}", async () => {
  const h = mount({ payosAvailable: true });
  try {
    await h.typePromo(VALID_CODE);
    // Choose the payos radio.
    const radio = h.container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="payos"]',
    )!;
    await act(async () => {
      radio.dispatchEvent(new W.Event("change", { bubbles: true }));
      radio.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.body).toEqual({
      amount: 100_000,
      provider: "payos",
      promo_code: VALID_CODE,
    });
  } finally {
    h.cleanup();
  }
});

// --- client-side format validation ---------------------------------------

test("malformed promo code: friendly error next to the field, no POST", async () => {
  const h = mount();
  try {
    await h.typePromo("SUMMER-SALE");
    await h.submit();
    expect(h.fetchCalls.length).toBe(0);
    expect(h.container.textContent).toContain("32");
  } finally {
    h.cleanup();
  }
});

// --- friendly server error mapping ---------------------------------------

test("replay (409 ALREADY_REDEEMED): friendly message near promo field, no navigation", async () => {
  const h = mount();
  try {
    h.setFetch(async () =>
      jsonResponse(409, {
        error: { code: "ALREADY_REDEEMED", message: "Promo code already used by this workspace" },
      }),
    );
    await h.typePromo(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("already");
    expect(h.navigatedTo).toBeNull();
  } finally {
    h.cleanup();
  }
});

test("not-percent (409 PROMO_NOT_PERCENT): fixed-credit codes belong to the redeem form", async () => {
  const h = mount();
  try {
    h.setFetch(async () =>
      jsonResponse(409, {
        error: {
          code: "PROMO_NOT_PERCENT",
          message: "Fixed-credit promo codes are redeemed via the redeem endpoint",
        },
      }),
    );
    await h.typePromo(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("redeem");
  } finally {
    h.cleanup();
  }
});

test("unmapped promo failure surfaces the server message, no success note", async () => {
  const h = mount();
  try {
    h.setFetch(async () =>
      jsonResponse(400, {
        error: { code: "INVALID", message: "promo_code must be 32 hex characters" },
      }),
    );
    await h.typePromo(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("32 hex characters");
  } finally {
    h.cleanup();
  }
});

// --- authoritative voucher snapshot display -------------------------------

test("voucher success: original/discount/due shown from the response snapshot, flow preserved", async () => {
  const h = mount();
  try {
    h.setFetch(async () => voucherResponse());
    await h.typePromo(VALID_CODE);
    await h.submit();
    const text = h.container.textContent ?? "";
    // Server truth only: original credit, snapshot discount, final due.
    expect(text).toContain("100.000 ₫");
    expect(text).toContain("3.000 ₫");
    expect(text).toContain("97.000 ₫");
    // The pre-existing manual flow is preserved: navigate to the payment page.
    expect(h.navigatedTo).toBe("/billing/payments?payment=pay_1");
    // The consumed code is cleared after success.
    expect(h.promoInput.value).toBe("");
  } finally {
    h.cleanup();
  }
});

test("plain success without voucher echo shows no voucher note", async () => {
  const h = mount();
  try {
    await h.typePromo(VALID_CODE);
    await h.submit();
    // No snapshot fields in the response → no numbers promised client-side.
    expect(h.container.textContent).not.toContain("97.000 ₫");
    expect(h.navigatedTo).toBe("/billing/payments?payment=pay_1");
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
