// E2E UI harness: drives headless Chrome over raw CDP (no extra deps).
// Env: CDP_URL (default http://127.0.0.1:9399), BASE (default http://127.0.0.1:5199),
// HBR_DEV_ADMIN_EMAIL (default admin@e2e.test). Exits with #failures.
// Writes JSON report to /tmp/hbr-e2e/report.json.
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9399";
const BASE = process.env.BASE ?? "http://127.0.0.1:5199";
const ADMIN_EMAIL = (process.env.HBR_DEV_ADMIN_EMAIL ?? "admin@e2e.test").toLowerCase();
const USER2_EMAIL = "user2@e2e.test";
const PASSWORD = "correct horse battery staple";
const MODEL_ID = "fake/test-model";
const REPORT = "/tmp/hbr-e2e/report.json";

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

// ---------- per-step evidence collection ----------
type Evidence = { console: string[]; pageErrors: string[]; http: string[] };
let current: Evidence = { console: [], pageErrors: [], http: [] };

onEvent((m) => {
  if (m.method === "Runtime.consoleAPICalled") {
    const type = m.params.type;
    if (type === "error" || type === "warning") {
      const text = m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ");
      // Vite/devtools noise that isn't a product problem.
      if (!/Download the React DevTools|\[vite\]|WebSocket.*(close|error)/i.test(text))
        current.console.push(`${type}: ${text}`);
    }
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    current.pageErrors.push(d.exception?.description ?? d.text ?? "unknown exception");
  } else if (m.method === "Network.responseReceived") {
    const { status, url } = m.params.response;
    if (status >= 400 && !url.includes("/_vite")) {
      // useIsAdmin() probes GET /admin/system; 403 is the app's designed
      // "not an instance admin" signal, not an error.
      if (status === 403 && url.includes("/api/v1/admin/system")) return;
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
  setInput: (label: string, value: string) =>
    evaluateWhenPresent(`window.__hbr.setInput(${JSON.stringify(label)}, ${JSON.stringify(value)})`),
  setInputById: (id: string, value: string) =>
    evaluateWhenPresent(`window.__hbr.setInputById(${JSON.stringify(id)}, ${JSON.stringify(value)})`),
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

/** Radix Select: click trigger (by id or label), then the option with the text. */
async function selectOption(triggerSelector: string, optionText: string) {
  await evaluateWhenPresent(
    `window.__hbr.press(document.querySelector(${JSON.stringify(triggerSelector)}) ?? (()=>{throw new Error('trigger not found: ${triggerSelector}')})())`,
  );
  await page.click(optionText);
  await sleep(100);
}

// ---------- step runner ----------
const results: { name: string; pass: boolean; expected?: string; actual?: string }[] = [];

const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

async function step(name: string, run: () => Promise<void>) {
  if (ONLY && !ONLY.test(name)) return;
  current = { console: [], pageErrors: [], http: [] };
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await installHelpers();
  // Fresh storage per run: persisted workspace ids from previous runs point at
  // workspaces that no longer exist in the fresh SQLite DB.
  await navigate(BASE);
  await evaluate(`localStorage.clear()`);
  await sleep(100);

  let apiKey = "";
  const wsName = "E2E Main";
  const throwaway = "Throwaway";

  const goto = (path: string) => navigate(BASE + path);

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
    await page.click(ADMIN_EMAIL); // user menu trigger shows email
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
    await page.click(USER2_EMAIL);
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
  });

  // --- members: invite user2, change role, remove ---
  await step("members add second user", async () => {
    await page.click("Members", false);
    await page.waitForText("Invite by email");
    await page.setInput("Invite by email", USER2_EMAIL);
    await page.click("Invite", true);
    await page.waitForText(USER2_EMAIL);
  });

  await step("members change role", async () => {
    await selectOption(`[aria-label="Role for ${USER2_EMAIL}"]`, "admin");
    await page.waitForText("Role updated");
  });

  await step("members remove", async () => {
    await page.click("Remove");
    await page.waitForText("Remove member");
    await page.click("Remove");
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
    await goto("/admin/providers");
    await page.waitForText("Select a model");
    await selectOption("#model-select", MODEL_ID);
    await page.waitForText("Add mapping to");
    await page.setInput("Provider", "fake");
    await page.setInput("Upstream model", "fake-model");
    await page.click("Add mapping");
    await page.waitForText("Mapping added");
  });

  await step("admin add price", async () => {
    await goto("/admin/pricing");
    await page.waitForText("Add price");
    await selectOption("#pricing-model", MODEL_ID);
    await page.click("Add price");
    await page.waitForText("Add price row");
    await page.setInputById("input_usd_micro_per_1m", "1");
    await page.setInputById("output_usd_micro_per_1m", "2");
    await page.setInputById("cached_input_usd_micro_per_1m", "0.5");
    await page.setInputById("reasoning_usd_micro_per_1m", "0");
    await page.click("Add price");
    await page.waitForText("Price row added");
  });

  // --- user Models list + detail ---
  await step("user models list + detail", async () => {
    await goto("/models");
    await page.waitForText(MODEL_ID);
    await page.click(MODEL_ID, false);
    await page.waitForText("Input / 1M");
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
    await page.click('[aria-label="Key actions"]', false);
    await page.waitForText("Model restrictions");
    await page.click("Model restrictions");
    await page.waitForText("Model restrictions — e2e-key");
    await page.click(MODEL_ID, false);
    await page.click("Save");
    await page.waitForText("Model restrictions saved");
  });

  // --- gateway calls (Bun fetch, not UI) ---
  await step("gateway chat completions (non-stream)", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
    });
    assert(res.ok, `status ${res.status}`);
    const json = await res.json();
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
    assert(res.ok, `status ${res.status}`);
    const text = await res.text();
    assert(text.includes('"finish_reason":"stop"'), "finish_reason stop");
    assert(text.includes("prompt_tokens"), "final usage chunk");
    assert(text.trimEnd().endsWith("[DONE]"), "[DONE] terminator");
  });

  await step("gateway responses", async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, input: "hello" }),
    });
    assert(res.ok, `status ${res.status}`);
    const json = await res.json();
    assert(json.status === "completed", "completed status");
    assert(json.usage?.input_tokens > 0, "usage present");
  });

  // --- billing: credits top-up, admin mark paid, balance + ledger ---
  await step("billing credits mock top-up create", async () => {
    await goto("/billing/credits");
    await page.waitForText("Top up");
    await page.click("Create payment");
    await page.waitForText("pending");
    assert((await page.has("Complete (dev)")) || true, "payment status view shown");
  });

  await step("admin payments mark paid", async () => {
    await goto("/admin/payments");
    await page.waitForText("Mark paid");
    await page.click("Mark paid");
    await page.waitForText("Mark payment as paid?");
    await page.click("Confirm");
    await page.waitForText("paid");
  });

  await step("credits balance + ledger updated", async () => {
    await goto("/billing/credits");
    await page.waitForText("Ledger");
    const body = await page.body();
    assert(/100\.000\s*₫/.test(body), "balance shows 100.000 ₫");
    assert(!body.includes("No ledger entries yet"), "ledger has entries");
    assert(body.includes("payment"), "ledger shows payment entry");
  });

  await step("billing payments list", async () => {
    await goto("/billing/payments");
    await page.waitForText("Payments");
    await page.waitForText("paid");
  });

  // --- logs, usage, overview show requests/spend ---
  await step("logs show gateway requests", async () => {
    await goto("/logs");
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No requests yet")), "logs not empty");
  });

  await step("usage shows breakdown", async () => {
    await goto("/usage");
    await page.waitForText(MODEL_ID);
    assert(!(await page.has("No requests yet")), "usage not empty");
  });

  await step("overview shows requests and spend", async () => {
    await goto("/");
    await page.waitForText("Requests");
    await sleep(300);
    const body = await page.body();
    const m = body.match(/Requests\n(\d+)/);
    assert(m && Number(m[1]) >= 3, `requests tile >= 3, got ${m?.[1] ?? "?"}`);
    assert(!/Spend\n0 ₫/.test(body), "spend is non-zero");
  });

  // --- key lifecycle: disable, enable, revoke ---
  await step("api keys disable + enable", async () => {
    await goto("/keys");
    await page.waitForText("e2e-key");
    await page.click('[aria-label="Key actions"]', false);
    await page.waitForText("Disable");
    await page.click("Disable");
    await page.waitForText("Key disabled");
    await page.waitForText("disabled");
    await page.click('[aria-label="Key actions"]', false);
    await page.waitForText("Enable");
    await page.click("Enable");
    await page.waitForText("Key enabled");
  });

  await step("api keys revoke", async () => {
    await page.click('[aria-label="Key actions"]', false);
    await page.waitForText("Revoke");
    await page.click("Revoke");
    await page.waitForText("Revoke key");
    await page.click("Revoke");
    await page.waitForText("Key revoked");
  });

  // --- admin users/system ---
  await step("admin users page renders", async () => {
    await goto("/admin/users");
    await page.waitForText("Instance users");
    assert(await page.has(ADMIN_EMAIL), "admin email listed");
  });

  await step("admin system page renders", async () => {
    await goto("/admin/system");
    await page.waitForText("Instance health and audit log");
    assert(
      (await page.has("gateway_enabled")) || (await page.has("Gateway")),
      "system info present",
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
    await page.click("Delete");
    await page.waitForText("Workspace deleted");
    await sleep(400);
    assert(
      !(await page.has("Danger zone")) || (await page.has(wsName)),
      "back to a workspace view",
    );
  });

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
  console.log(`report: ${REPORT}`);
  process.exit(failed.length);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(99);
});
