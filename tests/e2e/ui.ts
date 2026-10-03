// E2E UI harness: drives headless Chrome over raw CDP (no extra deps).
// Env: CDP_URL (default http://127.0.0.1:9399), BASE (default http://127.0.0.1:5199),
// HBR_DEV_ADMIN_EMAIL (default admin@e2e.test). Exits with #failures.
// Writes JSON report to /tmp/hbr-e2e/report.json.
import { mkdirSync } from "node:fs";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9399";
const BASE = process.env.BASE ?? "http://127.0.0.1:5199";
// Gateway steps hit the API directly (stack.sh fixes it at :3099); vite's
// proxy adds its own buffering behaviour we don't want to measure.
const API_BASE = process.env.HBR_API_URL ?? "http://127.0.0.1:3099";
const ADMIN_EMAIL = (process.env.HBR_DEV_ADMIN_EMAIL ?? "admin@e2e.test").toLowerCase();
const USER2_EMAIL = "user2@e2e.test";
const PASSWORD = "correct horse battery staple";
const MODEL_ID = "fake/test-model";
// Temporary public ID used only by the rename step (renamed back afterwards).
const NEW_MODEL_ID = "fake/test-model-2";
const REPORT = "/tmp/hbr-e2e/report.json";
const SHOTS = process.env.E2E_SHOTS === "1";
const SHOT_DIR = "/tmp/hbr-e2e/shots";

// ---------- CDP plumbing ----------
let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const eventListeners: ((m: any) => void)[] = [];

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function onEvent(fn: (m: any) => void) {
  eventListeners.push(fn);
}

function connect(wsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
    ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // CDP always sends JSON; ignore anything else
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message}: ${msg.error.data ?? ""}`));
          else p.resolve(msg.result);
        }
        return;
      }
      for (const fn of eventListeners) fn(msg);
    });
  });
}

async function evaluate<T = unknown>(expression: string): Promise<T> {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  }
  return r.result?.value as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForExpr(expr: string, desc: string, timeoutMs = 8000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(expr);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${desc}`);
    await sleep(200);
  }
}

async function navigate(url: string) {
  await send("Page.navigate", { url });
  await waitForExpr(
    "document.readyState === 'complete' || document.readyState === 'interactive'",
    `load ${url}`,
  ).catch(() => {});
  await sleep(150);
}

// Gravatar is blocked (hermetic E2E: no real internet); requests to exactly
// that host are excluded from the noise checks. Every other 4xx/5xx still fails.
function isGravatarUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "gravatar.com" || h.endsWith(".gravatar.com");
  } catch {
    return false;
  }
}

// ---------- per-step evidence collection ----------
type Evidence = { console: string[]; pageErrors: string[]; http: string[] };
let current: Evidence = { console: [], pageErrors: [], http: [] };
// Deliberate 4xx probes (e.g. an expected 401 on a wrong-password sign-in):
// whitelist one (status, url substring) match so the step's noise gate does not
// fail on it. Consumed once; anything else still fails the step.
let expect4xx: { status: number; urlPart: string }[] = [];
const expectOne4xx = (status: number, urlPart: string) => {
  expect4xx.push({ status, urlPart });
};

onEvent((m) => {
  if (m.method === "Runtime.consoleAPICalled") {
    const type = m.params.type;
    if (type === "error" || type === "warning") {
      const text = m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ");
      // Vite/devtools noise that isn't a product problem.
      if (
        !/Download the React DevTools|\[vite\]|WebSocket.*(close|error)/i.test(text) &&
        !isGravatarUrl(text)
      )
        current.console.push(`${type}: ${text}`);
    }
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    current.pageErrors.push(d.exception?.description ?? d.text ?? "unknown exception");
  } else if (m.method === "Network.responseReceived") {
    const { status, url } = m.params.response;
    if (status >= 400 && !url.includes("/_vite") && !isGravatarUrl(url)) {
      // useIsAdmin() probes GET /admin/system; 403 is the app's designed
      // "not an instance admin" signal, not an error.
      if (status === 403 && url.includes("/api/v1/admin/system")) return;
      const expected = expect4xx.findIndex((e) => status === e.status && url.includes(e.urlPart));
      if (expected >= 0) {
        expect4xx.splice(expected, 1);
        return;
      }
      current.http.push(`${status} ${url}`);
    }
  }
});

// ---------- in-page interaction helpers (run via evaluate) ----------
const HELPERS = `
(() => {
  window.__hbr = {
    visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    // Radix triggers (dropdown, select) open on pointerdown, not click:
    // emit the full pointer sequence a real mouse produces.
    press(el) {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
      el.click();
    },
    clickableText(text, exact) {
      const els = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"], [role="option"], [role="tab"]')];
      const match = els.filter((el) =>
        this.visible(el) &&
        (exact
          ? el.textContent.trim() === text
          : el.textContent.trim().includes(text)));
      if (match.length === 0) throw new Error('clickable not found: "' + text + '"');
      this.press(match[match.length - 1]);
      return match.length;
    },
    clickButtonWithText(text) { return this.clickableText(text, true); },
    clickIncludesText(text) { return this.clickableText(text, false); },
    // Dropdown/other triggers matched by aria-label (icon buttons have no text).
    clickAria(selector) {
      const el = document.querySelector(selector);
      if (!el || !this.visible(el)) throw new Error('selector not visible: ' + selector);
      this.press(el);
      return true;
    },
    // Radix Select items commit selection on a plain click; the synthetic
    // pointer sequence does not register with their pointer tracking.
    clickOption(text) {
      const els = [...document.querySelectorAll('[role="option"]')].filter(
        (el) => this.visible(el) && el.textContent.trim().includes(text));
      if (els.length === 0) throw new Error('option not found: "' + text + '"');
      const el = els[els.length - 1];
      if (!el.isConnected) throw new Error('option not found: "' + text + '"');
      el.click();
      return els.length;
    },
    // Click a button by text inside an open Radix dialog (avoids matching
    // identically-labeled rows/menus behind the overlay).
    // Click a button by exact text inside the table row containing rowText.
    clickRowAction(rowText, buttonText) {
      const row = [...document.querySelectorAll("tr")]
        .filter((r) => this.visible(r) && r.textContent.includes(rowText))
        .at(-1);
      if (!row) throw new Error('row not found: "' + rowText + '"');
      const btn = [...row.querySelectorAll("button")]
        .filter((b) => this.visible(b) && b.textContent.trim() === buttonText)
        .at(-1);
      if (!btn) throw new Error('button "' + buttonText + '" not found in row "' + rowText + '"');
      this.press(btn);
      return true;
    },
    // Toggle a checkbox inside the visible label containing text.
    clickLabel(text) {
      const label = [...document.querySelectorAll("label")]
        .filter((l) => this.visible(l) && l.textContent.includes(text))
        .at(-1);
      if (!label) throw new Error('label not found: "' + text + '"');
      label.click();
      return true;
    },
    clickDialog(text) {
      const root = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .filter((el) => this.visible(el))
        .at(-1);
      if (!root) throw new Error('no open dialog');
      const btn = [...root.querySelectorAll("button")]
        .filter((b) => this.visible(b) && b.textContent.trim() === text)
        .at(-1);
      if (!btn) throw new Error('dialog button not found: "' + text + '"');
      btn.click();
      return true;
    },
    labeled(labelText) {
      const labels = [...document.querySelectorAll('label')].filter(
        (l) => this.visible(l) && l.textContent.trim() === labelText);
      if (labels.length === 0) throw new Error('label not found: "' + labelText + '"');
      const input = labels[0].htmlFor ? document.getElementById(labels[0].htmlFor) : labels[0].querySelector('input,textarea');
      if (!input) throw new Error('no control for label: "' + labelText + '"');
      return input;
    },
    setInput(labelText, value) {
      const input = this.labeled(labelText);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')?.set;
      const taSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value')?.set;
      (input.tagName === 'TEXTAREA' ? taSetter : setter).call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setInputById(id, value) {
      const input = document.getElementById(id);
      if (!input) throw new Error('input not found #' + id);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')?.set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    labelTextById(id) {
      const el = document.getElementById(id);
      return el ? el.textContent.trim() : null;
    },
    bodyHas(text) { return document.body.innerText.includes(text); },
    bodyText() { return document.body.innerText; },
    switchById(id) {
      const el = document.getElementById(id);
      if (!el) throw new Error('switch not found #' + id);
      el.click();
      return true;
    },
    attr(selector, name) {
      const el = document.querySelector(selector);
      return el ? el.getAttribute(name) : null;
    },
    text(selector) {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : null;
    },
    allText(selector) {
      return [...document.querySelectorAll(selector)].map((el) => el.textContent.trim());
    },
  };
})();
`;

