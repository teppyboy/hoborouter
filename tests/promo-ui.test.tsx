// Unified promo panel UI contract (jsdom, real React, mocked network only):
// - Exactly ONE promo input + Apply on the credits page: server-driven kind via
//   POST /api/v1/workspaces/:id/promotions/preview { code, original_amount_vnd? };
// - No client format gate: legacy 32-hex and freeform (spaces/Unicode) codes are
//   both sent (outer-trimmed); validity is server truth;
// - Fixed preview NEVER credits: it only previews; the explicit Confirm button
//   is what POSTs the existing redeem endpoint { code };
// - Percent preview renders server discount_vnd/final_due_vnd verbatim (never
//   client money math) and only attaches to the top-up on an explicit action;
// - Race guard: a preview response is applied only if its attempt is current,
//   the workspace is unchanged, and the typed code is unchanged; stale
//   responses (older attempt / other code / other workspace) are dropped;
// - Amount change re-previews percent with the new original_amount_vnd;
// - Input change detaches a stale attached top-up code and clears the preview;
//   workspace change resets input and detaches;
// - Server failures (404 masking, expired, suspended, auth) render honest
//   friendly messages and never auto-retry or auto-submit.
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

// Top-level (not beforeAll): bun evaluates top-level await imports BEFORE
// beforeAll hooks run; react-dom must see DOM globals at module load.
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

// Restore every installed global after the run (bounded existing pattern, same
// as oauth-ui/help-context): without this, this file's jsdom window/document
// leak into later test files sharing the bun worker and break their SSR
// renders. Scheduled react-dom work is drained inside act FIRST, while the
// window still exists — scheduler callbacks read window.event at flush time.
afterAll(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  W.close();
});

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");

const { PromoCodePanel } = await import("../apps/web/src/components/redeem-promo");
type PromoCodePanelProps = import("../apps/web/src/components/redeem-promo").PromoCodePanelProps;

// --- harness -------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface PanelOpts {
  workspaceId?: string;
  amountVnd?: number | null;
  attachedCode?: string | null;
  onAttach?: (code: string) => void;
  onDetach?: () => void;
}

interface Harness {
  container: HTMLElement;
  qc: QueryClient;
  fetchCalls: FetchCall[];
  setFetch: (handler: FetchHandler) => void;
  input: HTMLInputElement;
  applyButton: HTMLButtonElement;
  buttonByText: (text: string) => HTMLButtonElement | undefined;
  typeCode: (value: string) => Promise<void>;
  clickButton: (text: string) => Promise<void>;
  rerender: (opts: PanelOpts) => Promise<void>;
  attachCalls: string[];
  detachCalls: number;
  cleanup: () => void;
}

