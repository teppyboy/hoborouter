// Member chat policy UI contract (jsdom, real React hooks, stubbed fetch only):
// - Admin editor (components/member-chat-policy.tsx default export) is visible
//   only to owners/admins via the existing members query (precheck); a plain
//   member renders nothing and never calls the admin-only policy endpoint.
// - Enabling requires a positive integer VND cap client-side; the PUT body is
//   exactly {enabled, daily_cap_vnd} — disabling sends cap null, and the server
//   is the authority for any rejection (shown inline, no local-state reset).
// - MemberChatAccessView is read-only: can_chat false asks an admin (or shows
//   the exhausted-limit reset time when remaining_vnd === 0); can_chat true
//   shows used/cap/remaining and reset time, with no reset control ever.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
// Window-manager stubs must be seeded before the better-auth client (via
// useSession) is first imported — same contract as the other useSession UI tests.
import { isolateBetterAuthClientWindowManagers } from "./helpers/better-auth-client-isolation";

isolateBetterAuthClientWindowManagers();

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "DocumentFragment",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "localStorage",
  "location",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "PointerEvent",
  "InputEvent",
  "KeyboardEvent",
  "FocusEvent",
  "HTMLTextAreaElement",
  "HTMLLabelElement",
  "HTMLAnchorElement",
  "HTMLSelectElement",
  "SVGElement",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
let W: typeof globalThis & {
  document: Document;
  Event: new (type: string, init?: EventInit) => Event;
  MouseEvent: new (type: string, init?: MouseEventInit) => MouseEvent;
  close: () => void;
};
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let MemberChatPolicySection: (typeof import("../apps/web/src/components/member-chat-policy"))["default"];
let MemberChatAccessView: (typeof import("../apps/web/src/components/member-chat-policy"))["MemberChatAccessView"];
let realFetch: typeof fetch | undefined;

// Session identity comes from stubbing fetch for Better Auth's
// /api/auth/get-session before the app modules are imported (no mock.module,
// which bun applies process-wide and would break sibling test files).
const SESSION = {
  user: { id: "u1", name: "Admin", email: "a@example.com" },
  session: { userId: "u1" },
};

beforeAll(async () => {
  await new Promise((r) => setTimeout(r, 60));
  W = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as typeof W;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const [k, v] of Object.entries({
    window: W,
    document: W.document,
    Node: W.Node,
    NodeFilter: W.NodeFilter,
    Element: W.Element,
    HTMLElement: W.HTMLElement,
    HTMLInputElement: W.HTMLInputElement,
    HTMLFormElement: W.HTMLFormElement,
    HTMLButtonElement: W.HTMLButtonElement,
    DocumentFragment: W.DocumentFragment,
    getComputedStyle: W.getComputedStyle.bind(W),
    MutationObserver: W.MutationObserver,
    CustomEvent: W.CustomEvent,
    Event: W.Event,
    MouseEvent: W.MouseEvent,
    localStorage: W.localStorage,
  })) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow = W;

  stubFetch();

  // @ts-expect-error relative specifier has no declaration file under tests tsconfig
  createRoot = (await import("../apps/web/node_modules/react-dom/client")).createRoot;
  const mod = await import("../apps/web/src/components/member-chat-policy");
  MemberChatPolicySection = mod.default;
  MemberChatAccessView = mod.MemberChatAccessView;
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise<void>((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        r();
      };
      ch.port2.postMessage(0);
    });
  }
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete (globalThis as Record<string, unknown>).ResizeObserver;
  if (jsdomWindow) jsdomWindow.close();
  jsdomWindow = null;
});

// --- fixtures -------------------------------------------------------------

interface PolicyShape {
  enabled: boolean;
  daily_cap_vnd: number | null;
}

interface AccessShape {
  role: "owner" | "admin" | "member";
  can_chat: boolean;
  daily_cap_vnd: number | null;
  used_vnd: number;
  remaining_vnd: number | null;
  resets_at: number;
}

interface Ctx {
  role: "owner" | "admin" | "member";
  policy: PolicyShape;
  putStatus?: number;
  putBody?: unknown;
  access?: AccessShape;
}

