// Promo code redeem UI contract (jsdom, real React, mocked network only):
// - Controlled code input, no persistence/log, friendly client validation
//   before any request;
// - POST /api/v1/workspaces/:id/promotions/redeem with { code } captured at
//   submit; success invalidates ['wallet', ws] and ['ledger', ws] for the
//   captured workspace only;
// - Replay/expired/suspended/auth failures map to friendly messages;
// - Workspace identity boundary: success/error from one workspace never shows
//   after the workspace changes, and the input resets on change.
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
// jsdom realm constructors: dispatchEvent only accepts Events from its own realm,
// so tests must build events with these, not Bun's built-in Event global.
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
// beforeAll hooks run. react-dom computes isInputEventSupported (and
// canUseDOM) at module load, so the DOM globals must exist before the module
// graph below imports react-dom — otherwise React falls back to its IE
// propertychange polyfill and delegated onChange never fires in jsdom.
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

// tests/tsconfig.json maps only react-dom/server; no react-dom/client specifier
// exists in the install graph. Runtime resolution goes through the apps/web
// symlink; the type error is suppressed rather than widening tsconfig ownership.
// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");

const { default: RedeemPromo } = await import("../apps/web/src/components/redeem-promo");

const { ApiError } = await import("../apps/web/src/lib/api");

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

interface Harness {
  container: HTMLElement;
  qc: QueryClient;
  fetchCalls: FetchCall[];
  setFetch: (handler: FetchHandler) => void;
  input: HTMLInputElement;
  submitButton: HTMLButtonElement;
  submit: () => Promise<void>;
  typeCode: (value: string) => Promise<void>;
  rerender: (workspaceId: string) => Promise<void>;
  cleanup: () => void;
}

const VALID_CODE = "a".repeat(32);