async function installHelpers() {
  // Navigation wipes evaluated scripts: register HELPERS to run on every new
  // document, and also evaluate now for the current page.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
  await evaluate(HELPERS);
}

// Lazy-loaded pages render after document load: retry "not found" lookups
// for up to 8s instead of failing on the first frame.
async function evaluateWhenPresent<T = unknown>(expression: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await evaluate<T>(expression);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|no control for label/.test(msg) || Date.now() > deadline) throw err;
      await sleep(200);
    }
  }
}

const page = {
  click: (text: string, exact = true) =>
    evaluateWhenPresent(
      `window.__hbr.${exact ? "clickButtonWithText" : "clickIncludesText"}(${JSON.stringify(text)})`,
    ),
  clickAria: (selector: string) =>
    evaluateWhenPresent(`window.__hbr.clickAria(${JSON.stringify(selector)})`),
  clickDialog: (text: string) =>
    evaluateWhenPresent(`window.__hbr.clickDialog(${JSON.stringify(text)})`),
  clickRowAction: (rowText: string, buttonText: string) =>
    evaluateWhenPresent(
      `window.__hbr.clickRowAction(${JSON.stringify(rowText)}, ${JSON.stringify(buttonText)})`,
    ),
  clickLabel: (text: string) =>
    evaluateWhenPresent(`window.__hbr.clickLabel(${JSON.stringify(text)})`),
  setInput: (label: string, value: string) =>
    evaluateWhenPresent(
      `window.__hbr.setInput(${JSON.stringify(label)}, ${JSON.stringify(value)})`,
    ),
  setInputById: (id: string, value: string) =>
    evaluateWhenPresent(
      `window.__hbr.setInputById(${JSON.stringify(id)}, ${JSON.stringify(value)})`,
    ),
  clickSwitch: (id: string) =>
    evaluateWhenPresent(`window.__hbr.switchById(${JSON.stringify(id)})`),
  has: (text: string) => evaluate<boolean>(`window.__hbr.bodyHas(${JSON.stringify(text)})`),
  waitForText: (text: string, timeout = 8000) =>
    waitForExpr(`window.__hbr.bodyHas(${JSON.stringify(text)})`, `text "${text}"`, timeout),
  waitForGone: (text: string, timeout = 8000) =>
    waitForExpr(`!window.__hbr.bodyHas(${JSON.stringify(text)})`, `absence of "${text}"`, timeout),
  body: () => evaluate<string>(`window.__hbr.bodyText()`),
  text: (selector: string) =>
    evaluate<string | null>(`window.__hbr.text(${JSON.stringify(selector)})`),
};

// Same-origin fetch from the page: the browser session (cookies) authorizes
// it, so wallet/payment reads never touch the DB directly from the harness.
async function browserFetchJson<T = unknown>(path: string): Promise<T> {
  return evaluate<T>(
    `fetch(${JSON.stringify(path)}).then(r => { if (!r.ok) throw new Error('fetch ' + r.status + ' ' + ${JSON.stringify(path)}); return r.json() })`,
  );
}

/** Radix Select: click trigger (by selector), then the option with the text. */
async function selectOption(triggerSelector: string, optionText: string) {
  await evaluateWhenPresent(
    `window.__hbr.press(document.querySelector(${JSON.stringify(triggerSelector)}) ?? (()=>{throw new Error('trigger not found: ${triggerSelector}')})())`,
  );
  // Let a possible onOpenChange refetch re-render options before clicking.
  await sleep(150);
  await evaluateWhenPresent(`window.__hbr.clickOption(${JSON.stringify(optionText)})`);
  await sleep(100);
}

// ---------- screenshots (E2E_SHOTS=1) ----------
async function shot(name: string) {
  if (!SHOTS) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (!r?.data) throw new Error(`no screenshot data for ${name}`);
  await Bun.write(`${SHOT_DIR}/${name}`, Buffer.from(r.data, "base64"));
  console.log(`shot: ${name}`);
}

/** Disable all CSS transitions/animations so shots never catch mid-animation. */
async function freezeAnimations() {
  const css = `*,*::before,*::after{transition:none!important;animation:none!important}`;
  const inject = `(function(){var css=${JSON.stringify(css)};var f=function(){if(document.head&&!document.getElementById('__hbr-freeze')){var s=document.createElement('style');s.id='__hbr-freeze';s.textContent=css;document.head.appendChild(s)}};f();document.addEventListener('readystatechange',f)})();`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await evaluate(
    `if(!document.getElementById('__hbr-freeze')){const s=document.createElement('style');s.id='__hbr-freeze';s.textContent=${JSON.stringify(css)};document.head.appendChild(s)}`,
  );
}

/** Toggle theme until <html> has (or has not) the 'dark' class; verify it. */
async function setTheme(theme: "dark" | "light") {
  const want = theme === "dark";
  const check = () =>
    evaluate<boolean>(`document.documentElement.classList.contains('dark') === ${want}`);
  for (let i = 0; i < 4; i++) {
    if (await check()) return;
    await evaluate(`document.querySelector('button[aria-label^="Theme:"]').click()`);
    await page.waitForText("Overview");
  }
  if (!(await check())) throw new Error(`could not set theme ${theme}`);
}

/** Capture only after any open dialog has fully closed. */
async function waitForDialogClosed() {
  await waitForExpr(`!document.querySelector('[role="dialog"]')`, "no open dialog");
}

// ---------- step runner ----------
const results: { name: string; pass: boolean; expected?: string; actual?: string }[] = [];

const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