function jsonResponse(status: number, body: unknown): Response {
  // Real Response: the better-auth client inspects headers/ok, not just json().
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let calls: { url: string; method: string; body: string | undefined }[] = [];
let ctx: Ctx;

function stubFetch() {
  realFetch = realFetch ?? globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const call = {
      url: path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    if (path.includes("/api/auth/get-session")) return jsonResponse(200, SESSION);
    if (path.includes("/api/v1/workspaces/ws1/members"))
      return jsonResponse(200, [
        { user_id: "u1", role: ctx.role, email: "a@example.com", name: "Admin" },
      ]);
    if (path.includes("/member-chat-policy")) {
      if (call.method === "PUT") {
        ctx.putBody = JSON.parse(call.body ?? "null");
        const status = ctx.putStatus ?? 200;
        if (status >= 400)
          return jsonResponse(status, { error: { code: "forbidden", message: "Admin only" } });
        ctx.policy = ctx.putBody as PolicyShape;
        return jsonResponse(200, ctx.policy);
      }
      return jsonResponse(200, ctx.policy);
    }
    if (path.includes("/member-chat-access")) return jsonResponse(200, ctx.access ?? null);
    return jsonResponse(200, {});
  }) as typeof fetch;
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));
    });
  };
  const bodyText = () => container.textContent ?? "";
  const sw = () => container.querySelector('[role="switch"]') as HTMLElement | null;
  const clickSwitch = () => {
    const el = sw();
    if (!el) throw new Error("switch not found");
    act(() => {
      el.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
    });
  };
  const capInput = () =>
    document.getElementById("member-chat-daily-cap") as HTMLInputElement | null;
  const setCap = (value: string) => {
    const el = capInput();
    if (!el) throw new Error("cap input not found");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    act(() => {
      el.dispatchEvent(new W.Event("input", { bubbles: true }));
    });
  };
  const clickSave = () => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    );
    if (!button) throw new Error('button "Save" not found');
    act(() => {
      button.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
    });
  };
  const unmount = async () => {
    await act(async () => {
      await qc.cancelQueries();
    });
    act(() => root.unmount());
    qc.clear();
    container.remove();
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { container, settle, bodyText, sw, clickSwitch, capInput, setCap, clickSave, unmount };
}

const RESETS_AT = Date.UTC(2026, 0, 16, 0, 0, 0);

// --- admin editor ----------------------------------------------------------

test("plain member sees no policy editor and no admin endpoint call", async () => {
  stubFetch();
  ctx = { role: "member", policy: { enabled: false, daily_cap_vnd: null } };
  const page = mount(<MemberChatPolicySection workspaceId="ws1" />);
  await page.settle();
  try {
    expect(page.bodyText()).not.toContain("Member chat");
    expect(page.sw()).toBeNull();
    expect(calls.some((c) => c.url.includes("/member-chat-policy"))).toBeFalse();
  } finally {
    await page.unmount();
  }
});

test("admin editor loads policy and PUTs exact enabled+cap body", async () => {
  stubFetch();
  ctx = { role: "owner", policy: { enabled: false, daily_cap_vnd: null } };
  const page = mount(<MemberChatPolicySection workspaceId="ws1" />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Member chat");
    expect(page.bodyText()).toContain("Allow member chat");
    expect(page.sw()!.getAttribute("aria-checked")).toBe("false");
    expect(page.capInput()!.disabled).toBe(true);

    page.clickSwitch();
    await page.settle();
    expect(page.sw()!.getAttribute("aria-checked")).toBe("true");
    page.setCap("50000");
    page.clickSave();
    await page.settle();
    expect(ctx.putBody).toEqual({ enabled: true, daily_cap_vnd: 50000 });
  } finally {
    await page.unmount();
  }
});

test("enabling without a positive integer cap blocks the PUT with inline error", async () => {
  stubFetch();
  ctx = { role: "admin", policy: { enabled: false, daily_cap_vnd: null } };
  const page = mount(<MemberChatPolicySection workspaceId="ws1" />);
  await page.settle();
  try {
    page.clickSwitch();
    await page.settle();
    page.clickSave();
    await page.settle();
    expect(page.bodyText()).toContain("Enter a positive whole VND amount");
    expect(ctx.putBody).toBeUndefined();

    // Non-positive / non-integer input is rejected the same way.
    page.setCap("-5");
    page.clickSave();
    await page.settle();
    expect(ctx.putBody).toBeUndefined();
    page.setCap("12.5");
    page.clickSave();
    await page.settle();
    expect(ctx.putBody).toBeUndefined();

    page.setCap("1000");
    page.clickSave();
    await page.settle();
    expect(ctx.putBody).toEqual({ enabled: true, daily_cap_vnd: 1000 });
  } finally {
    await page.unmount();
  }
});

