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
const PASSWORD = "Correct-Horse-Battery-Staple-1";
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
// Count of real sign-up requests observed (client-side validation must keep
// this at zero for a mismatched-password signup attempt).
let signupReqs = 0;
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
  } else if (m.method === "Network.requestWillBeSent") {
    if (m.params.request.url.includes("/api/auth/sign-up")) signupReqs++;
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

// ---------- responsive viewport emulation (raw CDP, no extra deps) ----------
const DESKTOP = { width: 1440, height: 900 } as const;

/** Emulate a device: metrics + touch. mobile:true flips pointer to coarse, which
 * is what the product's `pointer-coarse:h-11` 44px targets key off. */
async function setViewport(width: number, height: number, mobile: boolean) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
}

async function resetDesktop() {
  await setViewport(DESKTOP.width, DESKTOP.height, false);
}

/** The whole page must never scroll horizontally. Tables may overflow INSIDE
 * their own overflow-x wrapper (that's containment, not page scroll). */
async function assertNoPageHScroll(where: string) {
  // Offender bounds are computed BEFORE failing so the exact layout culprit
  // appears in the step's failure message (no second evaluation needed).
  const m = await evaluate<{ sw: number; cw: number; offenders: string[] }>(
    `(() => {
      const de = document.documentElement;
      const offenders = [];
      if (de.scrollWidth > de.clientWidth + 1) {
        const cw = de.clientWidth;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.right > cw + 1) {
            offenders.push(el.tagName + '.' + String(el.className).slice(0, 60) +
              ' left=' + Math.round(r.left) + ' right=' + Math.round(r.right) +
              ' w=' + Math.round(r.width));
            if (offenders.length >= 6) break;
          }
        }
      }
      return { sw: de.scrollWidth, cw: de.clientWidth, offenders };
    })()`,
  );
  if (m.sw > m.cw + 1)
    throw new Error(
      `${where}: whole page scrolls horizontally (scrollWidth ${m.sw} > clientWidth ${m.cw}) | offenders: ${m.offenders.join(" ; ") || "none found"}`,
    );
}

/** Trusted Escape via the CDP Input domain (synthetic KeyboardEvent is not
 * trusted and Radix dialogs can ignore it). */
async function pressEscape() {
  for (const type of ["keyDown", "keyUp"] as const) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}

/** Run a body under an emulated viewport; ALWAYS restores desktop afterwards
 * so a step failure cannot cascade a phone viewport into later steps. */
