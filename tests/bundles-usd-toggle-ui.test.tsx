// USD-canonical bundle/plan display (jsdom, real React, mocked network):
// - USD is the canonical display currency when the backend rate is known:
//   prices render USD primary with the VND integer as secondary, and a single
//   seamless toggle switches the whole section to VND and back;
// - without a rate (older backend) the section stays VND-only with no toggle;
// - the cancel-subscription button DELETEs the workspace subscription and
//   surfaces the "will not renew" state after cancellation.
// No client money conversion is ever sent: purchases still POST nothing but
// the provider choice; the server charges the VND bundle/plan price.
import { test, expect, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "localStorage",
  "matchMedia",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  KeyboardEvent: EventCtor<KeyboardEvent, KeyboardEventInit>;
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
  Event: W.Event,
  MouseEvent: W.MouseEvent,
  KeyboardEvent: W.KeyboardEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// PublicLayout renders the sonner Toaster, which reads matchMedia at render
// time; jsdom does not implement it.
const matchMediaStub = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
(W as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
(globalThis as { matchMedia?: unknown }).matchMedia = matchMediaStub;
jsdomWindow = W;

// Saved at module scope, before any stub is installed: mountSubCard swaps
// globalThis.fetch for a stub and it must be restored before the globals go
// away (previously the stub leaked into every later file in the worker).
const realFetch = globalThis.fetch;

// Every mount registers itself here; teardownMounted() unmounts inside act,
// cancels in-flight queries, and removes containers while the jsdom globals
// are still installed. An unflushed update scheduled by a test runs through
// react-dom's scheduler after the last test and that callback dereferences
// window — restoring globals with roots still mounted made it throw between
// test files (the fixed sleep this replaces only shrank that race window).
const mounted: {
  root: { unmount: () => void };
  container: HTMLElement;
  qc: QueryClient;
  fetchStub?: { restore: () => void };
}[] = [];

async function teardownMounted(): Promise<void> {
  for (const m of mounted.splice(0)) {
    await act(async () => {
      m.root.unmount();
    });
    // Stop pending query callbacks before the containers disappear: a query
    // settling after unmount would otherwise flush against removed DOM.
    await m.qc.cancelQueries();
    m.container.remove();
    m.fetchStub?.restore();
  }
}

afterAll(async () => {
  await teardownMounted();
  globalThis.fetch = realFetch;
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
const { BundleCards, PlanCards, SubscriptionStatusCard, DisplayCurrencyPicker } =
  await import("../apps/web/src/pages/billing/bundles");
import type { SubscriptionInfo } from "../apps/web/src/pages/billing/bundles";

// Wider row shapes the components receive once USD-authored metadata lands;
// assignable to the legacy component props in every phase of the change.
interface TestBundle {
  id: string;
  name: string;
  price_vnd: number;
  credit_vnd: number;
  bonus_vnd: number;
  price_usd?: string;
  credit_usd?: string;
  bonus_usd?: string;
}
interface TestPlan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  period_days: number;
  rate_limit_per_minute?: number;
  price_usd?: string;
  credit_per_period_usd?: string;
}

const RATE = 26_000;
const BUNDLES: TestBundle[] = [
  { id: "b1", name: "Starter", price_vnd: 50_000, credit_vnd: 50_000, bonus_vnd: 0 },
  { id: "b2", name: "Value", price_vnd: 100_000, credit_vnd: 110_000, bonus_vnd: 10_000 },
];
const PLANS: TestPlan[] = [
  {
    id: "p1",
    name: "Pro",
    price_vnd: 200_000,
    credit_per_period_vnd: 250_000,
    period_days: 30,
    rate_limit_per_minute: 15,
  },
];

function usdBundle(over: Partial<TestBundle>): TestBundle {
  return {
    id: "u1",
    name: "Starter USD",
    price_vnd: 259_750,
    credit_vnd: 130_005,
    bonus_vnd: 0,
    price_usd: "9.99",
    credit_usd: "5",
    bonus_usd: "0",
    ...over,
  };
}

// USD-authored rows (creation FX 26001: 9.99 -> 259750 ceiling, 5 -> 130005,
// 12 -> 312012). credit_vnd/bonus_vnd are the actual frozen VND grants.
const USD_BUNDLES: TestBundle[] = [usdBundle({})];
const USD_PLANS: TestPlan[] = [
  {
    id: "up1",
    name: "Pro USD",
    price_vnd: 259_750,
    credit_per_period_vnd: 312_012,
    period_days: 30,
    price_usd: "9.99",
    credit_per_period_usd: "12",
  },
];

// A USD row whose server quote moved after an FX edit (quote 269740 at 27001).
const USD_QUOTED_BUNDLES: TestBundle[] = [usdBundle({ price_vnd: 269_740 })];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Mount {
  container: HTMLElement;
  click: (el: Element) => void;
  priceText: (id: string) => string;
}

// The page owns the single display-currency control; the card sections are
// pure views of the hoisted `currency` state passed in as a prop.
function mountCards(
  Component: typeof BundleCards | typeof PlanCards,
  opts: {
    rate: number | undefined;
    bundles?: TestBundle[];
    plans?: TestPlan[];
    currency?: "USD" | "VND";
  },
): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const props =
    Component === BundleCards
      ? {
          bundles: opts.bundles ?? BUNDLES,
          workspaceId: "ws_1",
          selectedId: null,
          onSelect: () => {},
          rate: opts.rate,
          currency: opts.currency,
        }
      : {
          plans: opts.plans ?? PLANS,
          workspaceId: "ws_1",
          selectedId: null,
          onSelect: () => {},
          rate: opts.rate,
          currency: opts.currency,
        };
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        {/* @ts-expect-error union of two similar prop shapes; each call site is consistent */}
        <Component {...props} />
      </QueryClientProvider>,
    );
  });
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  mounted.push({ root, container, qc });
  return {
    container,
    click,
    priceText: (id: string) =>
      container.querySelector(`[data-testid="price-${id}"]`)?.textContent ?? "",
  };
}

