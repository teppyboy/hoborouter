// USD top-up UI contract (jsdom, real React, mocked network only):
// - Currency toggle VND (default, behavior-preserving) / USD;
// - VND path posts the exact pre-USD body {amount}; USD path posts
//   {usd_amount: "<string>"} verbatim — never parsed or converted on the client;
// - USD input validation blocks empty / >2 decimals / non-numeric / <=0 before
//   any POST; server errors surface next to the USD input;
// - Approximate VND readback uses only the configured rate and is labeled
//   approximate; cap/timeout hints render from payment-config.
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

function mount(opts: { paymentConfig?: PaymentConfig | null } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const render = () =>
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TopUpForm
            workspaceId="ws_1"
            payosAvailable={false}
            rate={undefined}
            paymentConfig={"paymentConfig" in opts ? opts.paymentConfig : CONFIG}
            onNavigate={() => {}}
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

  const usdInput = () => container.querySelector<HTMLInputElement>("#topup_usd_amount")!;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  return {
    container,
    fetchCalls,
    setFetch: (h: FetchHandler) => {
      handler = h;
    },
    get usdInput() {
      return usdInput();
    },
    get submitButton() {
      return submitButton();
    },
    async typeUsd(value: string) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(usdInput(), value);
        usdInput().dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async clickButton(label: string) {
      const btn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!btn) throw new Error(`button not found: ${label}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
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

// --- VND path (behavior-preserving) --------------------------------------

test("VND default: amount input + presets shown, manual POST body is exactly {amount}", async () => {
  const h = mount();
  try {
    expect(h.container.querySelector("#topup_usd_amount")).toBeNull();
    expect(h.container.querySelector('input[type="number"]')).not.toBeNull();
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.url).toBe("/api/v1/workspaces/ws_1/payments");
    expect(h.fetchCalls[0]!.body).toEqual({ amount: 100_000 });
  } finally {
    h.cleanup();
  }
});

test("VND stays default after toggling to USD and back", async () => {
  const h = mount();
  try {
    await h.clickButton("USD");
    await h.clickButton("VND");
    expect(h.container.querySelector("#topup_usd_amount")).toBeNull();
    expect(h.container.querySelector('input[type="number"]')).not.toBeNull();
  } finally {
    h.cleanup();
  }
});

// --- USD input validation (client-side, before any POST) -------------------

test("USD empty input: validation error, no network request", async () => {
  const h = mount();
  try {
    h.setFetch(async () => {
      throw new Error("network must not be hit");
    });
    await h.clickButton("USD");
    await h.submit();
    expect(h.container.textContent).toContain("Enter a USD amount");
    expect(h.fetchCalls.length).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("USD >2 decimals / non-numeric / negative / zero: blocked before POST", async () => {
  const h = mount();
  try {
    h.setFetch(async () => {
      throw new Error("network must not be hit");
    });
    await h.clickButton("USD");
    for (const bad of ["12.345", "abc", "-5", "0", "0.00"]) {
      await h.typeUsd(bad);
      await h.submit();
      expect(h.fetchCalls.length).toBe(0);
      expect(h.container.textContent).toContain("USD amount");
    }
  } finally {
    h.cleanup();
  }
});

// --- USD path ------------------------------------------------------------

test("USD valid input: posts {usd_amount} verbatim, no amount, no provider", async () => {
  const h = mount();
  try {
    await h.clickButton("USD");
    await h.typeUsd("12.5");
    await h.submit();
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.url).toBe("/api/v1/workspaces/ws_1/payments");
    expect(h.fetchCalls[0]!.body).toEqual({ usd_amount: "12.5" });
  } finally {
    h.cleanup();
  }
});

test("USD approximate readback uses the configured rate and is labeled approximate", async () => {
  const h = mount();
  try {
    await h.clickButton("USD");
    await h.typeUsd("10");
    // 10 USD * 26,000 = 260,000 VND — display-only, never part of the payload.
    expect(h.container.textContent).toContain("≈ 260.000 ₫");
    expect(h.container.textContent).toContain("approximate");
  } finally {
    h.cleanup();
  }
});

test("USD without payment-config: no approximate line, input still usable", async () => {
  const h = mount({ paymentConfig: null });
  try {
    await h.clickButton("USD");
    await h.typeUsd("5");
    expect(h.container.textContent).not.toContain("approximate");
    await h.submit();
    expect(h.fetchCalls[0]!.body).toEqual({ usd_amount: "5" });
  } finally {
    h.cleanup();
  }
});

test("payment-config hints: max top-up and timeout rendered", () => {
  const h = mount();
  try {
    expect(h.container.textContent).toContain("Max top-up 100.000.000 ₫");
    expect(h.container.textContent).toContain("expire after 30 minutes");
  } finally {
    h.cleanup();
  }
});

test("USD server error is shown next to the input", async () => {
  const h = mount();
  try {
    h.setFetch(async () =>
      jsonResponse(400, {
        error: { code: "INVALID", message: "payment amount exceeds the configured maximum" },
      }),
    );
    await h.clickButton("USD");
    await h.typeUsd("999");
    await h.submit();
    expect(h.container.textContent).toContain("payment amount exceeds the configured maximum");
  } finally {
    h.cleanup();
  }
});
