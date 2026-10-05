// Runnable benchmark for the chat markdown engine (marked + DOMPurify), run
// with: bun tests/chat-markdown-benchmark.ts
//
// Reports measured medians only — no comparisons against other engines, no
// fabricated numbers. There is no WASM in this engine (marked is pure JS), so
// "WASM load" and "wasm binary size" do not apply; module size is reported
// from the on-disk dist files instead.
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const win = new JSDOM().window as unknown as {
  document: object;
  Node: object;
  Element: object;
  DOMParser: unknown;
};
for (const [k, v] of Object.entries({
  window: win,
  document: win.document,
  Node: win.Node,
  Element: win.Element,
  DOMParser: win.DOMParser,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}

const { renderMarkdownHtml } = await import("../apps/web/src/lib/chat-markdown");

// marked is installed in apps/web (isolated install); parse-only benchmark
// borrows it via createRequire, typed with a minimal structural shim.
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const marked = webRequire("marked") as { parse: (src: string, opts: { async: false }) => string };

function parseOnly(md: string): string {
  return marked.parse(md, { async: false });
}

// --- realistic complex markdown generator ---------------------------------

function fence(lang: string, body: string): string {
  return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
}

const FENCE_BODIES = [
  '// update the gateway\nexport function route(req: Request): Response {\n  if (!req.headers.get("x-api-key")) {\n    throw new Error("missing key"); // 401\n  }\n  return new Response("ok");\n}',
  "SELECT id, balance FROM wallet /* snapshot read */\nWHERE user_id = $1\nORDER BY updated_at DESC\nLIMIT 10;",
  "const xs = [1, 2, 3].map((n) => n * n); // [1, 4, 9]\nif (xs.length > 2) {\n  console.log(xs.join(', '));\n}",
];

const TABLE_SECTIONS = [
  "| Model | Input $/M | Output $/M | Cached |\n|---|---|---|---|\n| alpha | 0.25 | 1.00 | yes |\n| beta | 0.50 | 2.00 | no |\n| gamma | 1.25 | 5.00 | no |",
  "| Region | Status | Latency p50 | Latency p99 |\n|---|---|---|---|\n| us-east | healthy | 42ms | 120ms |\n| eu-west | healthy | 55ms | 140ms |",
];

const LIST_SECTIONS = [
  "- **Auth**: hash stored, plaintext shown once\n  - rotate keys on demand\n  - audit log entries are append-only\n- **Billing**: integer VND only\n  1. reserve\n  2. settle\n  3. refund",
  "- [x] gateway streaming passthrough\n- [x] auth rejection tests\n- [ ] rate limiting per workspace\n- [ ] model restriction UI",
];

const PROSE = [
  "The **gateway** proxies requests to the upstream with _streaming_ support.\nParagraph text wraps across lines and `inline code` and ~~strikethrough~~\nappear mid-sentence. See [the docs](https://example.com/docs) or the [keys page](/keys).\n",
  "> Blockquote: never recompute history from current prices.\n> All customer money is integer VND.\n\n## Heading two\n\n### Heading three\n\n---\n",
];

function buildDoc(targetBytes: number): string {
  let parts: string[] = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetBytes) {
    const section = [
      PROSE[i % PROSE.length],
      TABLE_SECTIONS[i % TABLE_SECTIONS.length],
      fence(
        ["ts", "sql", "js"][i % 3] ?? "ts",
        FENCE_BODIES[i % FENCE_BODIES.length] ?? "const a = 1;",
      ),
      LIST_SECTIONS[i % LIST_SECTIONS.length],
    ].join("\n");
    parts.push(section);
    bytes += section.length;
    i++;
  }
  const doc = parts.join("\n");
  return doc.length > targetBytes ? doc.slice(0, targetBytes) : doc;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function bench(label: string, runs: number[], round = (n: number) => n.toFixed(3)) {
  console.log(
    `${label}: median=${round(median(runs))}ms min=${round(Math.min(...runs))}ms max=${round(Math.max(...runs))}ms n=${runs.length}`,
  );
}

// --- fixed-size documents -------------------------------------------------

const SMALL = buildDoc(10 * 1024);
const LARGE = buildDoc(100 * 1024);
console.log(`doc sizes: small=${SMALL.length}B large=${LARGE.length}B`);

// cache must not skew measurements: unique text per run (fresh salt per
// invocation so warm passes re-measure real work, not the bounded memo)
function freshSalt(): string {
  return Date.now().toString(36) + Math.random().toString(36);
}
function sizedRun(n: number, base: string, fn: (doc: string) => string): number[] {
  const salt = freshSalt();
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const doc = `${base}\n\n<!-- run ${salt}-${i} marker ${"x".repeat(20)} -->`;
    const t0 = performance.now();
    const out = fn(doc);
    times.push(performance.now() - t0);
    if (!out || out === doc) throw new Error(`unexpected output for run ${i}`);
  }
  return times;
}

// parser-only vs full pipeline (marked.parse vs marked.parse + DOMPurify)
bench("parser only 10KB (marked.parse)", sizedRun(30, SMALL, parseOnly));
bench("full engine 10KB (parse+sanitize)", sizedRun(30, SMALL, renderMarkdownHtml));
bench("parser only 100KB (marked.parse)", sizedRun(30, LARGE, parseOnly));
bench("full engine 100KB (parse+sanitize)", sizedRun(30, LARGE, renderMarkdownHtml));
bench("full engine 10KB warm (parse+sanitize)", sizedRun(100, SMALL, renderMarkdownHtml));

// --- growing stream: 100 updates ------------------------------------------

const CHUNKS = Array.from({ length: 100 }, (_, i) => {
  const section = [PROSE[i % PROSE.length], LIST_SECTIONS[i % LIST_SECTIONS.length]].join("\n");
  return `${section}\n`;
});
function streamRun(): number[] {
  let doc = `<!-- ${freshSalt()} -->\n`;
  const times: number[] = [];
  for (const chunk of CHUNKS) {
    doc += chunk;
    const t0 = performance.now();
    renderMarkdownHtml(doc);
    times.push(performance.now() - t0);
  }
  return times;
}
const coldStream = streamRun(); // cold: engine JIT + fresh strings
bench("stream grow cold, median per update (100 updates)", coldStream);
bench("stream grow warm, median per update (100 updates)", streamRun());
bench("stream update 100 total ms (cold)", [coldStream.reduce((a, b) => a + b, 0)], (n) =>
  n.toFixed(1),
);

// --- module size (no WASM in this engine) ---------------------------------

for (const name of ["marked", "dompurify"] as const) {
  try {
    const buf = readFileSync(webRequire.resolve(name));
    const gz = gzipSync(buf).length;
    console.log(
      `${name} dist entry: ${(buf.length / 1024).toFixed(1)}KB raw, ${(gz / 1024).toFixed(1)}KB gzipped (unminified dist; bundled output is smaller)`,
    );
  } catch {
    console.log(`${name}: (dist file not found)`);
  }
}
console.log("wasm load: n/a (marked is pure JS, no wasm binary, no async init)");
