// Admin promotions UI contract (pure form state + semantic SSR render):
// - Create form validation: positive whole VND amount, max uses >= 1 whole,
//   optional expiry that must be a future date (end of the selected local day).
// - Safe-subset table: rows render name/amount/uses/expiry/status; row names
//   are escaped (a hostile name can never inject markup); there is no delete
//   (promo codes are deactivated, amount/uses/expiry terms are immutable).
// - Row actions carry accessible labels built from the promo name.
// - The typed colocated dictionary always has both English and Vietnamese.
// Interaction flows run against real ReactDOM in jsdom with the page's actual
// API hooks and a mocked fetch boundary: exact POST body, pending-disabled,
// error recovery, one-time code reveal/copy/close-clears (never storage or
// URL), exact PATCH bodies (immutable fields absent), and list refresh.
// Updates are flushed with real timer polling (no react act import: the tests
// workspace does not declare a react dependency and this keeps module
// resolution inside the mapped tsconfig paths only).
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

// The page module chain reaches the locale store (zustand persist), which
// binds localStorage when first loaded. Real jsdom is installed as the global
// before importing the page; originals are restored in afterAll.
const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "PointerEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "DocumentFragment",
  "SVGElement",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    close: () => void;
    getComputedStyle: (el: Element) => unknown;
    MutationObserver: unknown;
    Event: unknown;
    CustomEvent: unknown;
    MouseEvent: unknown;
    KeyboardEvent: unknown;
    FocusEvent: unknown;
    InputEvent: unknown;
    PointerEvent: unknown;
    NodeFilter: unknown;
    Node: unknown;
    Element: unknown;
    HTMLElement: unknown;
    HTMLInputElement: unknown;
    HTMLTextAreaElement: unknown;
    HTMLButtonElement: unknown;
    HTMLAnchorElement: unknown;
    HTMLFormElement: unknown;
    HTMLLabelElement: unknown;
    HTMLSelectElement: unknown;
    DocumentFragment: unknown;
    SVGElement: unknown;
  };
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: win.getComputedStyle.bind(win),
    MutationObserver: win.MutationObserver as typeof MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    FocusEvent: win.FocusEvent,
    InputEvent: win.InputEvent,
    PointerEvent: win.PointerEvent,
    NodeFilter: win.NodeFilter,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLSelectElement: win.HTMLSelectElement,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
  ({ promoFormState, promoExpiryMs } = await import("../apps/web/src/pages/admin/promotions"));
  ({ PromotionsCard, promotionsDict } = await import("../apps/web/src/pages/admin/promotions"));
  ({ translate } = await import("../apps/web/src/lib/i18n/t"));
  ({ createRoot } = await import("react-dom/client"));
  ({ default: AdminPromotionsPage } = await import("../apps/web/src/pages/admin/promotions"));
  // Network boundary: the page's real api() talks to this mock fetch.
  globalThis.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

let promoFormState: (typeof import("../apps/web/src/pages/admin/promotions"))["promoFormState"];
let promoExpiryMs: (typeof import("../apps/web/src/pages/admin/promotions"))["promoExpiryMs"];
let PromotionsCard: (typeof import("../apps/web/src/pages/admin/promotions"))["PromotionsCard"];
let promotionsDict: (typeof import("../apps/web/src/pages/admin/promotions"))["promotionsDict"];
let AdminPromotionsPage: (typeof import("../apps/web/src/pages/admin/promotions"))["default"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;
let translate: (typeof import("../apps/web/src/lib/i18n/t"))["translate"];
type AdminPromo = import("../apps/web/src/pages/admin/promotions").AdminPromo;

// --- interaction harness ---------------------------------------------------

const realFetch = globalThis.fetch;
interface FetchCall {
  path: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  return responder(call);
};

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  await flush();
  document.body.innerHTML = "";
  calls = [];
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await flush();
  }
}

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
// jsdom rejects events constructed by foreign (Bun) constructors; always
// create events from the installed jsdom window's own classes.
const winEvents = () => window as unknown as { Event: EventCtor; MouseEvent: EventCtor };