test("USD is canonical: price shows USD primary with the VND integer secondary", () => {
  const m = mountCards(BundleCards, { rate: RATE });
  expect(m.priceText("b1")).toContain("$1.92");
  expect(m.container.textContent).toContain("50.000 ₫");
  expect(m.container.textContent).toContain("$3.85"); // 100000 / 26000
});

test("VND selection renders VND primary for the whole section, USD selection converts back", () => {
  const m = mountCards(BundleCards, { rate: RATE, currency: "VND" });
  expect(m.priceText("b1")).toContain("50.000 ₫");
  expect(m.priceText("b1")).not.toContain("$");
  const back = mountCards(BundleCards, { rate: RATE, currency: "USD" });
  expect(back.priceText("b1")).toContain("$1.92");
});

test("bonus and per-period credit follow the selected currency too", () => {
  const m = mountCards(BundleCards, { rate: RATE });
  expect(m.container.textContent).toContain("+$0.38"); // 10000 / 26000 bonus
  const p = mountCards(PlanCards, { rate: RATE });
  expect(p.priceText("p1")).toContain("$7.69"); // 200000 / 26000
  expect(p.container.textContent).toContain("$9.62"); // 250000 / 26000 per period
  const vnd = mountCards(BundleCards, { rate: RATE, currency: "VND" });
  expect(vnd.container.textContent).toContain("+ 10.000 ₫ bonus");
  const pv = mountCards(PlanCards, { rate: RATE, currency: "VND" });
  expect(pv.priceText("p1")).toContain("200.000 ₫");
  expect(pv.container.textContent).toContain("250.000 ₫ credit");
});

test("no rate: VND-only display regardless of selection", () => {
  const m = mountCards(BundleCards, { rate: undefined });
  expect(m.priceText("b1")).toContain("50.000 ₫");
  expect(m.priceText("b1")).not.toContain("$");
  const v = mountCards(BundleCards, { rate: undefined, currency: "VND" });
  expect(v.priceText("b1")).toContain("50.000 ₫");
});

// --- cancel subscription --------------------------------------------------

const ACTIVE_SUB: SubscriptionInfo = {
  balance: 250_000,
  available: 230_000,
  period_end: Date.parse("2030-02-01T00:00:00Z"),
  plan_name: "Pro",
  rate_limit_per_minute: 15,
  expired: false,
  canceled: false,
};