function mount(initialWorkspaceId: string): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the exact queries the contract must invalidate, with fresh state.
  qc.setQueryData(["wallet", initialWorkspaceId], { balance: 100_000 });
  qc.setQueryData(["ledger", initialWorkspaceId], { data: [] });
  const root = createRoot(container);

  let workspaceId = initialWorkspaceId;
  const render = () =>
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <RedeemPromo workspaceId={workspaceId} />
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

  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

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
    get submitButton() {
      return submitButton();
    },
    async typeCode(value: string) {
      await act(async () => {
        // Set via the prototype value setter (bypasses React's value tracker
        // "currentValue" cache), then fire the jsdom-realm input event React
        // listens for. Direct node.value assignment updates the tracker too,
        // so React's dirty-check would swallow the change.
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input(), value);
        input().dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async submit() {
      await act(async () => {
        submitButton().dispatchEvent(
          new W!.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        // Let mutation microtasks (fetch + state updates) settle.
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async rerender(nextWorkspaceId: string) {
      workspaceId = nextWorkspaceId;
      render();
      await act(async () => {
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

// Seed the promo network contract once per harness for convenience.
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// --- render --------------------------------------------------------------

test("renders label, empty controlled input, submit button (English default)", () => {
  const h = mount("ws_1");
  try {
    expect(h.container.querySelector("label")?.textContent).toContain("Promo code");
    expect(h.input.value).toBe("");
    expect(h.submitButton.textContent).toContain("Redeem");
    expect(h.submitButton.disabled).toBe(false);
  } finally {
    h.cleanup();
  }
});

// --- client validation ---------------------------------------------------

test("empty code: friendly error, no network request", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () => {
      throw new Error("network must not be hit");
    });
    await h.submit();
    expect(h.container.textContent).toContain("Enter a promo code");
    expect(h.fetchCalls.length).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("malformed code: friendly error, no network request", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () => {
      throw new Error("network must not be hit");
    });
    await h.typeCode("promo-123");
    await h.submit();
    expect(h.container.textContent).toContain("32");
    expect(h.fetchCalls.length).toBe(0);
  } finally {
    h.cleanup();
  }
});

// --- happy path ----------------------------------------------------------

test("valid code: POST path+body, pending disables submit, success shows credited amount and balance, invalidates captured workspace queries", async () => {
  const h = mount("ws_1");
  try {
    const gate = deferred<void>();
    h.setFetch(async () => {
      await gate.promise;
      return jsonResponse(200, { balance: 150_000, credited_vnd: 50_000, promo_id: "p1" });
    });
    await h.typeCode(VALID_CODE);
    // Await the submit act itself: the gate keeps the response in flight, so
    // pending is committed by the act flush while the request is still open.
    // (Asserting before awaiting raced TanStack's notifyManager macrotask and,
    // on failure, poisoned the act queue for every later test in the file.)
    await h.submit();
    // During the in-flight request: submit disabled, no success yet.
    expect(h.submitButton.disabled).toBe(true);
    expect(h.container.textContent).not.toContain("50.000 ₫");
    gate.resolve();
    // Release the gated response inside act so the success setState commits
    // through React's act queue instead of firing an act-environment warning.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.url).toBe("/api/v1/workspaces/ws_1/promotions/redeem");
    expect(h.fetchCalls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(h.fetchCalls[0]!.init?.body))).toEqual({ code: VALID_CODE });

    // Success surfaces the credited amount and the new balance (server truth).
    expect(h.container.textContent).toContain("50.000 ₫");
    expect(h.container.textContent).toContain("150.000 ₫");
    // Pending state cleared.
    expect(h.submitButton.disabled).toBe(false);

    // Both captured-workspace queries invalidated; an unrelated key is not.
    expect(h.qc.getQueryState(["wallet", "ws_1"])?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(["ledger", "ws_1"])?.isInvalidated).toBe(true);
    h.qc.setQueryData(["wallet", "ws_2"], { balance: 1 });
    expect(h.qc.getQueryState(["wallet", "ws_2"])?.isInvalidated).toBe(false);
  } finally {
    h.cleanup();
  }
});

// --- friendly error mapping ---------------------------------------------

test("replay (409 ALREADY_REDEEMED): friendly replay message, no success", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () =>
      jsonResponse(409, {
        error: {
          code: "ALREADY_REDEEMED",
          message: "Promo code already redeemed by this workspace",
        },
      }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("already redeemed");
    expect(h.container.textContent).not.toContain("150.000 ₫");
    expect(h.qc.getQueryState(["wallet", "ws_1"])?.isInvalidated ?? false).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("expired (409 PROMO_EXPIRED): friendly expired message", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () =>
      jsonResponse(409, { error: { code: "PROMO_EXPIRED", message: "Promo code is expired" } }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("expired");
  } finally {
    h.cleanup();
  }
});

test("suspended (403 WORKSPACE_SUSPENDED): friendly suspended message", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () =>
      jsonResponse(403, {
        error: { code: "WORKSPACE_SUSPENDED", message: "Workspace is suspended" },
      }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("suspended");
  } finally {
    h.cleanup();
  }
});

test("auth (401): friendly sign-in message", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () =>
      jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("sign in");
  } finally {
    h.cleanup();
  }
});

test("unexpected network failure: friendly generic message", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("try again");
  } finally {
    h.cleanup();
  }
});

// --- identity boundary ---------------------------------------------------

test("workspace change: input resets, success/error from old workspace not shown in new workspace", async () => {
  const h = mount("ws_1");
  try {
    h.setFetch(async () =>
      jsonResponse(200, { balance: 150_000, credited_vnd: 50_000, promo_id: "p1" }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("50.000 ₫");

    await h.rerender("ws_2");
    // Input cleared and no stale success from ws_1 in ws_2.
    expect(h.input.value).toBe("");
    expect(h.container.textContent).not.toContain("50.000 ₫");

    // Same boundary for errors: fail in ws_2, switch to ws_1, no stale error.
    h.setFetch(async () =>
      jsonResponse(409, { error: { code: "ALREADY_REDEEMED", message: "x" } }),
    );
    await h.typeCode(VALID_CODE);
    await h.submit();
    expect(h.container.textContent).toContain("already redeemed");
    await h.rerender("ws_1");
    expect(h.container.textContent).not.toContain("already redeemed");
    expect(h.input.value).toBe("");
  } finally {
    h.cleanup();
  }
});

// --- focused helper: error mapping is total ------------------------------

test("redeemErrorKey maps any error to a dictionary key (no crash, no raw code leak)", async () => {
  const { redeemErrorKey } = await import("../apps/web/src/components/redeem-promo");
  expect(redeemErrorKey(new ApiError(409, "ALREADY_REDEEMED", "x"))).toBe("errReplay");
  expect(redeemErrorKey(new ApiError(409, "PROMO_EXPIRED", "x"))).toBe("errExpired");
  expect(redeemErrorKey(new ApiError(409, "PROMO_EXHAUSTED", "x"))).toBe("errExhausted");
  expect(redeemErrorKey(new ApiError(409, "PROMO_INACTIVE", "x"))).toBe("errInactive");
  expect(redeemErrorKey(new ApiError(403, "WORKSPACE_SUSPENDED", "x"))).toBe("errSuspended");
  expect(redeemErrorKey(new ApiError(401, "UNAUTHORIZED", "x"))).toBe("errAuth");
  expect(redeemErrorKey(new ApiError(404, "PROMO_NOT_FOUND", "x"))).toBe("errNotFound");
  expect(redeemErrorKey(new ApiError(400, "INVALID_CODE", "x"))).toBe("errFormat");
  expect(redeemErrorKey(new ApiError(500, "unknown", "x"))).toBe("errGeneric");
  expect(redeemErrorKey(new TypeError("boom"))).toBe("errGeneric");
});