const click = (el: Element) =>
  el.dispatchEvent(new (winEvents().MouseEvent)("click", { bubbles: true, cancelable: true }));

const setInput = (el: Element, value: string) => {
  const input = el as HTMLInputElement;
  // Native prototype setter: React ignores programmatic value assignments.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new (winEvents().Event)("input", { bubbles: true }));
};

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label.replace(/"/g, '\\"')}"]`);

const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const bodyText = () => document.body.textContent ?? "";

const getCodeInDom = () => bodyText().match(/[0-9A-F]{32}/)?.[0] ?? null;

const promoRow = (): AdminPromo => ({
  id: "promo_1",
  name: "Summer promo",
  kind: "fixed",
  amount_vnd: 500000,
  percent_bp: null,
  max_discount_vnd: null,
  max_uses: 10,
  uses: 2,
  expires_at: new Date(2026, 5, 30, 23, 59, 59, 999).getTime(),
  active: true,
  created_at: new Date(2026, 0, 10, 12, 0, 0, 0).getTime(),
});

/** Real page (default export, real hooks) over a mocked fetch boundary. */
async function mountPage(rows: AdminPromo[]) {
  responder = async (call) => {
    if (call.path === "/api/v1/admin/promotions" && (call.init?.method ?? "GET") === "GET")
      return jsonRes(200, { data: rows });
    throw new Error(`unmocked ${call.init?.method ?? "GET"} ${call.path}`);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <AdminPromotionsPage />
    </QueryClientProvider>,
  );
  await waitFor(() => document.getElementById("promo-amount") !== null, "page rendered");
  return qc;
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const postCalls = () =>
  calls.filter((c) => c.path === "/api/v1/admin/promotions" && c.init?.method === "POST");

const patchCalls = () => calls.filter((c) => c.init?.method === "PATCH");

const getCalls = () =>
  calls.filter((c) => c.path === "/api/v1/admin/promotions" && (c.init?.method ?? "GET") === "GET");

// --- pure form state ------------------------------------------------------

const NOW = new Date(2026, 0, 10, 12, 0, 0, 0).getTime(); // 2026-01-10 noon local

const base = {
  kind: "fixed" as const,
  name: "Summer promo",
  amount: "500000",
  percent: "",
  maxDiscount: "",
  maxUses: "10",
  expiresDate: "",
};

function form(overrides: Partial<typeof base>) {
  return promoFormState({ ...base, ...overrides }, NOW);
}

test("valid minimal form: no expiry (null), name trimmed, amounts parsed", () => {
  const s = form({});
  expect(s.valid).toBe(true);
  expect(s.body).toEqual({
    name: "Summer promo",
    amount_vnd: 500000,
    max_uses: 10,
    expires_at: null,
  });
});

test("amount must be a positive whole safe-integer VND amount", () => {
  for (const bad of ["0", "-500", "500.5", "50a", "1e6", "", "   ", "9007199254740992"]) {
    expect(form({ amount: bad }).valid).toBe(false);
    expect(form({ amount: bad }).amountInvalid).toBe(true);
  }
  expect(form({ amount: " 9007199254740991 " }).valid).toBe(true);
});

test("max uses must be a whole number of at least 1", () => {
  for (const bad of ["0", "-1", "1.5", "", "2a"]) {
    expect(form({ maxUses: bad }).valid).toBe(false);
    expect(form({ maxUses: bad }).maxUsesInvalid).toBe(true);
  }
  expect(form({ maxUses: "1" }).valid).toBe(true);
});

test("expiry is optional; empty means no expiry", () => {
  expect(form({ expiresDate: "" }).expiresInvalid).toBe(false);
  expect(form({ expiresDate: "" }).body?.expires_at).toBeNull();
});

test("expiry must be a future date: end of the selected local day", () => {
  // Same day is still future at noon (end of day has not passed).
  expect(promoExpiryMs("2026-01-10", NOW)).toBeGreaterThan(NOW);
  // Yesterday already ended.
  expect(promoExpiryMs("2026-01-09", NOW)).toBe("invalid");
  // Far future is fine.
  expect(promoExpiryMs("2027-06-30", NOW)).toBeGreaterThan(NOW);
  // Malformed and calendar-rollover dates are rejected.
  expect(promoExpiryMs("not-a-date", NOW)).toBe("invalid");
  expect(promoExpiryMs("2026-02-31", NOW)).toBe("invalid");
  expect(form({ expiresDate: "2026-01-09" }).valid).toBe(false);
  expect(form({ expiresDate: "2026-01-09" }).expiresInvalid).toBe(true);
});

test("name is required (non-empty after trim)", () => {
  expect(form({ name: "   " }).valid).toBe(false);
  expect(form({ name: "   " }).nameInvalid).toBe(true);
  expect(form({ name: "  Tết 2026 " }).body?.name).toBe("Tết 2026");
});

test("invalid form yields no body to submit", () => {
  expect(form({ amount: "0" }).body).toBeNull();
});

// --- percent form state ----------------------------------------------------

const percentBase = { ...base, kind: "percent" as const, maxDiscount: "10000" };

function percentForm(overrides: Partial<typeof percentBase>) {
  return promoFormState({ ...percentBase, ...overrides }, NOW);
}

// Friendly percentage input: "3" (or "3%", "3,5") maps exactly to basis
// points — 3% is 300bp, never a float. Bounds match the backend: 1..9999 bp.
test("friendly percent input: 3 -> 300bp, 3% -> 300bp, 3,5 -> 350bp, 0.5 -> 50bp", () => {
  expect(percentForm({ percent: "3" }).percentInvalid).toBe(false);
  expect(percentForm({ percent: "3%" }).percentInvalid).toBe(false);
  expect(percentForm({ percent: "3,5" }).percentInvalid).toBe(false);
  expect(percentForm({ percent: "0.5" }).percentInvalid).toBe(false);
  const body = percentForm({ percent: "3,5" }).body as { kind: string; percent_bp: number };
  expect(body.kind).toBe("percent");
  expect(body.percent_bp).toBe(350);
});

test("percent bounds: bp must land in 1..9999 (0% and 100% rejected)", () => {
  for (const bad of ["0", "100", "99.995", "", "  ", "3.333", "-3", "abc", "1e2"]) {
    expect(percentForm({ percent: bad }).valid).toBe(false);
    expect(percentForm({ percent: bad }).percentInvalid).toBe(true);
    expect(percentForm({ percent: bad }).body).toBeNull();
  }
  expect(percentForm({ percent: "99.99" }).valid).toBe(true);
  expect(percentForm({ percent: "0.01" }).valid).toBe(true);
});

test("percent cap (max_discount_vnd) is required and must be a positive whole VND amount", () => {
  for (const bad of ["", "0", "-5", "500.5", "50a"]) {
    expect(percentForm({ maxDiscount: bad }).valid).toBe(false);
    expect(percentForm({ maxDiscount: bad }).maxDiscountInvalid).toBe(true);
    expect(percentForm({ maxDiscount: bad }).body).toBeNull();
  }
  const body = percentForm({
    percent: "3",
    maxDiscount: "10000",
  }).body as { max_discount_vnd: number };
  expect(body.max_discount_vnd).toBe(10000);
});

test("percent body posts the exact server shape: kind/percent_bp/max_discount_vnd, no amount_vnd", () => {
  const s = percentForm({ percent: "3", maxDiscount: "10000" });
  expect(s.valid).toBe(true);
  expect(s.body).toEqual({
    name: "Summer promo",
    kind: "percent",
    percent_bp: 300,
    max_discount_vnd: 10000,
    max_uses: 10,
    expires_at: null,
  });
  expect("amount_vnd" in (s.body as object)).toBe(false);
});

test("fixed kind ignores percent fields; percent kind ignores amount field", () => {
  // Fixed body is unchanged even with garbage in the percent-only fields.
  const fixed = form({ percent: "junk", maxDiscount: "-1" });
  expect(fixed.valid).toBe(true);
  expect(fixed.amountInvalid).toBe(false);
  expect(fixed.percentInvalid).toBe(false);
  expect(fixed.maxDiscountInvalid).toBe(false);
  expect(fixed.body).toEqual({
    name: "Summer promo",
    amount_vnd: 500000,
    max_uses: 10,
    expires_at: null,
  });
  // Percent body ignores the amount field.
  const percent = percentForm({ amount: "-999", percent: "3", maxDiscount: "10000" });
  expect(percent.valid).toBe(true);
  expect(percent.amountInvalid).toBe(false);
});

// --- semantic SSR render ---------------------------------------------------

/** Safe-subset promo row factory: kind/percent fields default to a fixed promo. */
function promo(partial: Partial<AdminPromo> = {}): AdminPromo {
  return {
    id: "promo_1",
    name: "Summer promo",
    kind: "fixed",
    amount_vnd: 500000,
    percent_bp: null,
    max_discount_vnd: null,
    max_uses: 10,
    uses: 2,
    expires_at: new Date(2026, 5, 30, 23, 59, 59, 999).getTime(),
    active: true,
    created_at: new Date(2026, 0, 10, 12, 0, 0, 0).getTime(),
    ...partial,
  };
}

function renderCard(rows: AdminPromo[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PromotionsCard data={rows} />
    </QueryClientProvider>,
  );
}

test("rows render amount, uses, expiry and status; no delete exists", () => {
  const html = renderCard([promo()]);
  expect(html).toContain("Summer promo");
  expect(html).toContain("₫");
  expect(html).toContain("2 / 10");
  expect(html).toContain("Active");
  expect(html).not.toContain(">Delete<");
  expect(html).not.toContain(">Remove<");
  // Expired-safe row shows a dash instead of a date.
  const none = renderCard([promo({ expires_at: null })]);
  expect(none).toContain("—");
});

test("inactive row renders an Inactive badge and a Reactivate action", () => {
  const html = renderCard([promo({ active: false })]);
  expect(html).toContain("Inactive");
  expect(html).not.toContain(">Deactivate<");
  expect(html).toContain(">Reactivate<");
});

test("hostile row name is escaped, never injected as markup", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = renderCard([promo({ name: evil })]);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("row actions carry accessible labels built from the promo name", () => {
  const html = renderCard([promo({ name: "Tết 2026" })]);
  expect(html).toContain('aria-label="Rename Tết 2026"');
  expect(html).toContain('aria-label="Deactivate Tết 2026"');
});

test("dialogs and one-time code text are absent from initial markup", () => {
  const html = renderCard([promo()]);
  expect(html).not.toContain("shown only once");
  expect(html).not.toContain("Rename promo");
});

test("empty list renders the empty state", () => {
  const html = renderCard([]);
  expect(html).toContain("No promo codes yet");
});

// --- typed colocated dictionary -------------------------------------------

test("every dictionary entry has a natural Vietnamese string", () => {
  for (const key of Object.keys(promotionsDict) as (keyof typeof promotionsDict)[]) {
    const en = promotionsDict[key].en;
    const vi = promotionsDict[key].vi;
    expect(en.length).toBeGreaterThan(0);
    expect(vi.length).toBeGreaterThan(0);
    // Vietnamese must be a real translation, not the English string copied.
    expect(vi).not.toBe(en);
    expect(translate(promotionsDict, key, "vi")).toBe(vi);
  }
});

test("translate interpolates row-label vars literally in both locales", () => {
  expect(translate(promotionsDict, "renameA", "en", { name: "<b>x</b>" })).toBe("Rename <b>x</b>");
  expect(translate(promotionsDict, "renameA", "vi", { name: "<b>x</b>" })).toBe("Đổi tên <b>x</b>");
});

// --- interaction: real ReactDOM, real hooks, mocked fetch boundary --------

test("percent rows render the friendly percent + VND cap; fixed rows render VND", () => {
  const html = renderCard([
    promo({ kind: "percent", amount_vnd: null, percent_bp: 300, max_discount_vnd: 10000 }),
  ]);
  expect(html).toContain("3%");
  expect(html).toContain("10.000 ₫");
  const half = renderCard([
    promo({ kind: "percent", amount_vnd: null, percent_bp: 350, max_discount_vnd: 10000 }),
  ]);
  expect(half).toContain("3.5%");
});

// --- interaction: percent create flow -------------------------------------

function fillCreateForm(name: string, amount: string, maxUses: string, expiresDate = "") {
  setInput(document.getElementById("promo-name")!, name);
  setInput(document.getElementById("promo-amount")!, amount);
  setInput(document.getElementById("promo-max-uses")!, maxUses);
  if (expiresDate) setInput(document.getElementById("promo-expires")!, expiresDate);
}

async function choosePercentKind() {
  // Kind toggle: click the percent option (same accessible group pattern as
  // the top-up currency toggle).
  const btn = buttonByText("Percent off");
  if (!btn) throw new Error("percent kind button not found");
  click(btn);
  await flush();
}

async function fillPercentForm(name: string, percent: string, cap: string, maxUses: string) {
  await choosePercentKind();
  setInput(document.getElementById("promo-name")!, name);
  setInput(document.getElementById("promo-percent")!, percent);
  setInput(document.getElementById("promo-max-discount")!, cap);
  setInput(document.getElementById("promo-max-uses")!, maxUses);
}

test("valid create posts the exact server body and reveals the code once", async () => {
  await mountPage([promoRow()]);
  const post = deferred();
  responder = async (call) => {
    if ((call.init?.method ?? "GET") === "GET" && call.path === "/api/v1/admin/promotions")
      return jsonRes(200, { data: [promoRow()] });
    if (call.init?.method === "POST") return post.promise;
    throw new Error(`unmocked ${call.init?.method} ${call.path}`);
  };
  fillCreateForm("Summer promo", "500000", "10");
  click(buttonByText("Create code")!);
  await flush();
  const sent = postCalls()[0]!;
  expect(JSON.parse(String(sent.init?.body))).toEqual({
    name: "Summer promo",
    amount_vnd: 500000,
    max_uses: 10,
    expires_at: null,
  });
  post.resolve(jsonRes(201, { promo: promoRow(), code: "ABCD0123ABCD0123ABCD0123ABCD0123" }));
  await waitFor(() => getCodeInDom() !== null, "code revealed");
  expect(getCodeInDom()).toBe("ABCD0123ABCD0123ABCD0123ABCD0123");
  // The dialog is the only reveal; create form fields were reset.
  expect((document.getElementById("promo-amount") as HTMLInputElement).value).toBe("");
  // List refresh: the invalidation triggered a second GET.
  await waitFor(() => getCalls().length >= 2, "list refreshed");
  expect(getCodeInDom()).toBe("ABCD0123ABCD0123ABCD0123ABCD0123");
});

test("create with chosen expiry posts end-of-day ms in the future", async () => {
  await mountPage([]);
  responder = async (call) => {
    if (call.init?.method === "POST")
      return jsonRes(201, { promo: promoRow(), code: "BEEF00BEEF00BEEF00BEEF00BEEF00BEEF" });
    return jsonRes(200, { data: [] });
  };
  fillCreateForm("Expiry promo", "100000", "5", "2027-06-30");
  click(buttonByText("Create code")!);
  await waitFor(() => postCalls().length > 0, "post sent");
  const body = JSON.parse(String(postCalls()[0]!.init?.body)) as { expires_at: number | null };
  expect(typeof body.expires_at).toBe("number");
  expect(body.expires_at as number).toBeGreaterThan(Date.now());
  // Same local calendar date, last millisecond of that day.
  expect(new Date(body.expires_at as number).toDateString()).toBe(
    new Date(2027, 5, 30).toDateString(),
  );
});

test("pending create disables submit with Creating label; success recovers", async () => {
  await mountPage([]);
  const post = deferred();
  responder = async (call) => {
    if (call.init?.method === "POST") return post.promise;
    return jsonRes(200, { data: [] });
  };
  fillCreateForm("Pending promo", "1000", "1");
  const submit = buttonByText("Create code")!;
  expect(submit.disabled).toBe(false);
  click(submit);
  await waitFor(() => submit.disabled === true, "submit disabled while pending");
  expect(bodyText()).toContain("Creating\u2026");
  // No duplicate POST can be fired while pending.
  click(submit);
  await flush();
  expect(postCalls().length).toBe(1);
  post.resolve(jsonRes(201, { promo: promoRow(), code: "FEEDFEEDFEEDFEEDFEEDFEEDFEEDFEED" }));
  await waitFor(() => getCodeInDom() !== null, "code revealed after resolve");
  // Pending state fully cleared: label back to Create; fields were reset so
  // the form is (correctly) invalid again, but no longer stuck in pending.
  expect(buttonByText("Creating\u2026")).toBeUndefined();
  expect(buttonByText("Create code")).toBeDefined();
});

test("failed create shows no plaintext and recovers on retry", async () => {
  await mountPage([]);
  responder = async (call) => {
    if (call.init?.method === "POST")
      return jsonRes(400, {
        error: { code: "INVALID", message: "amount_vnd must be a positive integer VND amount" },
      });
    return jsonRes(200, { data: [] });
  };
  fillCreateForm("Fail promo", "1000", "1");
  click(buttonByText("Create code")!);
  await waitFor(() => postCalls().length === 1, "post sent");
  await waitFor(() => !buttonByText("Create code")!.disabled, "submit re-enabled after error");
  expect(getCodeInDom()).toBeNull();
  // Server error message surfaces via toast error (aria-live region absent
  // without a mounted Toaster; assert the mutation did not open the dialog).
  expect(bodyText()).not.toContain("shown only once");
  // Retry with the same valid form succeeds and reveals the code.
  responder = async (call) => {
    if (call.init?.method === "POST")
      return jsonRes(201, { promo: promoRow(), code: "CAFECAFECAFECAFECAFECAFECAFECAFE" });
    return jsonRes(200, { data: [] });
  };
  click(buttonByText("Create code")!);
  await waitFor(() => getCodeInDom() === "CAFECAFECAFECAFECAFECAFECAFECAFE", "retry reveals code");
});

test("code copy uses clipboard; closing the dialog clears it from memory and storage", async () => {
  const written: string[] = [];
  // Page code resolves the ambient global navigator (Bun's), not the jsdom
  // window's, so the stub goes there.
  Object.defineProperty(globalThis.navigator as unknown as object, "clipboard", {
    value: {
      writeText: async (t: string) => {
        written.push(t);
      },
    },
    configurable: true,
  });
  await mountPage([]);
  responder = async (call) => {
    if (call.init?.method === "POST")
      return jsonRes(201, { promo: promoRow(), code: "DEADDEADDEADDEADDEADDEADDEADDEAD" });
    return jsonRes(200, { data: [] });
  };
  fillCreateForm("Copy promo", "1000", "1");
  click(buttonByText("Create code")!);
  await waitFor(() => getCodeInDom() === "DEADDEADDEADDEADDEADDEADDEADDEAD", "code revealed");
  // Copy goes through navigator.clipboard only.
  const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy promo code"]');
  expect(copy).not.toBeNull();
  click(copy!);
  await waitFor(() => written.length === 1, "clipboard written");
  expect(written[0]).toBe("DEADDEADDEADDEADDEADDEADDEADDEAD");
  // No storage or URL leakage.
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(window.location.search).toBe("");
  expect(document.cookie).not.toContain("DEADDEAD");
  // Done closes the dialog and the plaintext is gone everywhere in the DOM.
  click(buttonByText("Done")!);
  await waitFor(() => getCodeInDom() === null, "code cleared on close");
  expect(bodyText()).not.toContain("DEADDEAD");
  expect(window.localStorage.length).toBe(0);
});

test("percent create posts the exact server body and clears the percent fields", async () => {
  await mountPage([]);
  responder = async (call) => {
    if (call.init?.method === "POST")
      return jsonRes(201, {
        promo: promo({
          kind: "percent",
          amount_vnd: null,
          percent_bp: 300,
          max_discount_vnd: 10000,
        }),
        code: "FACE00FACE00FACE00FACE00FACE00FA",
      });
    return jsonRes(200, { data: [] });
  };
  await fillPercentForm("Summer percent", "3", "10000", "10");
  click(buttonByText("Create code")!);
  await waitFor(() => postCalls().length === 1, "percent post sent");
  expect(JSON.parse(String(postCalls()[0]!.init?.body))).toEqual({
    name: "Summer percent",
    kind: "percent",
    percent_bp: 300,
    max_discount_vnd: 10000,
    max_uses: 10,
    expires_at: null,
  });
  await waitFor(() => getCodeInDom() !== null, "code revealed");
  expect((document.getElementById("promo-percent") as HTMLInputElement).value).toBe("");
  expect((document.getElementById("promo-max-discount") as HTMLInputElement).value).toBe("");
});

test("percent form blocks an invalid percent/cap before any POST", async () => {
  await mountPage([]);
  await fillPercentForm("Bad percent", "100", "0", "10");
  click(buttonByText("Create code")!);
  await flush();
  expect(postCalls().length).toBe(0);
});

test("rename PATCHes name only and refreshes the list", async () => {
  await mountPage([promoRow()]);
  responder = async (call) => {
    if (call.init?.method === "PATCH")
      return jsonRes(200, { ...promoRow(), name: "Renamed promo" });
    return jsonRes(200, { data: [{ ...promoRow(), name: "Renamed promo" }] });
  };
  const before = getCalls().length;
  click(buttonByLabel("Rename Summer promo")!);
  await waitFor(() => bodyText().includes("Rename promo"), "rename dialog open");
  setInput(document.getElementById("promo-rename-name")!, "Renamed promo");
  click(buttonByText("Save")!);
  await waitFor(() => patchCalls().length === 1, "patch sent");
  // Exact body: name only — amount/max_uses/expires_at/active are immutable.
  expect(JSON.parse(String(patchCalls()[0]!.init?.body))).toEqual({ name: "Renamed promo" });
  expect(patchCalls()[0]!.path).toBe("/api/v1/admin/promotions/promo_1");
  await waitFor(() => bodyText().includes("Renamed promo"), "list refreshed with new name");
  expect(getCalls().length).toBeGreaterThan(before);
});

test("deactivate PATCHes active:false only and the row flips to Inactive", async () => {
  await mountPage([promoRow()]);
  responder = async (call) => {
    if (call.init?.method === "PATCH") return jsonRes(200, { ...promoRow(), active: false });
    return jsonRes(200, { data: [{ ...promoRow(), active: false }] });
  };
  click(buttonByLabel("Deactivate Summer promo")!);
  await waitFor(() => patchCalls().length === 1, "patch sent");
  expect(JSON.parse(String(patchCalls()[0]!.init?.body))).toEqual({ active: false });
  await waitFor(() => bodyText().includes("Inactive"), "row shows Inactive after refresh");
  expect(buttonByLabel("Deactivate Summer promo")).toBeNull();
  expect(buttonByLabel("Reactivate Summer promo")!.getAttribute("aria-label")).toBe(
    "Reactivate Summer promo",
  );
});

test("non-admin 403 renders the admin-only gate with no create form", async () => {
  responder = async () => jsonRes(403, { error: { code: "FORBIDDEN", message: "Admin only" } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <AdminPromotionsPage />
    </QueryClientProvider>,
  );
  await waitFor(() => bodyText().includes("Admin only"), "admin gate");
  expect(document.getElementById("promo-amount")).toBeNull();
  expect(buttonByText("Create code")).toBeUndefined();
  expect(postCalls().length).toBe(0);
});