function mountSubCard(
  subscription: SubscriptionInfo,
  opts: { respond?: () => Promise<Response> } = {},
): {
  container: HTMLElement;
  fetchCalls: { url: string; method: string }[];
  clickCancel: () => Promise<void>;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const fetchCalls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    if (opts.respond) return opts.respond();
    return jsonResponse(200, {
      id: "sub-1",
      status: "active",
      canceled_at: Date.now(),
      period_end: subscription.period_end,
    });
  }) as typeof fetch;
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <SubscriptionStatusCard subscription={subscription} workspaceId="ws_1" rate={RATE} />
      </QueryClientProvider>,
    );
  });
  const clickCancel = async () => {
    const btn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Cancel subscription"),
    );
    if (!btn) throw new Error("cancel button missing");
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  };
  mounted.push({
    root,
    container,
    qc,
    fetchStub: {
      restore: () => {
        // Restore the module-scope realFetch, not the value captured at mount:
        // with several mounts chained, the captured value would be a previous
        // stub, pinning it instead of the genuine fetch.
        globalThis.fetch = realFetch;
      },
    },
  });
  return { container, fetchCalls, clickCancel };
}

test("active subscription card shows plan, credit and a cancel button", () => {
  const m = mountSubCard(ACTIVE_SUB);
  expect(m.container.textContent).toContain("Pro");
  expect(m.container.textContent).toContain("$9.62"); // 250000 / 26000
  expect(m.container.textContent).toContain("Cancel subscription");
  expect(m.container.textContent).toContain("will not renew");
});

test("cancel button DELETEs the workspace subscription", async () => {
  const m = mountSubCard(ACTIVE_SUB);
  await m.clickCancel();
  expect(
    m.fetchCalls.some(
      (c) => c.method === "DELETE" && c.url === "/api/v1/workspaces/ws_1/subscription",
    ),
  ).toBe(true);
});

test("expired subscription shows no cancel button", () => {
  const m = mountSubCard({ ...ACTIVE_SUB, expired: true });
  expect(m.container.textContent).not.toContain("Cancel subscription");
});

test("teardown drains a deferred callback: unmount + cancelQueries + container removal settle safely before globals are restored", async () => {
  // Regression for the teardown hazard this file's afterAll fixes: a network
  // callback still pending at teardown must not flush against removed DOM or
  // restored globals. The network response is gated on a deferred promise so
  // the mutation is genuinely in flight when teardown runs.
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const m = mountSubCard(ACTIVE_SUB, {
    respond: () =>
      gate.then(() =>
        jsonResponse(200, {
          id: "sub-1",
          status: "active",
          canceled_at: Date.now(),
          period_end: ACTIVE_SUB.period_end,
        }),
      ),
  });
  await m.clickCancel();
  expect(m.fetchCalls.some((c) => c.method === "DELETE")).toBe(true);

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    // Exact teardown order the afterAll performs: unmount in act, cancel
    // queries, remove containers, restore fetch — all before globals go.
    await teardownMounted();
    expect(globalThis.fetch).toBe(realFetch);
    expect(document.body.contains(m.container)).toBe(false);

    // The deferred callback resolves AFTER teardown: cancelled clients and
    // unmounted roots must swallow it — no unhandled rejection, no throw.
    resolveGate();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// --- USD-authored catalog rows (Task 3 member display) ---------------------

test("authored USD price shows the exact price_usd text even without any FX rate", () => {
  const m = mountCards(BundleCards, { rate: undefined, bundles: USD_BUNDLES });
  expect(m.priceText("u1")).toBe("$9.99");
  // VND secondary is the server quote, not a client conversion.
  expect(m.container.textContent).toContain("259.750 ₫");

  // Credit renders its OWN authored USD metadata exactly, never a
  // rate-recomputed equivalent.
  expect(m.container.textContent).toContain("$5.00 credit");
  expect(m.container.textContent).toContain("exact authored USD amount");
});

test("VND mode shows the frozen integer VND grant for USD-credit rows", () => {
  const m = mountCards(BundleCards, {
    rate: undefined,
    bundles: USD_BUNDLES,
    currency: "VND",
  });
  // Integer VND display/history preserved; no re-derived USD text.
  expect(m.container.textContent).toContain("130.005 ₫ credit");
  expect(m.container.textContent).not.toContain("$5.00 credit");
  const back = mountCards(BundleCards, { rate: undefined, bundles: USD_BUNDLES });
  expect(back.container.textContent).toContain("$5.00 credit");
});

// --- page-level segmented control (rendered once, beside the TabsList) ------

function mountPicker(opts: {
  currency?: "USD" | "VND";
  rate: number | undefined;
  usdAvailable?: boolean;
}): {
  container: HTMLElement;
  radios: () => Element[];
  checked: () => string | null;
  changes: ("USD" | "VND")[];
  click: (label: string) => void;
  key: (label: string, key: string) => void;
  tabIndex: (label: string) => string | null;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  // Stateful harness: the picker is controlled by the page in production, so
  // keyboard/selection assertions need the same controlled wiring here.
  const changes: ("USD" | "VND")[] = [];
  const initial = opts.currency ?? "USD";
  function Harness() {
    const [currency, setCurrency] = useState<"USD" | "VND">(initial);
    return (
      <DisplayCurrencyPicker
        currency={currency}
        rate={opts.rate}
        usdAvailable={opts.usdAvailable}
        onChange={(c) => {
          changes.push(c);
          setCurrency(c);
        }}
      />
    );
  }
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    );
  });
  mounted.push({ root, container, qc });
  const radio = (label: string) => {
    const el = [...container.querySelectorAll("[role='radio']")].find(
      (r) => r.textContent === label,
    );
    if (!el) throw new Error(`radio ${label} missing`);
    return el;
  };
  return {
    container,
    radios: () => [...container.querySelectorAll("[role='radio']")],
    checked: () =>
      container.querySelector("[role='radio'][aria-checked='true']")?.textContent ?? null,
    changes,
    click: (label: string) =>
      act(() => {
        radio(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }),
    key: (label: string, key: string) =>
      act(() => {
        radio(label).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }),
    tabIndex: (label: string) => radio(label).getAttribute("tabindex"),
  };
}