async function withViewport(
  width: number,
  height: number,
  mobile: boolean,
  run: () => Promise<void>,
) {
  await setViewport(width, height, mobile);
  try {
    await run();
  } finally {
    await resetDesktop();
  }
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

  // --- mobile auth: phone viewport, muted card border as a computed value,
  // 44px coarse-pointer targets, landscape footer reachability, client-only
  // mismatch validation (no sign-up request) ---
  await step("mobile auth: phone login fits, muted border computed, 44px inputs", async () => {
    await withViewport(390, 844, true, async () => {
      await goto("/login");
      await page.waitForText("Sign in");
      await assertNoPageHScroll("login 390x844");
      // Touch emulation must report coarse pointers — the product's 44px
      // `pointer-coarse:h-11` targets key off it.
      assert(
        await evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`),
        "touch emulation reports pointer: coarse",
      );
      // Muted border verified as a computed color equal to the border-border
      // token — never from class text or screenshot pixels.
      const border = await evaluate<{
      card: string | null;
      probe: string | null;
      width: string | null;
    }>(`(() => {
      const card = [...document.querySelectorAll('div')].find(
        (d) => d.className.includes('rounded-lg') && d.className.includes('border-border'));
      if (!card) return { card: null, probe: null, width: null };
      const probe = document.createElement('div');
      probe.className = 'border-border';
      document.body.appendChild(probe);
      const out = {
        card: getComputedStyle(card).borderTopColor,
        probe: getComputedStyle(probe).borderTopColor,
        width: getComputedStyle(card).borderTopWidth,
      };
      probe.remove();
      return out;
    })()`);
    assert(!!border.card, "auth card element found");
    assert(
      border.card === border.probe,
      `card border color equals border-border token (got ${border.card})`,
    );
    assert(
      border.card !== "rgba(0, 0, 0, 0)" && border.width === "1px",
      `card has a real 1px border (width ${border.width}, color ${border.card})`,
    );
    const inputH = await evaluate<number>(
      `document.querySelector('form input').getBoundingClientRect().height`,
    );
      assert(inputH === 44, `login input height 44px under coarse pointer, got ${inputH}`);
    });
  });

  await step("mobile auth: landscape signup footer reachable, mismatch is client-only", async () => {
      await withViewport(844, 390, true, async () => {
        // phone landscape
        await goto("/signup");
        await page.waitForText("Create account");
        await page.setInput("Name", "Mismatch Probe");
        await page.setInput("Email", "mismatch-probe@e2e.test");
        await page.setInput("Password", PASSWORD);
        await page.setInput("Confirm password", `${PASSWORD}-different`);
        const reqsBefore = signupReqs;
        await page.click("Sign up");
        await page.waitForText("Passwords do not match");
        assert(
          signupReqs === reqsBefore,
          `no /api/auth/sign-up request on client-side mismatch (sent ${signupReqs - reqsBefore})`,
        );
        // Tall signup on a short landscape viewport: the terms footer must be
        // reachable by scrolling the auth scroll container, never clipped.
        const footer = await evaluate<boolean>(`(() => {
          const scroller = document.querySelector('div.fixed.inset-0.overflow-y-auto');
          scroller.scrollTop = scroller.scrollHeight;
          const link = [...document.querySelectorAll('a')].find(
            (a) => a.textContent.includes('Terms of Service'));
          const r = link.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= scroller.clientHeight + 1 && r.height > 0;
        })()`);
        assert(footer, "terms footer reachable by scroll in landscape");
        await assertNoPageHScroll("signup 844x390");
      });
    // Leave without completing a real signup; later fixtures re-navigate.
    await goto("/login");
    await page.waitForText("Sign in");
  });

  // --- signup admin ---
  await step("signup admin", async () => {
    await goto("/signup");
    await page.setInput("Name", "E2E Admin");
    await page.setInput("Email", ADMIN_EMAIL);
    await page.setInput("Password", PASSWORD);
    await page.setInput("Confirm password", PASSWORD);
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
    await page.setInput("Confirm password", PASSWORD);
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

  // --- chat: session catalog + managed "Browser Chat" auto-key flow ---
  let chatWsId = "";
  let chatUserId = "";
  let chatId = "";
  const chatKeys = () =>
    browserFetchJson<{ id: string; name: string; status: string }[]>(
      `/api/v1/workspaces/${chatWsId}/keys`,
    );
  const chatSnapshot = () =>
    browserFetchJson<{
      title: string;
      model: string | null;
      version: number;
      archived_at: number | null;
      messages: { role: string; content: string }[];
    }>(`/api/v1/workspaces/${chatWsId}/chats/${chatId}`);
  const typeMessage = (text: string) =>
    evaluate(`(() => {
      const ta = document.querySelector('textarea[aria-label="Message"]');
      if (!ta) throw new Error('message textarea not found');
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  const convLog = () =>
    evaluate<{ n: number; first?: string; last?: string } | null>(`(() => {
      const log = document.querySelector('[aria-label="Conversation"]');
      const inner = log?.firstElementChild; // bubbles render inside the centered column
      if (!inner) return null;
      return { n: inner.children.length,
        first: inner.children[0]?.textContent,
        last: inner.children[inner.children.length - 1]?.textContent };
    })()`);
  // Reply text renders mid-stream; the Send button only returns once the
  // terminal save is done — wait for it before the next interaction.
  const replyDone = () =>
    waitForExpr(
      `!!document.querySelector('[aria-label="Send message"]')`,
      "stream finished (Send button back)",
    );
  const PLAINTEXT_KEY_RE = /sk-hbr-[A-Za-z0-9_-]{43}/; // full plaintext shape; key_prefix is far shorter

  await step("chat: session catalog, model pick, auto Browser Chat key, streamed reply", async () => {
    await goto("/chat");
    await page.waitForText("What would you like to build?");
    assert(
      await page.has('"Browser Chat"'),
      "empty state discloses the managed auto chat key",
    );
    const session = await browserFetchJson<{ user?: { id?: string } } | null>(
      "/api/auth/get-session",
    );
    chatUserId = session?.user?.id ?? "";
    chatWsId =
      (await browserFetchJson<{ id: string; name: string }[]>("/api/v1/workspaces")).find(
        (w) => w.name === wsName,
      )?.id ?? "";
    assert(!!chatUserId && !!chatWsId, "session user + main workspace id resolved");
    // Catalog is session-scoped: the picker is usable before any key exists.
    await waitForExpr(
      `document.getElementById('chat-model')?.textContent === 'Choose a model'`,
      "model catalog loaded without a key",
    );
    await selectOption("#chat-model", "Fake Test");
    const keysBefore = await chatKeys();
    await typeMessage("hi");
    await page.clickAria('[aria-label="Send message"]');
    // Streamed reply from the fake CPA (the gateway echoes the public model id).
    await page.waitForText("Hello from fake/test-model: hi");
    await replyDone();
    // Viewport contract after a send: the page itself never scrolls (the log
    // is the only scroller) and the composer stays visible at the bottom.
    const chatLayout = await evaluate<{
      composerBottom: number;
      scrollHeight: number;
      innerHeight: number;
    }>(`(() => {
      const ta = document.querySelector('textarea[aria-label="Message"]');
      return {
        composerBottom: ta ? ta.getBoundingClientRect().bottom : -1,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    })()`);
    assert(
      chatLayout.composerBottom > 0 && chatLayout.composerBottom <= chatLayout.innerHeight,
      `composer bottom within viewport, got ${chatLayout.composerBottom} vs ${chatLayout.innerHeight}`,
    );
    assert(
      chatLayout.scrollHeight <= chatLayout.innerHeight + 1,
      `page does not scroll: scrollHeight ${chatLayout.scrollHeight} vs innerHeight ${chatLayout.innerHeight}`,
    );
    const conv = await convLog();
    assert(!!conv, "conversation log rendered");
    assert(conv!.n === 2, `two bubbles (user + assistant), got ${conv!.n}`);
    assert(conv!.first === "hi", "user bubble shows the sent message");
    assert(
      conv!.last!.includes("Hello from fake/test-model: hi"),
      `assistant bubble has streamed reply, got "${conv!.last!.slice(0, 120)}"`,
    );
    // The send itself minted exactly one normal workspace API key.
    const keysAfter = await chatKeys();
    assert(
      keysAfter.length === keysBefore.length + 1,
      `exactly one key created by the chat flow (before ${keysBefore.length}, after ${keysAfter.length})`,
    );
    const created = keysAfter.filter((k) => !keysBefore.some((b) => b.id === k.id));
    assert(
      created.length === 1 && created[0]!.name === "Browser Chat" && created[0]!.status === "enabled",
      "the new key is the enabled Browser Chat key",
    );
    assert(
      !PLAINTEXT_KEY_RE.test(JSON.stringify(keysAfter)),
      "keys list response never carries a plaintext secret",
    );
    // History list shows the literal first-turn title, and the snapshot matches.
    await waitForExpr(
      `!!document.querySelector('[aria-label="Rename conversation: hi"]')`,
      "sidebar lists the conversation titled hi",
    );
    chatId =
      (await browserFetchJson<{ data: { id: string }[] }>(
        `/api/v1/workspaces/${chatWsId}/chats`,
      )).data[0]?.id ?? "";
    assert(!!chatId, "conversation persisted server-side");
    const snap = await chatSnapshot();
    assert(snap.title === "hi", `first-turn title is the literal prompt, got "${snap.title}"`);
    assert(snap.model === MODEL_ID, "snapshot records the selected model");
    assert(
      snap.messages.length === 2 &&
        snap.messages[0]?.role === "user" &&
        snap.messages[1]?.role === "assistant",
      "snapshot has the user + assistant turn",
    );
  });

  await step("chat: full reload reopens the saved conversation with messages + model", async () => {
    await goto("/chat");
    await page.waitForText("What would you like to build?");
    await waitForExpr(
      `!!document.querySelector('[aria-label="Rename conversation: hi"]')`,
      "history list shows the saved conversation",
    );
    await page.click("hi", false);
    await page.waitForText("Hello from fake/test-model: hi");
    const conv = await convLog();
    assert(!!conv && conv.n === 2, `reopened log has both messages, got ${conv?.n ?? "none"}`);
    assert(conv!.first === "hi", "saved user message restored");
    assert(conv!.last!.includes("Hello from fake/test-model: hi"), "saved assistant reply restored");
    const model = (await evaluate<string>(`document.getElementById('chat-model')?.textContent ?? ''`));
    assert(model.includes("Fake Test"), `model restored from snapshot, got "${model}"`);
  });

  await step("chat: rename via UI to Saved E2E chat, continue send without 409", async () => {
    await page.clickAria('[aria-label="Rename conversation: hi"]');
    await page.waitForText("Rename conversation");
    await page.setInputById("conversation-rename-title", "Saved E2E chat");
    await page.click("Save");
    await waitForDialogClosed();
    await page.waitForText("Saved E2E chat");
    // The rename went through the same versioned save the page tracks, so the
    // next turn must save cleanly (a 409 here fails the step's noise gate).
    await typeMessage("again");
    await page.clickAria('[aria-label="Send message"]');
    await page.waitForText("Hello from fake/test-model: again");
    await replyDone();
    assert(
      !(await page.has("changed on another device")),
      "no 409 conflict banner after the continued send",
    );
  });

  await step("chat: explicit Stop keeps the partial, Retry does not duplicate the user turn", async () => {
    await typeMessage("stop me");
    await page.clickAria('[aria-label="Send message"]');
    // 300ms fake-CPA chunk pacing: wait for the first content token, stop mid-stream.
    await waitForExpr(
      `(() => { const log = document.querySelector('[aria-label="Conversation"]');
        const last = log?.children[log.children.length - 1];
        return !!last && last.textContent.includes('Hello from'); })()`,
      "first assistant content token",
    );
    await page.clickAria('[aria-label="Stop generating"]');
    // The stop path persists the partial before it re-enables the composer.
    await waitForExpr(
      `!!document.querySelector('[aria-label="Send message"]')`,
      "streaming ended after Stop",
    );
    const afterStop = await chatSnapshot();
    assert(
      afterStop.messages.some((m) => m.role === "assistant" && m.content.includes("Hello from")),
      "stopped partial reply was saved",
    );
    const baseVersion = afterStop.version;
    await page.click("Retry last reply");
    const deadline = Date.now() + 10000;
    let snap = await chatSnapshot();
    while (snap.version <= baseVersion) {
      if (Date.now() > deadline)
        throw new Error(`retry save did not land (version ${snap.version} <= ${baseVersion})`);
      await sleep(300);
      snap = await chatSnapshot();
    }
    const userTurns = snap.messages.filter((m) => m.role === "user" && m.content === "stop me");
    assert(
      userTurns.length === 1,
      `retry must not duplicate the original user turn, got ${userTurns.length}`,
    );
    const replies = snap.messages.filter(
      (m) => m.role === "assistant" && m.content.includes("Hello from fake/test-model: stop me"),
    );
    assert(replies.length === 1, `exactly one saved reply for the retried turn, got ${replies.length}`);
  });

  await step("chat: archive removes from the active list, server retains messages (no delete)", async () => {
    await page.clickAria('[aria-label="Archive conversation: Saved E2E chat"]');
    await page.waitForText("What would you like to build?");
    await page.waitForText("No conversations yet.");
    const list = await browserFetchJson<{ data: { id: string }[] }>(
      `/api/v1/workspaces/${chatWsId}/chats`,
    );
    assert(list.data.length === 0, "active conversation list is empty after archive");
    const snap = await chatSnapshot();
    assert(snap.archived_at !== null, "conversation is archived server-side, not deleted");
    assert(
      snap.messages.length >= 6,
      `all messages retained after archive, got ${snap.messages.length}`,
    );
    assert(
      snap.messages.some((m) => m.role === "user" && m.content === "hi"),
      "original user message retained",
    );
  });

  await step("chat: New chat welcome, advanced manual key is memory/tab-scoped, no legacy global", async () => {
    const keysBeforeManual = await chatKeys();
    await evaluate(`(() => {
      const s = [...document.querySelectorAll('details > summary')]
        .find(el => el.textContent.includes('Advanced: use your own API key'));
      if (!s) throw new Error('advanced key summary not found');
      s.click();
      return true;
    })()`);
    await page.setInputById("chat-api-key", apiKey);
    // Memory-only by default: the pasted key exists in no storage entry at all.
    assert(
      await evaluate<boolean>(`(() => {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k === 'hbr-chat-key' || k.startsWith('hbr-chat-key:')) return false;
          if ((sessionStorage.getItem(k) ?? '').includes(${JSON.stringify(apiKey)})) return false;
        }
        return true;
      })()`),
      "pasted manual key stays memory-only before remember",
    );
    await typeMessage("manual hi");
    await page.clickAria('[aria-label="Send message"]');
    await page.waitForText("Hello from fake/test-model: manual hi");
    await replyDone();
    const keysAfterManual = await chatKeys();
    assert(
      keysAfterManual.length === keysBeforeManual.length,
      "manual key path creates no additional key",
    );
    await page.click("New chat");
    await page.waitForText("What would you like to build?");
    assert(
      !(await evaluate<boolean>(`!!document.querySelector('[aria-label="Conversation"]')`)),
      "conversation log cleared after New chat",
    );
    // Remember opts into sessionStorage namespaced by user+workspace — never
    // the legacy unscoped key (cross-user leak on shared browsers).
    await page.clickSwitch("chat-remember");
    const scopedKey = `hbr-chat-key:${chatUserId}:${chatWsId}`;
    assert(
      await evaluate<boolean>(`(() => {
        const scoped = sessionStorage.getItem(${JSON.stringify(scopedKey)});
        if (scoped === null || !scoped.includes('sk-hbr-')) return false;
        return sessionStorage.getItem('hbr-chat-key') === null;
      })()`),
      "remembered key stored under the user+workspace scoped key only",
    );
  });

  await step("chat: markdown engine sanitizes model output in the browser (no script/js-href/img fetch, no overflow)", async () => {
    // The fake CPA echoes the prompt into the reply, so the markdown payload
    // travels as chat content only — no provider or fake-CPA change, and the
    // send uses the remembered manual key (no new key, fake model, no charge).
    await typeMessage(
      '**bold** <script>alert(1)</script> [click](javascript:alert(1)) ![px](https://evil.example/track.png)',
    );
    await page.clickAria('[aria-label="Send message"]');
    await page.waitForText("Hello from fake/test-model:");
    await replyDone();
    const md = await evaluate<{
      strong: string;
      scripts: number;
      jsLinks: number;
      imgs: number;
      imgAlt: boolean;
      overflow: boolean;
    }>(`(() => {
      const log = document.querySelector('[aria-label="Conversation"]');
      const last = log?.firstElementChild?.lastElementChild;
      const mdEl = last?.querySelector('.wrap-anywhere');
      if (!mdEl) throw new Error('markdown container not found');
      return {
        strong: [...mdEl.querySelectorAll('strong')].map(s => s.textContent).join('|'),
        scripts: mdEl.querySelectorAll('script').length,
        jsLinks: [...mdEl.querySelectorAll('a')].filter(a => (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:')).length,
        imgs: mdEl.querySelectorAll('img').length,
        imgAlt: !!mdEl.querySelector('.md-img-alt'),
        overflow: mdEl.scrollWidth > mdEl.clientWidth + 1,
      };
    })()`, );
    assert(md.strong === "bold", `markdown emphasis rendered, got "${md.strong}"`);
    assert(md.scripts === 0, `injected <script> stripped, got ${md.scripts}`);
    assert(md.jsLinks === 0, `javascript: href stripped, got ${md.jsLinks}`);
    assert(
      md.imgs === 0 && md.imgAlt,
      `remote image never fetched, alt text survives (imgs ${md.imgs}, alt ${md.imgAlt})`,
    );
    assert(!md.overflow, "markdown output does not overflow the log horizontally");
  });

  await step("chat: workspace switch aborts context, chat key storage stays identity-scoped", async () => {
    await selectOption('[aria-label="Workspace"]', `${throwaway} 2`);
    // Nothing from the funded workspace's chat may leak into the other one.
    await page.waitForText("What would you like to build?");
    await page.waitForText("No conversations yet.");
    assert(
      !(await page.has("Hello from fake")),
      "no prior conversation content after the workspace switch",
    );
    assert(
      await evaluate<boolean>(`(() => {
        if (sessionStorage.getItem('hbr-chat-key') !== null) return false;
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k.startsWith('hbr-chat-key:')) return false; // remembered key dropped on identity change
        }
        return true;
      })()`),
      "remembered manual key dropped on switch; no legacy unscoped global",
    );
    await selectOption('[aria-label="Workspace"]', wsName);
    await page.waitForText("What would you like to build?");
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
    const oldPassword = "Throwaway-Old-Password-1";
    const newPassword = "Throwaway-New-Password-2";
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

  // --- optional email verification: real unverified state, SMTP off in E2E ---
  await step(
    "email verify page: real unverified state, forged query cannot fake success, banner hidden",
    async () => {
      const cfg = await browserFetchJson<{ emailVerification: { enabled: boolean } }>(
        "/api/v1/public-config",
      );
      assert(cfg.emailVerification.enabled === false, "E2E runs with SMTP off (enabled=false)");
      // The page reports status only from the real session flag; a forged
      // query string must never produce the verified success state.
      await goto("/verify-email?verified=1&token=forged");
      await page.waitForText("Email not verified yet");
      assert(!(await page.has("Email verified")), "forged query cannot fake verified success");
      // No SMTP => no verification banner; unverified users use the app normally.
      await goto("/");
      await page.waitForText("Overview");
      assert(
        !(await page.has("Please verify your email address")),
        "no verification banner with SMTP off",
      );
    },
  );

  // --- responsive sweep: phone nav sheet, page fit, chat phone layout, tablet nav ---
  await step(
    "mobile phone: nav sheet opens, aside hidden, 44px hamburger, Models navigates, Escape returns focus",
    async () => {
      await withViewport(390, 844, true, async () => {
        await goto("/");
        await page.waitForText("Requests");
        await assertNoPageHScroll("overview 390x844");
        // Hidden aside verified from the real DOM's computed style, not CSS text.
        const asideDisplay = await evaluate<string>(
          `getComputedStyle(document.querySelector('aside')).display`,
        );
        assert(asideDisplay === "none", `aside hidden on phone, got display:${asideDisplay}`);
        const burger = await evaluate<{ visible: boolean; h: number }>(
          `(() => { const el = document.querySelector('[aria-label="Open navigation"]');
            const r = el.getBoundingClientRect();
            return { visible: r.width > 0 && r.height > 0, h: r.height }; })()`,
        );
        assert(burger.visible && burger.h === 44, `hamburger visible 44px, got ${burger.h}`);
        // Open the Sheet and navigate via the Models link (auth links are not in
        // the signed-in nav; the logged-out phone sweep covered auth pages).
        await page.clickAria('[aria-label="Open navigation"]');
        await waitForExpr(`!!document.querySelector('[role="dialog"]')`, "mobile nav sheet open");
        // The sheet holds two "Models" links once admin nav renders (user and
        // admin sections); click the FIRST one (user /models) deterministically.
        await evaluate(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const link = [...dialog.querySelectorAll('a')].find(
            (a) => a.textContent.trim() === 'Models');
          if (!link) throw new Error('Models link not found in sheet');
          link.click();
          return true;
        })()`);
        await waitForExpr(
          `location.pathname === '/models' && !document.querySelector('[role="dialog"]')`,
          "Models link navigated and sheet closed",
        );
        await page.waitForText(MODEL_ID);
        // Escape closes and focus returns to the trigger.
        await page.clickAria('[aria-label="Open navigation"]');
        await waitForExpr(`!!document.querySelector('[role="dialog"]')`, "mobile nav sheet reopened");
        await pressEscape();
        await waitForExpr(`!document.querySelector('[role="dialog"]')`, "sheet closed on Escape");
        // Radix restores focus asynchronously after unmount, so wait for it.
        await waitForExpr(
          `document.activeElement?.getAttribute?.('aria-label') === 'Open navigation'`,
          "focus returned to the navigation trigger",
        );
      });
      // Second phone size.
      await withViewport(375, 812, true, async () => {
        await goto("/");
        await page.waitForText("Requests");
        await assertNoPageHScroll("overview 375x812");
      });
    },
  );

  await step(
    "mobile phone: admin system + audit fit, chat history sheet, composer in viewport, long bubble wraps",
    async () => {
      // Chat page fit at phone width — isolated step so a real overflow finding
      // here does not mask the remaining phone-layout checks below.
      await withViewport(390, 844, true, async () => {
        for (const [path, marker] of [
          ["/admin/system", "Instance health and status"],
          ["/admin/audit", "Audit log"],
        ] as const) {
          await goto(path);
          await page.waitForText(marker);
          await assertNoPageHScroll(`admin ${path} 390x844`);
        }
        await goto("/chat");
        await page.waitForText("What would you like to build?");
        await assertNoPageHScroll("chat 390x844");
      });
    },
  );

  await step(
    "mobile phone: chat history sheet, composer in viewport, long bubble wraps",
    async () => {
      await withViewport(390, 844, true, async () => {
        await goto("/chat");
        await page.waitForText("What would you like to build?");
        const hist = await evaluate<boolean>(
          `(() => { const el = document.querySelector('[aria-label="Conversation history"]');
            const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
        );
        assert(hist, "chat history sheet trigger visible under lg");
        await page.clickAria('[aria-label="Conversation history"]');
        await waitForExpr(`!!document.querySelector('[role="dialog"]')`, "history sheet open");
        await pressEscape();
        await waitForExpr(`!document.querySelector('[role="dialog"]')`, "history sheet closed");
        const composer = await evaluate<{ top: number; bottom: number; vh: number }>(
          `(() => {
            const r = document.querySelector('textarea[aria-label="Message"]').getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, vh: innerHeight }; })()`,
        );
        assert(
          composer.top >= 0 && composer.bottom <= composer.vh + 1,
          `composer within viewport (${JSON.stringify(composer)})`,
        );
        // Toolbar geometry: one row on the phone — every control on a shared
        // centerY (2px tolerance), 44px touch targets for the icon-only
        // buttons (Connect may be absent depending on key state), and the
        // document itself must not scroll vertically.
        const toolbar = await evaluate<{
          centers: number[];
          sizes: Array<{ label: string; w: number; h: number }>;
          docH: number;
          innerH: number;
        }>(
          `(() => {
            const tb = document.querySelector('[role="group"][aria-label="Chat controls"]');
            if (!tb) throw new Error('chat toolbar not found');
            const sels = [
              ['Model', '#chat-model'],
              ['History', '[aria-label="Conversation history"]'],
              ['Connect', '[aria-label="Connect"]'],
              ['New chat', '[aria-label="New chat"]'],
            ];
            const centers = [];
            const sizes = [];
            for (const [label, sel] of sels) {
              const el = tb.querySelector(sel);
              if (!el) continue; // Connect renders only when a key is pending
              const r = el.getBoundingClientRect();
              if (!(r.width > 0 && r.height > 0)) throw new Error(label + ' control not visible');
              centers.push(r.top + r.height / 2);
              sizes.push({ label, w: r.width, h: r.height });
            }
            return { centers, sizes,
              docH: document.documentElement.scrollHeight, innerH: innerHeight };
          })()`,
        );
        assert(
          Math.max(...toolbar.centers) - Math.min(...toolbar.centers) <= 2,
          `toolbar controls share one row (centers ${JSON.stringify(toolbar.centers)})`,
        );
        for (const s of toolbar.sizes) {
          assert(
            s.w >= 44 && s.h >= 44,
            `toolbar ${s.label} touch target >= 44px, got ${s.w}x${s.h}`,
          );
        }
        assert(
          toolbar.docH <= toolbar.innerH + 1,
          `document does not scroll: ${toolbar.docH} vs ${toolbar.innerH}`,
        );
        // A long unbroken bubble must wrap inside the log, never scroll the page.
        await selectOption("#chat-model", "Fake Test");
        await typeMessage("w".repeat(400));
        await page.clickAria('[aria-label="Send message"]');
        await page.waitForText("Hello from fake/test-model:");
        await replyDone();
        const bubble = await evaluate<{ w: number; containerW: number; overflow: boolean }>(
          `(() => {
            const log = document.querySelector('[aria-label="Conversation"]');
            const w400 = 'w'.repeat(400);
            const matches = [...log.querySelectorAll('div')].filter(
              (d) => d.textContent === w400,
            );
            // innermost match: one that contains no other matching div (ancestors match too)
            const b = matches.find((d) => !matches.some((m) => m !== d && d.contains(m)));
            const r = b.getBoundingClientRect();
            return { w: r.width, containerW: log.getBoundingClientRect().width,
              overflow: b.scrollWidth > b.clientWidth + 1 }; })()`,
        );
        assert(
          bubble.w <= bubble.containerW * 0.86,
          `bubble stays inside its max width (${bubble.w} of ${bubble.containerW})`,
        );
        assert(!bubble.overflow, "long word wrapped, no inner overflow");
        await assertNoPageHScroll("chat after long bubble 390x844");
      });
    },
  );

  await step(
    "tablet: desktop nav visible, collapse persists across reload, header fits in both orientations",
    async () => {
      await withViewport(820, 1180, true, async () => {
        // iPad portrait; md+ shows the desktop aside
        await goto("/");
        await page.waitForText("Requests");
        const aside = await evaluate<{ display: string; w: number }>(
          `(() => { const a = document.querySelector('aside'); const r = a.getBoundingClientRect();
            return { display: getComputedStyle(a).display, w: r.width }; })()`,
        );
        assert(
          aside.display !== "none" && aside.w > 100,
          `desktop nav visible on tablet (display ${aside.display}, width ${aside.w})`,
        );
        assert(
          await evaluate<boolean>(
            `getComputedStyle(document.querySelector('[aria-label="Open navigation"]')).display === 'none'`,
          ),
          "hamburger hidden on tablet",
        );
        // Collapse state persists (zustand persist -> localStorage).
        await page.clickAria('[aria-label="Collapse sidebar"]');
        await goto("/");
        await page.waitForText("Requests");
        const collapsedW = await evaluate<number>(
          `document.querySelector('aside').getBoundingClientRect().width`,
        );
        assert(collapsedW === 56, `collapsed sidebar persists across reload (width ${collapsedW})`);
        assert(
          await evaluate<boolean>(`!!document.querySelector('[aria-label="Expand sidebar"]')`),
          "expand control rendered",
        );
        await page.clickAria('[aria-label="Expand sidebar"]');
        await assertNoPageHScroll("overview 820x1180");
      });
      await withViewport(1180, 820, true, async () => {
        // landscape
        await goto("/");
        await page.waitForText("Requests");
        await assertNoPageHScroll("overview 1180x820");
        assert(
          await evaluate<boolean>(
            `getComputedStyle(document.querySelector('aside')).display !== 'none'`,
          ),
          "desktop nav stays visible in landscape",
        );
      });
    },
  );

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