function mount(opts: PanelOpts = {}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["wallet", opts.workspaceId ?? "ws_1"], { balance: 100_000 });
  qc.setQueryData(["ledger", opts.workspaceId ?? "ws_1"], { data: [] });
  const root = createRoot(container);

  const attachCalls: string[] = [];
  let detachCalls = 0;
  let current: PanelOpts = { workspaceId: "ws_1", amountVnd: null, attachedCode: null, ...opts };
  const render = () =>
    act(() => {
      const props: PromoCodePanelProps = {
        workspaceId: current.workspaceId ?? "ws_1",
        amountVnd: current.amountVnd ?? null,
        attachedCode: current.attachedCode ?? null,
        onAttach: (code: string) => {
          attachCalls.push(code);
          current = { ...current, attachedCode: code };
          render();
          current.onAttach?.(code);
        },
        onDetach: () => {
          detachCalls += 1;
          current = { ...current, attachedCode: null };
          render();
          current.onDetach?.();
        },
      };
      root.render(
        <QueryClientProvider client={qc}>
          <PromoCodePanel {...props} />
        </QueryClientProvider>,
      );
    });
  render();

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = async () => jsonResponse(500, {});
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;

  const input = () => container.querySelector<HTMLInputElement>("#promo-code-input")!;
  const buttonByText = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  return {
    container,
    qc,
    fetchCalls,
    setFetch: (h) => {
      handler = h;
    },
    get input() {
      return input();
    },
    get applyButton() {
      return buttonByText("Apply")!;
    },
    buttonByText,
    async typeCode(value: string) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input(), value);
        input().dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async clickButton(text: string) {
      await act(async () => {
        buttonByText(text)!.dispatchEvent(
          new W.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async rerender(next: PanelOpts) {
      current = { ...current, ...next };
      render();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    attachCalls,
    get detachCalls() {
      return detachCalls;
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
  };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const previewPath = (ws: string) => `/api/v1/workspaces/${ws}/promotions/preview`;
const redeemPath = (ws: string) => `/api/v1/workspaces/${ws}/promotions/redeem`;

// --- render / one input ---------------------------------------------------

test("renders one promo input + Apply; no client 32-hex gate (legacy and freeform both sent)", async () => {
  const h = mount();
  try {
    expect(h.input.value).toBe("");
    expect(h.applyButton.textContent).toContain("Apply");

    // Legacy 32-hex code: accepted (server normalization is the only gate).
    h.setFetch(async () =>
      jsonResponse(200, {
        kind: "fixed",
        promo_id: "p1",
        name: "Legacy",
        amount_vnd: 50_000,
      }),
    );
    await h.typeCode("A".repeat(32));
    await h.clickButton("Apply");
    expect(JSON.parse(String(h.fetchCalls[0]!.init?.body))).toEqual({
      code: "A".repeat(32),
    });

    // Freeform code with inner space and outer whitespace: sent outer-trimmed.
    h.setFetch(async () =>
      jsonResponse(200, { kind: "fixed", promo_id: "p2", name: "Freeform", amount_vnd: 1 }),
    );
    await h.typeCode("  summer sale 2026  ");
    await h.clickButton("Apply");
    expect(JSON.parse(String(h.fetchCalls[1]!.init?.body))).toEqual({
      code: "summer sale 2026",
    });
  } finally {
    h.cleanup();
  }
});

test("empty code: friendly error, no network request", async () => {
  const h = mount();
  try {
    h.setFetch(async () => {
      throw new Error("network must not be hit");
    });
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("Enter a promo code");
    expect(h.fetchCalls.length).toBe(0);
  } finally {
    h.cleanup();
  }
});

// --- fixed preview: no premature credit ----------------------------------

test("fixed preview shows 'Redeem X₫ credit?' and posts NOTHING else until explicit confirm", async () => {
  const h = mount();
  try {
    h.setFetch(async (url) => {
      if (url === previewPath("ws_1"))
        return jsonResponse(200, {
          kind: "fixed",
          promo_id: "p1",
          name: "New year credit",
          amount_vnd: 50_000,
        });
      throw new Error(`unexpected ${url}`);
    });
    await h.typeCode("NEWYEAR");
    await h.clickButton("Apply");

    // Only the preview POST happened; the redeem endpoint was never touched.
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.url).toBe(previewPath("ws_1"));
    expect(h.fetchCalls[0]!.init?.method).toBe("POST");
    expect(h.container.textContent).toContain("Redeem 50.000 ₫ credit?");
    expect(h.container.textContent).not.toContain("150.000");

    // Explicit confirm → the existing redeem endpoint with { code }.
    h.setFetch(async (url, init) => {
      if (url === redeemPath("ws_1") && init?.method === "POST")
        return jsonResponse(200, { balance: 150_000, credited_vnd: 50_000, promo_id: "p1" });
      throw new Error(`unexpected ${url} ${String(init?.method)}`);
    });
    await h.clickButton("Confirm redeem");
    expect(h.fetchCalls.length).toBe(2);
    expect(h.fetchCalls[1]!.url).toBe(redeemPath("ws_1"));
    expect(JSON.parse(String(h.fetchCalls[1]!.init?.body))).toEqual({ code: "NEWYEAR" });
    // Success shows credited amount + new balance (server truth) and refreshes.
    expect(h.container.textContent).toContain("50.000 ₫");
    expect(h.container.textContent).toContain("150.000 ₫");
    expect(h.qc.getQueryState(["wallet", "ws_1"])?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(["ledger", "ws_1"])?.isInvalidated).toBe(true);
  } finally {
    h.cleanup();
  }
});

test("fixed redeem failure (ALREADY_REDEEMED) maps to a friendly message, no success", async () => {
  const h = mount();
  try {
    h.setFetch(async (url) => {
      if (url === previewPath("ws_1"))
        return jsonResponse(200, {
          kind: "fixed",
          promo_id: "p1",
          name: "X",
          amount_vnd: 50_000,
        });
      if (url === redeemPath("ws_1"))
        return jsonResponse(409, {
          error: { code: "ALREADY_REDEEMED", message: "already redeemed" },
        });
      throw new Error(`unexpected ${url}`);
    });
    await h.typeCode("CODE1");
    await h.clickButton("Apply");
    await h.clickButton("Confirm redeem");
    expect(h.container.textContent).toContain("already used");
    expect(h.qc.getQueryState(["wallet", "ws_1"])?.isInvalidated ?? false).toBe(false);
  } finally {
    h.cleanup();
  }
});

// --- percent preview: server money only, explicit attach ------------------

test("percent preview renders server discount/due verbatim and attaches only on explicit action", async () => {
  const h = mount({ amountVnd: 100_000 });
  try {
    h.setFetch(async (url, init) => {
      if (url === previewPath("ws_1")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          code: "SUMMER3",
          original_amount_vnd: 100_000,
        });
        return jsonResponse(200, {
          kind: "percent",
          promo_id: "p2",
          name: "Summer 3%",
          percent_bp: 300,
          max_discount_vnd: 10_000,
          discount_vnd: 3_000,
          final_due_vnd: 97_000,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    await h.typeCode("SUMMER3");
    await h.clickButton("Apply");

    // Server money verbatim; never recomputed client-side.
    expect(h.container.textContent).toContain("3%");
    expect(h.container.textContent).toContain("3.000 ₫");
    expect(h.container.textContent).toContain("97.000 ₫");
    // No redeem endpoint call for a percent code — it never credits a wallet.
    expect(h.fetchCalls.every((c) => !c.url.endsWith("/redeem"))).toBe(true);

    await h.clickButton("Apply to top-up");
    expect(h.attachCalls).toEqual(["SUMMER3"]);
    expect(h.container.textContent).toContain("attached");
  } finally {
    h.cleanup();
  }
});

test("percent preview without a top-up amount omits original_amount_vnd (no client money math)", async () => {
  const h = mount({ amountVnd: null });
  try {
    h.setFetch(async (url, init) => {
      if (url === previewPath("ws_1")) {
        expect(JSON.parse(String(init?.body))).toEqual({ code: "SUMMER3" });
        return jsonResponse(200, {
          kind: "percent",
          promo_id: "p2",
          name: "Summer 3%",
          percent_bp: 300,
          max_discount_vnd: 10_000,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    await h.typeCode("SUMMER3");
    await h.clickButton("Apply");
    // No amount → no discount/due numbers promised; percent + cap still shown.
    expect(h.container.textContent).toContain("3%");
    expect(h.container.textContent).toContain("10.000 ₫");
    expect(h.container.textContent).not.toContain("97.000 ₫");
  } finally {
    h.cleanup();
  }
});

// --- reactivity: amount / input / workspace -------------------------------

test("top-up amount change re-previews percent with the new original_amount_vnd", async () => {
  const h = mount({ amountVnd: 100_000 });
  try {
    const second = deferred<Response>();
    let calls = 0;
    h.setFetch(async (url, init) => {
      if (url !== previewPath("ws_1")) throw new Error(`unexpected ${url}`);
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) {
        expect(body).toEqual({ code: "SUMMER3", original_amount_vnd: 100_000 });
        return jsonResponse(200, {
          kind: "percent",
          promo_id: "p2",
          name: "Summer 3%",
          percent_bp: 300,
          max_discount_vnd: 10_000,
          discount_vnd: 3_000,
          final_due_vnd: 97_000,
        });
      }
      expect(body).toEqual({ code: "SUMMER3", original_amount_vnd: 200_000 });
      return second.promise;
    });
    await h.typeCode("SUMMER3");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("97.000 ₫");

    // Amount prop changes → automatic re-preview (attempt-guarded), same code.
    await h.rerender({ amountVnd: 200_000 });
    second.resolve(
      jsonResponse(200, {
        kind: "percent",
        promo_id: "p2",
        name: "Summer 3%",
        percent_bp: 300,
        max_discount_vnd: 10_000,
        discount_vnd: 6_000,
        final_due_vnd: 194_000,
      }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.container.textContent).toContain("194.000 ₫");
  } finally {
    h.cleanup();
  }
});

test("amount change hides stale percent numbers during re-preview; a late old response never overrides the newer one", async () => {
  const h = mount({ amountVnd: 100_000 });
  try {
    let calls = 0;
    const resolvers: Record<number, (res: Response) => void> = {};
    const percent = (discount: number, due: number) =>
      jsonResponse(200, {
        kind: "percent",
        promo_id: "p2",
        name: "Summer 3%",
        percent_bp: 300,
        max_discount_vnd: 20_000,
        discount_vnd: discount,
        final_due_vnd: due,
      });
    h.setFetch(async (url, init) => {
      if (url !== previewPath("ws_1")) throw new Error(`unexpected ${url}`);
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) {
        expect(body).toEqual({ code: "SUMMER3", original_amount_vnd: 100_000 });
        return percent(3_000, 97_000);
      }
      // Calls 2 (200k) and 3 (300k) hang until released; call 4 (400k) is fast.
      expect(body).toEqual({
        code: "SUMMER3",
        original_amount_vnd: calls === 2 ? 200_000 : calls === 3 ? 300_000 : 400_000,
      });
      if (calls === 4) return percent(12_000, 388_000);
      const d = deferred<Response>();
      resolvers[calls] = d.resolve;
      return d.promise;
    });
    await h.typeCode("SUMMER3");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("97.000 ₫");

    // Amount 100k -> 200k: automatic re-preview fires and the OLD computed
    // discount/due are never shown against the new amount while it loads.
    await h.rerender({ amountVnd: 200_000 });
    expect(h.container.textContent).not.toContain("3.000 ₫");
    expect(h.container.textContent).not.toContain("97.000 ₫");
    resolvers[2]!(percent(6_000, 194_000));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.container.textContent).toContain("194.000 ₫");

    // 200k -> 300k (slow) then 300k -> 400k (fast): the slow 300k response
    // lands last and must be dropped — the 400k numbers stay.
    await h.rerender({ amountVnd: 300_000 });
    await h.rerender({ amountVnd: 400_000 });
    expect(h.container.textContent).toContain("388.000 ₫");
    resolvers[3]!(percent(9_000, 291_000));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.container.textContent).toContain("388.000 ₫");
    expect(h.container.textContent).not.toContain("291.000 ₫");
  } finally {
    h.cleanup();
  }
});

test("input change clears the preview and detaches a stale attached top-up code", async () => {
  const h = mount({ amountVnd: 100_000 });
  try {
    h.setFetch(async () =>
      jsonResponse(200, {
        kind: "percent",
        promo_id: "p2",
        name: "Summer 3%",
        percent_bp: 300,
        max_discount_vnd: 10_000,
        discount_vnd: 3_000,
        final_due_vnd: 97_000,
      }),
    );
    await h.typeCode("SUMMER3");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("97.000 ₫");
    // Explicit attach (the harness mirrors the parent: the prop updates).
    await h.clickButton("Apply to top-up");
    expect(h.attachCalls).toEqual(["SUMMER3"]);
    expect(h.detachCalls).toBe(0);

    // Editing the input invalidates the old preview and detaches the code.
    await h.typeCode("SUMMER5");
    expect(h.container.textContent).not.toContain("97.000 ₫");
    expect(h.detachCalls).toBe(1);
    // No new preview was fired by typing alone — Apply is explicit.
    expect(h.fetchCalls.length).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("workspace change resets input, hides stale results and detaches the attached code", async () => {
  const h = mount();
  try {
    h.setFetch(async () =>
      jsonResponse(200, {
        kind: "fixed",
        promo_id: "p1",
        name: "X",
        amount_vnd: 50_000,
      }),
    );
    await h.typeCode("CODE1");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("Redeem 50.000 ₫ credit?");

    await h.rerender({ workspaceId: "ws_2", attachedCode: "CODE1" });
    // Input cleared, preview hidden, and the code attached for ws_1 detached.
    expect(h.input.value).toBe("");
    expect(h.container.textContent).not.toContain("Redeem 50.000 ₫ credit?");
    expect(h.detachCalls).toBe(1);
  } finally {
    h.cleanup();
  }
});

test("stale preview response (older attempt / different code) is dropped", async () => {
  const h = mount();
  try {
    const slowA = deferred<Response>();
    h.setFetch(async () => slowA.promise);
    await h.typeCode("CODEA");
    await h.clickButton("Apply");

    // Code changes, a fast preview for B resolves first. The panel renders the
    // server's percent/cap/due data; B's cap (20.000 ₫) and due (95.000 ₫) are
    // its distinctive markers (A is fixed with amount_vnd 1).
    h.setFetch(async () =>
      jsonResponse(200, {
        kind: "percent",
        promo_id: "pb",
        name: "Promo B",
        percent_bp: 500,
        max_discount_vnd: 20_000,
        discount_vnd: 5_000,
        final_due_vnd: 95_000,
      }),
    );
    await h.typeCode("CODEB");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("95.000 ₫");

    // The slow response for CODEA lands late and must be ignored: B's preview
    // stays, A's fixed "Redeem 1 ₫ credit?" never appears.
    slowA.resolve(
      jsonResponse(200, { kind: "fixed", promo_id: "pa", name: "Promo A", amount_vnd: 1 }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.container.textContent).toContain("95.000 ₫");
    expect(h.container.textContent).not.toContain("Redeem 1 ₫ credit?");
  } finally {
    h.cleanup();
  }
});

// --- honest server error mapping (never auto-retry) ----------------------

test("preview failures render honest friendly messages and never auto-submit", async () => {
  const cases: Array<{
    label: string;
    respond: () => Promise<Response>;
    expectText: string;
  }> = [
    {
      label: "unknown code (404 NOT_FOUND masking)",
      respond: async () =>
        jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } }),
      expectText: "Unknown code",
    },
    {
      label: "expired (409 PROMO_EXPIRED)",
      respond: async () =>
        jsonResponse(409, { error: { code: "PROMO_EXPIRED", message: "expired" } }),
      expectText: "expired",
    },
    {
      label: "exhausted (409 PROMO_EXHAUSTED)",
      respond: async () =>
        jsonResponse(409, { error: { code: "PROMO_EXHAUSTED", message: "exhausted" } }),
      expectText: "no redemptions left",
    },
    {
      label: "inactive (409 PROMO_INACTIVE)",
      respond: async () =>
        jsonResponse(409, { error: { code: "PROMO_INACTIVE", message: "inactive" } }),
      expectText: "not active",
    },
    {
      label: "suspended workspace (403 WORKSPACE_SUSPENDED)",
      respond: async () =>
        jsonResponse(403, {
          error: { code: "WORKSPACE_SUSPENDED", message: "suspended" },
        }),
      expectText: "suspended",
    },
    {
      label: "session ended (401)",
      respond: async () => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
      expectText: "sign in",
    },
  ];
  for (const c of cases) {
    const h = mount();
    try {
      h.setFetch(c.respond);
      await h.typeCode("CODE1");
      await h.clickButton("Apply");
      expect(h.container.textContent).toContain(c.expectText);
      // Honest, single attempt: no auto-retry, no auto-redeem, no auto-topup.
      expect(h.fetchCalls.length).toBe(1);
    } finally {
      h.cleanup();
    }
  }
});

test("unexpected network failure maps to the generic message", async () => {
  const h = mount();
  try {
    h.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await h.typeCode("CODE1");
    await h.clickButton("Apply");
    expect(h.container.textContent).toContain("try again");
  } finally {
    h.cleanup();
  }
});

// --- Seam 3: heading/label/benefit copy contract -------------------------

const BENEFIT_EN = "Enter a promo code to save on your next top-up or receive bonus credit.";

function visibleText(container: HTMLElement): string {
  // sr-only content stays in textContent; exclude it by class.
  const clone = container.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(".sr-only")) el.remove();
  return clone.textContent ?? "";
}

test("one visible 'Promo code' heading; label is sr-only with htmlFor preserved; benefit copy visible once", async () => {
  const h = mount();
  try {
    const headings = [...h.container.querySelectorAll("h3")].filter(
      (el) => el.textContent?.trim() === "Promo code",
    );
    expect(headings.length).toBe(1);

    // Accessible label still names the input (screen-reader text), but is not
    // shown twice next to the identical heading.
    const label = h.container.querySelector<HTMLLabelElement>('label[for="promo-code-input"]');
    expect(label).toBeTruthy();
    expect(label!.className).toContain("sr-only");
    expect(visibleText(h.container)).not.toContain("Mã khuyến mãi");

    // Benefit copy: exactly one visible occurrence beneath the input.
    expect(visibleText(h.container).split(BENEFIT_EN).length - 1).toBe(1);

    // Input describes itself via the benefit paragraph (aria-describedby).
    const input = h.container.querySelector<HTMLInputElement>("#promo-code-input")!;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(h.container.querySelector(`[id="${describedBy!}"]`)?.textContent).toContain(BENEFIT_EN);
  } finally {
    h.cleanup();
  }
});

test("benefit copy renders in Vietnamese under the vi locale", async () => {
  const { useLocaleStore } = await import("../apps/web/src/lib/i18n/locale");
  const prev = useLocaleStore.getState().locale;
  act(() => useLocaleStore.getState().setLocale("vi"));
  const h = mount();
  try {
    expect(
      visibleText(h.container).split(
        "Nhập mã khuyến mãi để tiết kiệm cho lần nạp tiếp theo hoặc nhận thêm tín dụng thưởng.",
      ).length - 1,
    ).toBe(1);
  } finally {
    h.cleanup();
    act(() => useLocaleStore.getState().setLocale(prev));
  }
});

// --- focused helper: error mapping is total ------------------------------

test("previewErrorKey maps any error to a dictionary key (no crash, no raw code leak)", async () => {
  const { previewErrorKey } = await import("../apps/web/src/components/redeem-promo");
  const { ApiError } = await import("../apps/web/src/lib/api");
  expect(previewErrorKey(new ApiError(400, "INVALID_CODE", "x"))).toBe("errFormat");
  expect(previewErrorKey(new ApiError(400, "INVALID_AMOUNT", "x"))).toBe("errAmount");
  expect(previewErrorKey(new ApiError(404, "NOT_FOUND", "x"))).toBe("errNotFound");
  expect(previewErrorKey(new ApiError(404, "PROMO_NOT_FOUND", "x"))).toBe("errNotFound");
  expect(previewErrorKey(new ApiError(409, "ALREADY_REDEEMED", "x"))).toBe("errReplay");
  expect(previewErrorKey(new ApiError(409, "PROMO_EXPIRED", "x"))).toBe("errExpired");
  expect(previewErrorKey(new ApiError(409, "PROMO_EXHAUSTED", "x"))).toBe("errExhausted");
  expect(previewErrorKey(new ApiError(409, "PROMO_INACTIVE", "x"))).toBe("errInactive");
  expect(previewErrorKey(new ApiError(403, "WORKSPACE_SUSPENDED", "x"))).toBe("errSuspended");
  expect(previewErrorKey(new ApiError(401, "UNAUTHORIZED", "x"))).toBe("errAuth");
  expect(previewErrorKey(new ApiError(500, "unknown", "x"))).toBe("errGeneric");
  expect(previewErrorKey(new TypeError("boom"))).toBe("errGeneric");
});