test("picker is a labeled radiogroup of USD and VND with the selection marked", () => {
  const m = mountPicker({ currency: "USD", rate: RATE });
  expect(m.container.querySelector("[role='radiogroup']")).not.toBeNull();
  expect(m.radios().map((r) => r.textContent)).toEqual(["USD", "VND"]);
  expect(m.checked()).toBe("USD");
  m.click("VND");
  // Display-only control: clicking fires the callback; no money values exist
  // anywhere in the control.
  expect(m.container.textContent).toMatch(/^(USDVND|VNDUSD)$/);
});

test("arrow keys choose and focus the next radio, wrapping; Home/End jump to the ends", () => {
  const m = mountPicker({ rate: RATE });
  // Roving tabindex: the selected option is the group's only tab stop.
  expect(m.tabIndex("USD")).toBe("0");
  expect(m.tabIndex("VND")).toBe("-1");

  m.key("USD", "ArrowRight");
  expect(m.changes).toEqual(["VND"]);
  expect(document.activeElement?.textContent).toBe("VND");
  m.key("VND", "ArrowDown");
  expect(m.changes).toEqual(["VND", "USD"]); // wraps forward to USD
  m.key("USD", "ArrowLeft");
  expect(m.changes).toEqual(["VND", "USD", "VND"]); // wraps backward to VND
  m.key("VND", "ArrowUp");
  expect(m.changes[m.changes.length - 1]).toBe("USD");

  m.key("USD", "Home");
  expect(m.changes[m.changes.length - 1]).toBe("USD");
  m.key("USD", "End");
  expect(m.changes[m.changes.length - 1]).toBe("VND");

  // The controlled selection and roving tab stop followed the keys.
  expect(m.checked()).toBe("VND");
  expect(m.tabIndex("VND")).toBe("0");
  expect(m.tabIndex("USD")).toBe("-1");
  expect(document.activeElement?.textContent).toBe("VND");

  // Unrelated keys never move the selection.
  m.key("VND", "A");
  expect(m.changes[m.changes.length - 1]).toBe("VND");
  expect(m.changes).toHaveLength(6);
});

test("keyboard works in the other initial selection state too", () => {
  const m = mountPicker({ currency: "VND", rate: RATE });
  expect(m.tabIndex("VND")).toBe("0");
  expect(m.tabIndex("USD")).toBe("-1");
  m.key("VND", "ArrowLeft");
  expect(m.changes).toEqual(["USD"]);
  expect(document.activeElement?.textContent).toBe("USD");
});

test("picker hidden without a rate or authored USD; shown for authored USD without a rate", () => {
  const hidden = mountPicker({ currency: "USD", rate: undefined });
  expect(hidden.container.textContent).toBe("");
  const authored = mountPicker({ currency: "USD", rate: undefined, usdAvailable: true });
  expect(authored.radios()).toHaveLength(2);
});