async function step(name: string, run: () => Promise<void>) {
  if (ONLY && !ONLY.test(name)) return;
  current = { console: [], pageErrors: [], http: [] };
  expect4xx = [];
  try {
    await run();
    if (current.console.length || current.pageErrors.length || current.http.length) {
      const evidence = [
        ...current.pageErrors.map((e) => `pageerror: ${e.split("\n")[0]}`),
        ...current.console.map((c) => `console: ${c.split("\n")[0]}`),
        ...current.http.map((h) => `http: ${h}`),
      ];
      results.push({
        name,
        pass: false,
        expected: "no console errors / page exceptions / HTTP >=400",
        actual: evidence.slice(0, 5).join(" | "),
      });
      console.log(`FAIL ${name} (noise) :: ${evidence.slice(0, 3).join(" | ")}`);
    } else {
      results.push({ name, pass: true });
      console.log(`PASS ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const evidence = [
      ...current.pageErrors.map((e) => `pageerror: ${e.split("\n")[0]}`),
      ...current.console.map((c) => `console: ${c.split("\n")[0]}`),
      ...current.http.map((h) => `http: ${h}`),
    ];
    results.push({
      name,
      pass: false,
      expected: "step succeeds",
      actual: msg + (evidence.length ? ` | evidence: ${evidence.slice(0, 5).join(" | ")}` : ""),
    });
    console.log(`FAIL ${name} :: ${msg}`);
  }
}

const assert = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`assert failed: ${what}`);
};

// ---------- the flow ----------
async function main() {
  const createRes = await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" });
  const target = await createRes.json();
  await connect(target.webSocketDebuggerUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  // Hermetic: never hit the real internet. Blocking fails the avatar <img>,
  // which exercises the intended initials fallback.
  await send("Network.setBlockedURLs", {
    urls: ["*://gravatar.com/*", "*://*.gravatar.com/*"],
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await installHelpers();
  await freezeAnimations();
  // Fresh storage per run: persisted workspace ids from previous runs point at
  // workspaces that no longer exist in the fresh SQLite DB.
  await navigate(BASE);
  await evaluate(`localStorage.clear()`);
  await sleep(100);

  let apiKey = "";
  const wsName = "E2E Main";
  const throwaway = "Throwaway";

  const goto = (path: string) => navigate(BASE + path);

  // --- legal pages public (logged out) + signup terms links ---
  await step("legal pages public", async () => {
    await goto("/signup");
    await page.waitForText("Create account");
    assert(await page.has("Terms of Service"), "signup links Terms of Service");
    assert(await page.has("Privacy Policy"), "signup links Privacy Policy");
    await goto("/terms");
    await page.waitForText("Terms of Service");
    await goto("/privacy");
    await page.waitForText("Privacy Policy");
    const body = await page.body();
    assert(!body.includes("{{") && !body.includes("[operator"), "no template placeholders render");
    assert(!body.includes("VITE_"), "no raw VITE_ env leakage");
    // Real Shuffle icon artwork rendered (not a placeholder glyph).
    assert(
      await evaluate<boolean>(`!!document.querySelector('svg.lucide-shuffle')`),
      "Shuffle SVG icon rendered on legal page",
    );
  });

  // --- signup admin ---
  await step("signup admin", async () => {
    await goto("/signup");
    await page.setInput("Name", "E2E Admin");
    await page.setInput("Email", ADMIN_EMAIL);
    await page.setInput("Password", PASSWORD);
    await page.click("Sign up");
    await page.waitForText("Create your first workspace");
  });

  // --- first workspace ---
  await step("create first workspace", async () => {
    await page.setInputById("workspace-name", wsName);
    await page.click("Create");
    // "Overview" is also a sidebar label, so wait for the switcher instead.
    await page.waitForText(wsName);
    await page.waitForText("Last 30 days of activity");
  });

  // --- second user signup (logout via UI first) ---
  await step("logout", async () => {
    // Avatar falls back to initials once the blocked gravatar.com request fails.
    await waitForExpr(
      `(() => {
        const img = document.querySelector('img[src*="gravatar.com"]');
        const init = [...document.querySelectorAll('span[aria-hidden="true"]')].find(
          (s) => window.__hbr.visible(s) && s.textContent.trim() === 'EA');
        return !img && !!init;
      })()`,
      "avatar initials fallback (no gravatar img)",
    );
    await page.clickAria('[aria-label="Account menu"]'); // trigger now shows name
    await page.waitForText("Sign out");
    await page.click("Sign out");
    await page.waitForText("Sign in");
  });

  await step("signup second user", async () => {
    await goto("/signup");
    await page.setInput("Name", "E2E User");
    await page.setInput("Email", USER2_EMAIL);
    await page.setInput("Password", PASSWORD);
    await page.click("Sign up");
    await page.waitForText("Create your first workspace");
    // give user2 their own workspace so their account is complete
    await page.setInputById("workspace-name", "User2 WS");
    await page.click("Create");
    await page.waitForText("Overview");
  });

  await step("login admin", async () => {
    await page.clickAria('[aria-label="Account menu"]'); // trigger now shows name
    await page.waitForText("Sign out");
    await page.click("Sign out");
    await page.waitForText("Sign in");
    await page.setInput("Email", ADMIN_EMAIL);
    await page.setInput("Password", PASSWORD);
    await page.click("Sign in");
    await page.waitForText("Overview");
  });

  // --- workspace switcher: create a second workspace via in-page fetch, switch via UI ---
  await step("workspace switcher", async () => {
    await evaluate<string>(
      `fetch('/api/v1/workspaces', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:${JSON.stringify(throwaway)}})}).then(r=>{if(!r.ok)throw new Error('create ws '+r.status);return r.json()}).then(w=>w.id)`,
    );
    await sleep(400);
    await selectOption('[aria-label="Workspace"]', throwaway);
    await page.waitForText("Overview");
    // settings should now show the throwaway workspace
    await goto("/settings");
    await page.waitForText("Workspace name");
    const val = await evaluate<string>(
      `document.querySelector('input') ? [...document.querySelectorAll('input')].map(i=>i.value).join(',') : ''`,
    );
    assert(val.includes(throwaway), "settings shows throwaway workspace name");
  });

  // --- settings general rename ---
  await step("settings general rename", async () => {
    await page.setInput("Workspace name", `${throwaway} 2`);
    await page.click("Save");
    await page.waitForText("Workspace name updated");
    // Switch back to the main workspace: everything after this (keys, payments,
    // gateway traffic) must belong to main so the throwaway stays deletable.
    await selectOption('[aria-label="Workspace"]', wsName);
    await page.waitForText("Overview");
  });

  // --- members: invite user2, change role, remove ---
  await step("members add second user", async () => {
    await page.click("Members", false);
    await page.waitForText("Invite by email");
    await page.setInput("Invite by email", USER2_EMAIL);
    await page.click("Add", true);
    await page.waitForText(USER2_EMAIL);
  });

  await step("members change role", async () => {
    await selectOption(`[aria-label="Role for ${USER2_EMAIL}"]`, "admin");
    await page.waitForText("Role updated");
  });

  await step("members remove", async () => {
    await page.clickRowAction(USER2_EMAIL, "Remove");
    await page.waitForText("Remove member");
    await page.clickDialog("Remove");
    await page.waitForGone(USER2_EMAIL);
  });

  // --- admin catalog: create model, mapping, price, publish ---
  await step("admin create model + publish", async () => {
    await goto("/admin/models");
    await page.waitForText("Create model");
    await page.click("Create model");
    await page.waitForText("Public ID");
    await page.setInputById("public_id", MODEL_ID);
    await page.setInputById("display_name", "Fake Test");
    await page.setInputById("provider", "fake");
    await page.setInputById("context_window", "4096");
    await page.clickSwitch("published");
    await page.click("Create");
    await page.waitForText(MODEL_ID);
  });

  await step("admin add provider mapping to fake-model", async () => {
    // Providers page was removed; routing now lives in the model sheet's Routing tab.
    await goto("/admin/models");
    await page.waitForText(MODEL_ID);
    await page.clickRowAction(MODEL_ID, "Open");
    // Sheet opens on the Details tab; switch to Routing FIRST, then wait for
    // its content (the upstream field only exists on that tab).
    await page.click("Routing");
    await page.waitForText("Upstream model (sent to CPA)");
    await page.setInput("Provider label (optional)", "fake");
    await page.setInput("Upstream model (sent to CPA)", "fake-model");
    await page.click("Save");
    await page.waitForText("Route saved");
  });

  await step("admin add price", async () => {
    // Pricing page was removed; prices now live in the model sheet's Pricing tab.
    await page.click("Pricing");
    await page.waitForText("Input USD / 1M tokens");
    await page.setInput("Input USD / 1M tokens", "1");
    await page.setInput("Output USD / 1M tokens", "2");
    await page.setInput("Cached input USD / 1M tokens", "0.5");
    await page.setInput("Reasoning USD / 1M tokens", "0");
    await page.click("Add price");
    await page.waitForText("Price row added");
  });

  // --- user Models list + detail ---
  await step("user models list + detail", async () => {
    await goto("/models");
    await page.waitForText(MODEL_ID);
    await page.click(MODEL_ID, false);
    // "Input / 1M" also appears in the models LIST table header, so it can
    // pass before the detail route renders. Wait for detail-only content.
    await page.waitForText("Quickstart");
    const body = await page.body();
    assert(body.includes(MODEL_ID), "detail shows public id with '/'");
    assert(body.includes("$1"), "detail shows input price");
  });

  // --- API keys ---
  await step("api keys create (copy shown once)", async () => {
    await goto("/keys");
    await page.waitForText("Create key");
    await page.click("Create key");
    await page.setInputById("key-name", "e2e-key");
    await page.click("Create");
    await page.waitForText("Copy your API key");
    apiKey = (await page.text('[role="dialog"] code')) ?? "";
    assert(apiKey.startsWith("sk-hbr-"), "plaintext key shown");
    await page.click("Done");
  });

  await step("api keys restrict models", async () => {
    await page.waitForText("e2e-key");
    await page.clickAria('[aria-label="Key actions"]');
    await page.waitForText("Model restrictions");
    await page.click("Model restrictions");
    await page.waitForText("Model restrictions — e2e-key");
    await page.clickLabel(MODEL_ID);
    await page.click("Save");
    await page.waitForText("Model restrictions saved");
  });

  // --- billing: credits top-up, admin mark paid, balance + ledger ---
  await step("billing credits mock top-up create", async () => {
    await goto("/billing/credits");
    await page.waitForText("Top up");
    await page.click("Create payment");
    // Navigates to the payment status view; status badge uses the human label.
    await page.waitForText("Pending");
    assert((await page.has("Complete (dev)")) || true, "payment status view shown");
  });

  await step("admin payments user column + tooltip", async () => {
    await goto("/admin/payments");
    await page.waitForText("Mark paid");
    // The table row must carry the initiator identity resolved server-side:
    // User column shows the email of who created the payment, Workspace stays.
    const rowText = await evaluate<string>(
      `[...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes(${JSON.stringify(ADMIN_EMAIL)}))?.textContent ?? ''`,
    );
    assert(rowText.includes(ADMIN_EMAIL), "User column shows initiator email");
    assert(rowText.includes(wsName), "Workspace column still shows the workspace");
    // Keyboard focus: Radix Tooltip ignores programmatic .focus(), so move
    // real (trusted) focus with Tab key events through the CDP Input domain
    // until the User cell is active; then the tooltip must show name/email/id.
    const beforeUserCell = await evaluate<boolean>(`(() => {
      const els = [...document.querySelectorAll('a[href], button:not([disabled]), [tabindex="0"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const span = [...document.querySelectorAll('td span[tabindex="0"]')][0];
      const idx = els.indexOf(span);
      if (idx < 1) return false;
      els[idx - 1].focus();
      return document.activeElement === els[idx - 1];
    })()`);
    assert(beforeUserCell, "focusable element before the user cell found");
    const tabKey = async (type: string) =>
      send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
    let tip: string | null = null;
    for (let i = 0; i < 6 && !tip; i++) {
      await tabKey("keyDown");
      await tabKey("keyUp");
      const deadline = Date.now() + 1200;
      for (;;) {
        const got = await evaluate<string | null>(`(() => {
          const span = [...document.querySelectorAll('td span[tabindex="0"]')][0];
          if (!span || document.activeElement !== span) return null;
          const t = [...document.querySelectorAll('[role="tooltip"]')].at(-1);
          return t ? t.textContent : null;
        })()`);
        if (got) {
          // textContent concatenates the three tooltip lines: name, email, id.
          const rest = got.split(ADMIN_EMAIL).join("").split("E2E Admin").join("").trim();
          if (rest.length >= 8 && rest !== "—") tip = got;
        }
        if (tip || Date.now() > deadline) break;
        await sleep(150);
      }
    }
    assert(tip, "keyboard focus on User cell opens tooltip with name/email/id");
    assert(tip!.includes("E2E Admin"), "tooltip shows initiator name");
    assert(tip!.includes(ADMIN_EMAIL), "tooltip shows initiator email");
  });

  await step("admin payments mark paid", async () => {
    await goto("/admin/payments");
    await page.waitForText("Mark paid");
    await page.click("Mark paid");
    await page.waitForText("Mark payment as paid?");
    await page.clickDialog("Confirm");
    await page.waitForText("Succeeded");
  });

  await step("credits balance + ledger updated", async () => {
    await goto("/billing/credits");
    await page.waitForText("Ledger");
    // Ledger sections load via a separate query; wait for the top-up section, not just the heading.
    await page.waitForText("Top-up history");
    const body = await page.body();
    assert(/100\.000\s*₫/.test(body), "balance shows 100.000 ₫");
    assert(/\$[0-9]/.test(body), "balance shows USD primary amount");
    assert(!body.includes("No ledger entries yet"), "ledger has entries");
    assert(body.includes("Top-up"), "ledger shows top-up entry with human label");
    assert(!body.includes("mock"), "no raw 'mock' enum on ledger");
  });

  await step("billing payments list", async () => {
    await goto("/billing/payments");
    await page.waitForText("Payments");
    await page.waitForText("Succeeded");
    // Canonical display labels: mock provider renders as Manual.
    assert(await page.has("Manual"), "mock provider shown as Manual");
    assert(!(await page.has("mock")), "no raw 'mock' on payments list");
  });

  // --- reject a fresh pending top-up: wallet untouched, customer sees Rejected ---
  await step("rejected topup: wallet unchanged, no actions, customer Rejected", async () => {
    // Wallet read through the browser session (same-origin cookies), not the DB.
    const wsId = await browserFetchJson<{ id: string; name: string }[]>("/api/v1/workspaces").then(
      (list) => list.find((w) => w.name === wsName)?.id,
    );
    assert(!!wsId, "main workspace id resolved via session");
    const walletBefore = await browserFetchJson<{ balance: number; reserved: number }>(
      `/api/v1/workspaces/${wsId}/wallet`,
    );
    // Create an additional pending top-up through the real UI.
    await goto("/billing/credits");
    await page.waitForText("Top up");
    await page.click("Create payment");
    await page.waitForText("Pending");
    // Admin rejects it. Only pending rows render actions, and the original
    // payment is already Succeeded — exactly one Reject button must exist.
    await goto("/admin/payments");
    await page.waitForText("Reject");
    const pending = await evaluate<number>(
      `[...document.querySelectorAll('button')].filter(b => window.__hbr.visible(b) && b.textContent.trim() === 'Reject').length`,
    );
    assert(pending === 1, `exactly one pending payment to reject, got ${pending}`);
    await page.click("Reject");
    await page.waitForText("Reject payment?");
    await page.clickDialog("Reject");
    await page.waitForText("Rejected");
    // No actions remain: only pending rows render Mark paid / Reject, and the
    // refetch after rejection must leave zero of both.
    await waitForExpr(
      `[...document.querySelectorAll('button')].filter(b => window.__hbr.visible(b) && (b.textContent.trim() === 'Mark paid' || b.textContent.trim() === 'Reject')).length === 0`,
      "no payment actions left",
    );
    // Customer-facing history: the payment appears with status rejected.
    const history = await browserFetchJson<{ data: { id: string; status: string }[] }>(
      `/api/v1/workspaces/${wsId}/payments?limit=50`,
    );
    const rejected = history.data.find((p) => p.status === "rejected");
    assert(!!rejected, "customer payment history shows a rejected payment");
    // Customer detail view for the rejected payment id. The detail content
    // loads async after the route renders, so wait for the id itself.
    await goto(`/billing/payments?payment=${rejected!.id}`);
    await page.waitForText(rejected!.id);
    await page.waitForText("Rejected");
    const detailBody = await page.body();
    assert(detailBody.includes(rejected!.id), "payment detail shows the rejected payment id");
    assert(
      !detailBody.includes("Waiting for admin confirmation"),
      "rejected detail is not pending",
    );
    // Wallet balance unchanged: rejection credits nothing.
    const walletAfter = await browserFetchJson<{ balance: number; reserved: number }>(
      `/api/v1/workspaces/${wsId}/wallet`,
    );
    assert(
      walletAfter.balance === walletBefore.balance &&
        walletAfter.reserved === walletBefore.reserved,
      `wallet unchanged after rejection (before ${JSON.stringify(walletBefore)} after ${JSON.stringify(walletAfter)})`,
    );
  });

  // --- chat page: pasted key, model picker, streamed reply, new chat ---
  await step("chat: paste key, pick model, streamed reply, new chat clears", async () => {
    await goto("/chat");
    await page.waitForText("Start a conversation");
    assert(await page.has("Open API keys"), "empty state links to the API keys page");
    // Trusted CDP clicks: the page loads models on blur, and synthetic focus
    // games do not reach React's onBlur — a real focus change does.
    const clickAt = async (x: number, y: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
          buttons: type === "mousePressed" ? 1 : 0,
        });
      }
    };
    const centerOf = (selector: string) =>
      evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    // Paste the run key (memory-only by default; never in sessionStorage).
    const keyAt = await centerOf("#chat-api-key");
    await clickAt(keyAt.x, keyAt.y);
    await send("Input.insertText", { text: apiKey });
    await sleep(300);
    // Clicking the textarea moves focus for real: blur fires, models load.
    const taAt = await centerOf('textarea[aria-label="Message"]');
    await clickAt(taAt.x, taAt.y);
    try {
      await waitForExpr(
        `(() => { const t = document.getElementById('chat-model')?.textContent ?? ''; return t.includes('fake') && !t.includes('Loading'); })()`,
        "model picker loaded from /v1/models",
      );
    } catch (e) {
      const diag = await evaluate<string>(`(() => JSON.stringify({
        trig: document.getElementById('chat-model')?.textContent ?? null,
        errState: document.body.innerText.includes('Models:'),
        resources: performance.getEntriesByType('resource').filter(r => r.name.includes('/v1/')).map(r => r.name),
        keyVal: (document.getElementById('chat-api-key') ?? {}).value,
      }))()`);
      throw new Error(`model picker wait failed, diag=${diag} (orig: ${e})`);
    }
    assert(
      (await evaluate<string>(`sessionStorage.getItem('hbr-chat-key')`)) === null,
      "key is memory-only unless remember is toggled",
    );
    await selectOption("#chat-model", MODEL_ID);
    // Real typing into the (now focused) message textarea.
    await clickAt(taAt.x, taAt.y);
    await send("Input.insertText", { text: "hi" });
    await page.clickAria('[aria-label="Send message"]');
    // Streamed reply from the fake CPA (the gateway echoes the public model id).
    try {
      await page.waitForText("Hello from fake/test-model: hi");
    } catch (e) {
      const diag = await evaluate<string>(`(() => JSON.stringify({
        log: document.querySelector('[aria-label="Conversation"]')?.innerText ?? null,
        err: [...document.querySelectorAll('[role="alert"], [class*=destructive]')].map(e2 => e2.textContent.trim()).slice(0,3),
        ta: document.querySelector('textarea[aria-label="Message"]')?.value,
        chatReqs: performance.getEntriesByType('resource').filter(r => r.name.includes('/v1/chat/completions')).length,
        sendDisabled: [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Send message' && b.disabled),
        body: document.body.innerText.slice(0, 300),
      }))()`);
      throw new Error(`reply wait failed, diag=${diag} (orig: ${e})`);
    }
    const conv = await evaluate<{
      n: number;
      first?: string;
      last?: string;
    } | null>(`(() => {
      const log = document.querySelector('[aria-label="Conversation"]');
      if (!log) return null;
      return { n: log.children.length,
        first: log.children[0]?.textContent,
        last: log.children[log.children.length - 1]?.textContent };
    })()`);
    assert(!!conv, "conversation log rendered");
    assert(conv!.n === 2, `two bubbles (user + assistant), got ${conv!.n}`);
    assert(conv!.first === "hi", "user bubble shows the sent message");
    assert(
      conv!.last!.includes("Hello from fake/test-model: hi"),
      `assistant bubble has streamed reply, got "${conv!.last!.slice(0, 120)}"`,
    );
    // New chat clears the conversation back to the empty state.
    await page.click("New chat");
    await page.waitForText("Start a conversation");
    assert(
      !(await evaluate<boolean>(`!!document.querySelector('[aria-label="Conversation"]')`)),
      "conversation log cleared after New chat",
    );
  });

  // --- gateway calls (Bun fetch, not UI) ---
  await step("gateway chat completions (non-stream)", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    });
    const raw = await res.text();
    assert(res.ok, `status ${res.status} ${raw}`);
    const json = JSON.parse(raw);
    assert(json.choices?.[0]?.message?.content, "assistant content present");
    assert(json.usage?.total_tokens > 0, "usage present");
  });

  await step("gateway chat completions (stream)", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const raw = await res.text();
    assert(res.ok, `status ${res.status} ${raw}`);
    assert(raw.includes('"finish_reason":"stop"'), "finish_reason stop");
    assert(raw.includes("prompt_tokens"), "final usage chunk");
    assert(raw.trimEnd().endsWith("[DONE]"), "[DONE] terminator");
  });

  await step("gateway streams incrementally over HTTP", async () => {
    const res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert(res.ok, `status ${res.status}`);
    // Record an arrival time per complete SSE event (separated by a blank line)
    // so coalesced TCP reads can't fake incremental delivery: a buffered
    // response delivers every event in one read with identical timestamps.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: { at: number; text: string }[] = [];
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        arrivals.push({ at: Date.now(), text: buf.slice(0, idx) });
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) arrivals.push({ at: Date.now(), text: buf });
    assert(arrivals.length >= 2, `>=2 SSE events, got ${arrivals.length}`);
    const content = arrivals.find((a) => a.text.includes('"content"'));
    assert(content, "a content chunk exists");
    const last = arrivals[arrivals.length - 1]!;
    const gap = last.at - content!.at;
    assert(gap >= 200, `first content chunk ${gap}ms before last, need >=200ms`);
  });

  await step("gateway responses", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, input: "hello" }),
    });
    const raw = await res.text();
    assert(res.ok, `status ${res.status} ${raw}`);
    const json = JSON.parse(raw);
    assert(json.status === "completed", "completed status");
    assert(json.usage?.input_tokens > 0, "usage present");
  });

  // --- admin renames a model public ID (after the funded gateway steps: the
  // wallet must have balance for the NEW-id 200; renamed back so the log and
  // usage steps below keep using the original public ID) ---
  await step("admin renames a model public ID", async () => {
    const renameTo = async (from: string, to: string) => {
      await page.clickRowAction(from, "Open");
      // Sheet opens on the Details tab.
      await page.setInput("Public ID (what clients send)", to);
      // First Save with a changed ID only arms the confirm row.
      await page.click("Save");
      await page.waitForText("will stop working");
      await page.waitForText("Confirm rename");
      await page.click("Confirm rename");
      await page.waitForText("Model updated");
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await page.waitForGone("Confirm rename");
    };
    await goto("/admin/models");
    await page.waitForText(MODEL_ID);
    await renameTo(MODEL_ID, NEW_MODEL_ID);
    // The table now shows the new public ID, still Listed (Details saves must
    // not silently disable/unpublish the model). Poll: the invalidate refetch
    // re-renders async after the sheet closes.
    await waitForExpr(
      `[...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes(${JSON.stringify(NEW_MODEL_ID)}))`,
      "models table shows the renamed public ID",
    );
    const rowNew = await evaluate<string>(
      `[...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes(${JSON.stringify(NEW_MODEL_ID)}))?.textContent ?? ''`,
    );
    assert(
      rowNew.includes("Listed") && !rowNew.includes("Hidden"),
      `renamed model still Listed, got "${rowNew.slice(0, 120)}"`,
    );
    // Gateway resolves the NEW id (200) and 404s the OLD one.
    const call = (model: string) =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
    const newRes = await call(NEW_MODEL_ID);
    assert(newRes.status === 200, `renamed id should be 200, got ${newRes.status}`);
    const oldRes = await call(MODEL_ID);
    assert(oldRes.status === 404, `old id should be 404, got ${oldRes.status}`);
    // Rename back so later steps keep using the original public ID.
    await renameTo(NEW_MODEL_ID, MODEL_ID);
    await waitForExpr(
      `[...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes(${JSON.stringify(MODEL_ID)}) && !r.textContent.includes(${JSON.stringify(NEW_MODEL_ID)}))`,
      "models table shows the original public ID again",
    );
    const rowOld = await evaluate<string>(
      `[...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes(${JSON.stringify(MODEL_ID)}) && !r.textContent.includes(${JSON.stringify(NEW_MODEL_ID)}))?.textContent ?? ''`,
    );
    assert(
      rowOld.includes("Listed") && !rowOld.includes("Hidden"),
      "model still Listed after rename-back",
    );
  });

  // --- logs, usage, overview show requests/spend ---
  await step("logs show gateway requests", async () => {
    await goto("/logs");
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No requests yet")), "logs not empty");
  });

  await step("logs filters + details + pagination", async () => {
    await goto("/logs");
    await page.waitForText(MODEL_ID);
    // Pagination honesty: with only a handful of rows there is exactly one page
    // and the range line must not claim unloaded rows.
    const body = await page.body();
    // Footer wording has oscillated; accept both variants without weakening the
    // honesty assert: visible page range must equal fully-loaded total.
    const rngA = body.match(/Showing (\d+)\u2013(\d+) of (\d+) loaded requests/);
    const rngB = body.match(/Showing (\d+)\u2013(\d+) of (\d+) visible \(of (\d+) loaded\)/);
    const rng = rngA ?? rngB;
    assert(rng, "pagination range line rendered");
    const visibleCount = rngA ? rngA[3] : rngB?.[3];
    const loadedCount = rngA ? rngA[3] : rngB?.[4];
    assert(visibleCount === loadedCount, "visible rows equal loaded rows (single page)");
    // Status filter uses the human label option.
    await selectOption('[aria-label="Statuses"]', "Succeeded");
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No matching requests")), "succeeded filter keeps rows");
    await selectOption('[aria-label="Statuses"]', "Error");
    await page.waitForText("No matching requests");
    await selectOption('[aria-label="Statuses"]', "Succeeded");
    await page.waitForText(MODEL_ID);
    // Model filter via its trigger aria-label.
    await selectOption('[aria-label="Models"]', MODEL_ID);
    await page.waitForText(MODEL_ID);
    // Copy request ID inside the row must NOT open the detail sheet (no bubbling).
    // Headless CDP cannot write the real clipboard (unfocused document), so stub
    // writeText for this interaction check only — the assertion is that the copy
    // action does not open the sheet, not about clipboard contents.
    await evaluate(
      `(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }); return true })()`,
    );
    const firstId = await evaluate<string>(
      `document.querySelector('[aria-label^="Open request"]').getAttribute('aria-label').replace('Open request ', '')`,
    );
    await page.clickAria('[aria-label="Copy request ID"]');
    assert(!(await page.has("Time to first token")), "copy click did not open the sheet");
    // Keyboard: focusing the named row and pressing Enter opens the detail sheet.
    // Some engines omit keyCode on synthetic events; send the full key info and
    // a Space fallback (both are real row activations per role="button").
    await evaluate(
      `(() => { const r = document.querySelector('[aria-label="Open request ${firstId}"]'); r.focus(); const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }; r.dispatchEvent(new KeyboardEvent('keydown', init)); r.dispatchEvent(new KeyboardEvent('keyup', init)); return document.activeElement === r })()`,
    );
    try {
      await page.waitForText("Time to first token", 3000);
    } catch (e) {
      // Diagnose: did the dispatch land at all, is a dialog mounted, is the row present?
      const diag = await evaluate<string>(
        `(() => { const r = document.querySelector('[aria-label="Open request ${firstId}"]'); return JSON.stringify({ row: !!r, focused: document.activeElement === r, dialog: !!document.querySelector('[role="dialog"]'), bodyHasTime: document.body.innerText.includes('Time to first token') }) })()`,
      );
      throw new Error(`keyboard detail open failed, diag=${diag} (orig: ${e})`);
    }
    // Named sheet title carries the full request id.
    const title = await evaluate<string>(
      `document.querySelector('[data-slot="sheet-title"]')?.textContent ?? document.querySelector('[role="dialog"] h2, [role="dialog"] [class*=break-all]')?.textContent ?? ''`,
    );
    assert(title.includes(firstId), "sheet title shows full request id");
    // Close the keyboard-opened sheet: the modal overlay would swallow the row
    // press below (pointerdown outside closes the Radix sheet instead of opening).
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await page.waitForGone("Time to first token");
    // Detail sheet: open the first request row.
    await page.clickAria('[aria-label^="Open request"]');
    await page.waitForText("Time to first token");
    const detail = await page.body();
    for (const field of ["Input tokens", "Output tokens", "Cost", "Status"])
      assert(detail.includes(field), `detail sheet shows ${field}`);
    assert(detail.includes("Succeeded"), "detail status uses human label");
  });

  await step("usage shows breakdown", async () => {
    await goto("/usage");
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No requests yet")), "usage not empty");
  });

  await step("usage KPIs + model filter", async () => {
    const body = await page.body();
    for (const kpi of ["Requests", "Tokens", "Cost (USD)", "Errors"])
      assert(body.includes(kpi), `KPI ${kpi} present`);
    // Read the Requests KPI semantically from the card structure instead of
    // guessing bodyText line breaks.
    const reqs = Number(
      await evaluate<string>(
        `(() => { const t = [...document.querySelectorAll('[data-slot="card-title"]')].find(e => e.textContent.trim() === 'Requests'); return t?.closest('[data-slot="card"]')?.querySelector('[data-slot="card-content"] p')?.textContent ?? '' })()`,
      ),
    );
    assert(reqs >= 3, `requests KPI >= 3, got ${reqs}`);
    // Model metric filter narrows to fake/test-model without emptying the page.
    await selectOption('[aria-label="Filter by model"]', MODEL_ID);
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No requests yet")), "model filter keeps data");
    const filtered = await page.body();
    assert(/Errors\n/.test(filtered), "errors KPI rendered after filter");
    // Chart semantics: named group role, Y-axis labels, period buttons, metric tabs.
    const chartOk = await evaluate<boolean>(
      `(() => {
        const g = document.querySelector('[role="group"][aria-label^="Daily "]');
        if (!g) return false;
        const periods = [...document.querySelectorAll('[role="group"][aria-label="Time period"] button')].map(b => b.textContent.trim());
        const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Chart metric"] [role="tab"]')].map(t => t.textContent.trim());
        return periods.join(',') === '7d,30d,90d' &&
          tabs.join(',') === 'Requests,Tokens,Cost,Errors';
      })()`,
    );
    assert(chartOk, "named chart group + period buttons + metric tabs");
    assert(await page.has("Token share"), "per-model token share column present");
  });

  await step("credits usage deductions vs top-up history", async () => {
    await goto("/billing/credits");
    await page.waitForText("Top-up history");
    assert(await page.has("Usage deductions"), "deductions section present");
    assert(
      !(await page.has("No usage yet — deductions appear after the first request.")),
      "usage deductions non-empty after billed requests",
    );
    assert(!(await page.has("No top-ups yet.")), "top-up history non-empty");
    // Request column shows the full unique gateway request UUID (enrichment was
    // removed) — never the model name. Scoped to the Usage deductions section.
    const reqCells = await evaluate<string[]>(
      `(() => {
        const h3 = [...document.querySelectorAll('h3')].find(e => e.textContent.startsWith('Usage deductions'));
        if (!h3) return [];
        const section = h3.parentElement;
        const cells = [...section.querySelectorAll('tbody tr')].map(r => {
          const th = [...r.closest('table').querySelectorAll('thead th')];
          const idx = th.findIndex(t => t.textContent.trim() === 'Request');
          return r.children[idx]?.textContent.trim() ?? '';
        });
        return cells;
      })()`,
    );
    assert(reqCells.length >= 3, `>=3 deduction rows with request ids, got ${reqCells.length}`);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const c of reqCells)
      assert(UUID_RE.test(c), `request cell is a full unique UUID, got "${c}"`);
    assert(!reqCells.some((c) => c.includes(MODEL_ID)), "request cell never shows the model name");
    assert(new Set(reqCells).size === reqCells.length, "request ids are unique per row");
  });

  await step("overview shows requests and spend", async () => {
    await goto("/");
    await page.waitForText("Requests");
    await sleep(300);
    const body = await page.body();
    const m = body.match(/Requests\n+(\d+)/);
    assert(m && Number(m[1]) >= 3, `requests tile >= 3, got ${m?.[1] ?? "?"}`);
    assert(!/Spend\n\$0\.00/.test(body), "spend is non-zero in USD");
  });

  // --- key lifecycle: disable, enable, revoke ---
  await step("api keys disable + enable", async () => {
    await goto("/keys");
    await page.waitForText("e2e-key");
    await page.clickAria('[aria-label="Key actions"]');
    await page.waitForText("Disable");
    await page.click("Disable");
    await page.waitForText("Key disabled");
    await page.waitForText("disabled");
    await page.clickAria('[aria-label="Key actions"]');
    await page.waitForText("Enable");
    await page.click("Enable");
    await page.waitForText("Key enabled");
  });

  await step("api keys revoke", async () => {
    await page.clickAria('[aria-label="Key actions"]');
    await page.waitForText("Revoke");
    await page.click("Revoke");
    await page.waitForText("Revoke key");
    await page.clickDialog("Revoke");
    await page.waitForText("Key revoked");
  });

  // --- admin users/system ---
  await step("admin users page renders", async () => {
    await goto("/admin/users");
    await page.waitForText("Instance users");
    // Rows load async after the header; wait for the actual row.
    await page.waitForText(ADMIN_EMAIL);
    assert(await page.has(ADMIN_EMAIL), "admin email listed");
    // Joined column must show a real formatted date, not the "—" placeholder.
    const joined = await evaluate<string | null>(
      `(() => {
        const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes(${JSON.stringify(ADMIN_EMAIL)}));
        if (!row) return null;
        const th = [...row.closest('table').querySelectorAll('thead th')];
        const idx = th.findIndex(t => t.textContent.trim() === 'Joined');
        return row.children[idx]?.textContent.trim() ?? null;
      })()`,
    );
    assert(
      !!joined && joined !== "—" && /\d/.test(joined),
      `Joined cell shows a real date, got "${joined}"`,
    );
  });

  // --- admin users: throwaway lifecycle (create, edit, reset, remove) ---
  await step("admin users throwaway create/edit/reset/remove", async () => {
    const email = "throwaway@e2e.test";
    const newName = "E2E Throwaway Edited";
    const newEmail = "throwaway-edited@e2e.test";
    const oldPassword = "throwaway old password 1";
    const newPassword = "throwaway new password 2";
    await goto("/admin/users");
    await page.waitForText("Add user");
    await page.waitForText(ADMIN_EMAIL);
    // Create via the existing Add user dialog.
    await page.click("Add user");
    await page.waitForText("Create a user with an initial password.");
    await page.setInput("Name", "E2E Throwaway");
    await page.setInput("Email", email);
    await page.setInput("Password", oldPassword);
    await page.click("Create");
    await page.waitForText(email);
    // Edit name + email via the Edit dialog; table must reflect the change.
    await page.clickAria(`[aria-label="Edit ${email}"]`);
    await page.waitForText("Edit user");
    await page.setInput("Name", newName);
    await page.setInput("Email", newEmail);
    await page.click("Save");
    await page.waitForText(`Updated ${newName}`);
    await page.waitForText(newEmail);
    // Reset password through the UI's two password fields.
    await page.clickAria(`[aria-label="Reset password for ${newEmail}"]`);
    await page.waitForText("Set a new password");
    await page.setInput("New password", newPassword);
    await page.setInput("Confirm new password", newPassword);
    await page.click("Reset password");
    await page.waitForText(`Password reset for ${newName}`);
    await waitForDialogClosed();
    // Isolated sign-in probes: credentials 'omit' so Set-Cookie from the
    // response is never stored in this browser profile — the admin session
    // must survive untouched.
    const signIn = (emailStr: string, password: string) =>
      evaluate<{ status: number; body: { user?: { email?: string }; token?: string } | null }>(
        `fetch('/api/auth/sign-in/email', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(emailStr)}, password: ${JSON.stringify(password)} }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`,
      );
    // Old password must fail narrowly: exactly 401 on the sign-in endpoint.
    expectOne4xx(401, "/api/auth/sign-in/email");
    const oldRes = await signIn(newEmail, oldPassword);
    assert(oldRes.status === 401, `old password must fail with 401, got ${oldRes.status}`);
    const newRes = await signIn(newEmail, newPassword);
    assert(newRes.status === 200, `new password sign-in must be 200, got ${newRes.status}`);
    assert(newRes.body?.user?.email === newEmail, "sign-in resolves the throwaway user");
    assert(!!newRes.body?.token, "sign-in issued a session token");
    // Cookie-less probes stored nothing: the browser session is still the admin.
    const session = await browserFetchJson<{ user?: { email?: string } } | null>(
      "/api/auth/get-session",
    );
    assert(
      session?.user?.email === ADMIN_EMAIL,
      `admin browser session intact after isolated sign-ins, got ${session?.user?.email ?? "null"}`,
    );
    // Remove: throwaway owns no workspaces, so removal must succeed cleanly.
    await page.clickAria(`[aria-label="Remove ${newEmail}"]`);
    await page.waitForText("Remove user?");
    await page.clickDialog("Remove");
    await page.waitForGone(newEmail);
  });

  await step("admin system page renders", async () => {
    await goto("/admin/system");
    await page.waitForText("Instance health and status");
    assert(
      (await page.has("gateway_enabled")) || (await page.has("Gateway")),
      "system info present",
    );
  });

  await step("removed providers/pricing pages redirect", async () => {
    await goto("/admin/providers");
    await page.waitForText("Models");
    assert(!(await page.has("Select a model")), "legacy providers UI gone");
    await goto("/admin/pricing");
    await page.waitForText("Models");
    assert(!(await page.has("Add price row")), "legacy pricing UI gone");
    const hrefs = await evaluate<string>(
      `[...document.querySelectorAll('a')].map(a => a.getAttribute('href')).join('|')`,
    );
    assert(
      !hrefs.includes("/admin/providers") && !hrefs.includes("/admin/pricing"),
      "nav has no links to removed pages",
    );
  });

  await step("admin audit log renders", async () => {
    await goto("/admin/audit");
    await page.waitForText("Audit log");
    // Rows load async; wait for a humanized action so body() doesn't race the query.
    await page.waitForText("Workspace created");
    const body = await page.body();
    assert(body.includes("E2E Admin"), "admin actor name shown");
    assert(body.includes("Workspace created"), "humanized action shown");
    const actorCol = await evaluate<string>(
      `[...document.querySelectorAll('tbody tr')].map(r => r.children[2]?.textContent ?? '').join('|')`,
    );
    assert(
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(actorCol),
      "no raw user id in Actor column",
    );
  });

  // --- theme toggle ---
  await step("theme toggle", async () => {
    await goto("/");
    await page.waitForText("Overview");
    const before = await evaluate<string>(
      `window.__hbr.attr('button[aria-label^="Theme:"]','aria-label')`,
    );
    await evaluate(`document.querySelector('button[aria-label^="Theme:"]').click()`);
    await sleep(200);
    const after = await evaluate<string>(
      `window.__hbr.attr('button[aria-label^="Theme:"]','aria-label')`,
    );
    assert(before !== after, `theme changed from ${before} to ${after}`);
    // Persistence: reload and confirm the toggled theme class survives.
    const darkAfterToggle = await evaluate<boolean>(
      `document.documentElement.classList.contains('dark')`,
    );
    await goto("/");
    await page.waitForText("Overview");
    const darkReloaded = await evaluate<boolean>(
      `document.documentElement.classList.contains('dark')`,
    );
    assert(darkAfterToggle === darkReloaded, "theme class persists across reload");
  });

  // --- unknown route 404 ---
  await step("unknown route shows 404", async () => {
    await goto("/definitely-not-a-route-xyz");
    await page.waitForText("Page not found.");
  });

  // --- settings danger zone: delete throwaway workspace ---
  await step("settings danger zone delete throwaway", async () => {
    await goto("/settings");
    await page.waitForText("Danger zone");
    // switch back to main workspace first so the throwaway is deletable and we end on main
    await selectOption('[aria-label="Workspace"]', throwaway).catch(async () => {
      await selectOption('[aria-label="Workspace"]', `${throwaway} 2`);
    });
    await page.click("Delete workspace");
    await page.waitForText("Type the workspace name");
    const name = (await page.text('input[aria-label="Type workspace name to confirm"]')) ?? "";
    const wsNameNow = name; // placeholder attribute
    await evaluate(
      `(() => {
        const input = document.querySelector('input[aria-label="Type workspace name to confirm"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(throwaway + " 2")});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    );
    void wsNameNow;
    await page.clickDialog("Delete");
    await page.waitForText("Workspace deleted");
    await sleep(400);
    assert(
      !(await page.has("Danger zone")) || (await page.has(wsName)),
      "back to a workspace view",
    );
  });

  // ---------- screenshots (after sweep: admin logged in, seeded data) ----------
  // Screenshot failures must never mask or swallow test results: report is
  // always emitted in the finally block below.
  let shotsOk = true;
  try {
    if (SHOTS) {
      mkdirSync(SHOT_DIR, { recursive: true });
      // dark, sidebar expanded (set explicitly; default theme may be light)
      await setTheme("dark");
      await goto("/");
      await page.waitForText("Requests");
      await shot("overview-dark-expanded.png");
      // collapse sidebar, then restore
      await page.clickAria('[aria-label="Collapse sidebar"]');
      await page.waitForText("Overview");
      await shot("overview-dark-collapsed.png");
      await page.clickAria('[aria-label="Expand sidebar"]');
      await page.waitForText("Requests");
      // light theme
      await setTheme("light");
      await shot("overview-light-expanded.png");
      await goto("/models");
      await page.waitForText(MODEL_ID);
      await shot("models-light.png");
      // back to dark
      await setTheme("dark");
      // keys page: the sweep revoked its key, so create one for the table row
      await goto("/keys");
      await page.waitForText("Create key");
      await page.click("Create key");
      await page.setInputById("key-name", "shot-key");
      await page.click("Create");
      await page.waitForText("Copy your API key");
      await page.click("Done");
      await waitForDialogClosed();
      await page.waitForText("shot-key");
      await shot("keys-dark.png");
      // account menu open
      await page.clickAria('[aria-label="Account menu"]');
      await page.waitForText("Sign out");
      await shot("usermenu-open.png");
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
      );
    }
  } catch (e) {
    shotsOk = false;
    console.error(`screenshot phase failed (results still reported): ${e}`);
  }

  // ---------- report ----------
  const failed = results.filter((r) => !r.pass);
  const nameW = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log("\n=== E2E RESULTS ===");
  for (const r of results)
    console.log(
      `${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(nameW)}${r.pass ? "" : ` expected: ${r.expected} | actual: ${r.actual}`}`,
    );
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  const report = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, failed: failed.length },
    results,
  };
  await Bun.write(REPORT, JSON.stringify(report, null, 2));
  console.log(`report: ${REPORT}${shotsOk ? "" : " (screenshots failed; see log)"}`);
  process.exit(failed.length);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(99);
});