test("disabling PUTs the cap as null; save hidden while clean", async () => {
  stubFetch();
  ctx = { role: "owner", policy: { enabled: true, daily_cap_vnd: 25000 } };
  const page = mount(<MemberChatPolicySection workspaceId="ws1" />);
  await page.settle();
  try {
    expect(page.capInput()!.value).toBe("25000");
    // Nothing changed yet: no dirty PUT possible.
    const saveBefore = Array.from(page.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    )!;
    expect(saveBefore.disabled).toBe(true);

    page.clickSwitch();
    await page.settle();
    page.clickSave();
    await page.settle();
    expect(ctx.putBody).toEqual({ enabled: false, daily_cap_vnd: null });
  } finally {
    await page.unmount();
  }
});

test("server rejection shows the message inline and keeps the local controls", async () => {
  stubFetch();
  ctx = { role: "admin", policy: { enabled: false, daily_cap_vnd: null }, putStatus: 403 };
  const page = mount(<MemberChatPolicySection workspaceId="ws1" />);
  await page.settle();
  try {
    page.clickSwitch();
    await page.settle();
    page.setCap("50000");
    page.clickSave();
    await page.settle();
    expect(page.bodyText()).toContain("Admin only");
    // No silent success: the switch stays as the user set it and no fake saved
    // state is claimed (the server policy was not applied).
    expect(page.sw()!.getAttribute("aria-checked")).toBe("true");
    expect(ctx.policy.enabled).toBe(false);
  } finally {
    await page.unmount();
  }
});

// --- member read view ------------------------------------------------------

test("member read view: chat blocked asks an admin, no controls", async () => {
  stubFetch();
  ctx = {
    role: "member",
    policy: { enabled: false, daily_cap_vnd: null },
    access: {
      role: "member",
      can_chat: false,
      daily_cap_vnd: null,
      used_vnd: 0,
      remaining_vnd: null,
      resets_at: RESETS_AT,
    },
  };
  const page = mount(<MemberChatAccessView workspaceId="ws1" />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Ask a workspace admin to enable member chat");
    expect(page.container.querySelectorAll("button")).toHaveLength(0);
  } finally {
    await page.unmount();
  }
});

test("member read view: can_chat shows used/cap/remaining and reset time, read-only", async () => {
  stubFetch();
  ctx = {
    role: "member",
    policy: { enabled: true, daily_cap_vnd: 200000 },
    access: {
      role: "member",
      can_chat: true,
      daily_cap_vnd: 200000,
      used_vnd: 45000,
      remaining_vnd: 155000,
      resets_at: RESETS_AT,
    },
  };
  const page = mount(<MemberChatAccessView workspaceId="ws1" />);
  await page.settle();
  try {
    const text = page.bodyText();
    expect(text).toContain("45.000 ₫");
    expect(text).toContain("200.000 ₫");
    expect(text).toContain("155.000 ₫");
    expect(text).toContain("(UTC daily)");
    expect(page.container.querySelectorAll("button")).toHaveLength(0);
  } finally {
    await page.unmount();
  }
});

test("member read view: exhausted limit shows the reset time instead of ask-admin", async () => {
  stubFetch();
  ctx = {
    role: "member",
    policy: { enabled: true, daily_cap_vnd: 100000 },
    access: {
      role: "member",
      can_chat: false,
      daily_cap_vnd: 100000,
      used_vnd: 100000,
      remaining_vnd: 0,
      resets_at: RESETS_AT,
    },
  };
  const page = mount(<MemberChatAccessView workspaceId="ws1" />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("used today's member chat limit");
    expect(page.bodyText()).not.toContain("Ask a workspace admin");
  } finally {
    await page.unmount();
  }
});