test("VND mode on a USD row shows the server quote and labels it an estimate", () => {
  const m = mountCards(BundleCards, {
    rate: undefined,
    bundles: USD_QUOTED_BUNDLES,
    currency: "VND",
  });
  // Current server price_vnd quote (27001), never the creation fallback.
  expect(m.priceText("u1")).toContain("269.740 ₫");
  expect(m.priceText("u1")).not.toContain("259.750");
  expect(m.container.textContent.toLowerCase()).toContain("estimate");
  const back = mountCards(BundleCards, { rate: undefined, bundles: USD_QUOTED_BUNDLES });
  expect(back.priceText("u1")).toBe("$9.99");
});

// --- authored USD plan display (own per-period metadata) -------------------

test("authored USD bonus displays even when bonus_vnd is zero; legacy VND bonus still converts", () => {
  // Authored bonus_usd exact text with zero frozen VND (no fabricated line,
  // no rate-based reinterpretation).
  const m = mountCards(BundleCards, {
    rate: undefined,
    bundles: [usdBundle({ bonus_usd: "2.5", bonus_vnd: 0 })],
  });
  expect(m.container.textContent).toContain("+$2.50 bonus");
  // Zero-authored USD bonus stays hidden.
  const m0 = mountCards(BundleCards, {
    rate: undefined,
    bundles: [usdBundle({ bonus_usd: "0", bonus_vnd: 0 })],
  });
  expect(m0.container.textContent).not.toContain("bonus");
  // Legacy VND bonus on a USD-credit row keeps the rate-based conversion.
  const mLegacy = mountCards(BundleCards, {
    rate: RATE,
    bundles: [usdBundle({ bonus_usd: undefined, bonus_vnd: 10_000 })],
  });
  expect(mLegacy.container.textContent).toContain("+$0.38"); // 10000 / 26000
});

test("authored USD credit is never reinterpreted through the rate", () => {
  // credit_usd "5.10" with frozen grant 130005 at rate 26000 would convert
  // to $5.00; the exact authored text must win.
  const m = mountCards(BundleCards, {
    rate: RATE,
    bundles: [usdBundle({ credit_usd: "5.10", credit_vnd: 130_005 })],
  });
  expect(m.container.textContent).toContain("$5.10 credit");
  expect(m.container.textContent).not.toContain("$5.00 credit");
});

test("authored USD plan shows the exact price and its own USD per-period credit", () => {
  const m = mountCards(PlanCards, { rate: undefined, plans: USD_PLANS });
  expect(m.priceText("up1")).toBe("$9.99");
  // Exact authored per-period credit, no rate needed.
  expect(m.container.textContent).toContain("$12.00 credit / 30 days");
  expect(m.container.textContent).not.toContain("$11.99");
  // VND mode keeps the frozen integer VND grant.
  const v = mountCards(PlanCards, {
    rate: undefined,
    plans: USD_PLANS,
    currency: "VND",
  });
  expect(v.container.textContent).toContain("312.012 ₫ credit / 30 days");
  const m2 = mountCards(PlanCards, {
    rate: undefined,
    plans: [
      {
        id: "up2",
        name: "Credit-only USD",
        price_vnd: 259_750,
        credit_per_period_vnd: 312_012,
        period_days: 30,
        price_usd: undefined,
        credit_per_period_usd: "12",
      },
    ],
  });
  expect(m2.container.textContent).toContain("$12.00 credit / 30 days");
});

test("catalog envelope rate wins over the wallet rate", async () => {
  const { catalogEnvelopeRate } = await import("../apps/web/src/pages/billing/bundles");
  expect(catalogEnvelopeRate({ usd_vnd_rate: 27001 }, { usd_vnd_rate: 26900 }, 26000)).toBe(27001);
  expect(catalogEnvelopeRate(undefined, { usd_vnd_rate: 26900 }, 26000)).toBe(26900);
  expect(catalogEnvelopeRate(undefined, undefined, 26000)).toBe(26000);
  expect(catalogEnvelopeRate(undefined, undefined, undefined)).toBeUndefined();
});

// --- purchase request shape ------------------------------------------------
// The payos-payload purchase contract moved to the selection-gated checkout
// dialog and is covered end-to-end at page level by billing-checkout-ui.test.tsx
// ("payos confirm keeps the exact payload shape"); the cards themselves no
// longer own the mutation, so no card-level request-shape test remains here.
