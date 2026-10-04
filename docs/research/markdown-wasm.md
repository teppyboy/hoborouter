# markdown-wasm evaluation (research only)

Date: research pass at commit d3b0d3b. Authoritative output also mirrored to the
parent run's `selection.md`. Primary sources only: npm registry metadata,
GitHub repo metadata/issues, and the actual npm tarball contents (inspected,
not installed).

## Verdict

**Do not adopt `markdown-wasm`. Recommend `marked` + `dompurify` (one pinned
pair, exact versions below).** markdown-wasm is both stale (~4.5 years without
a release) and Vite-unusable without a serving hack (open, unfixed ESM browser
bug; no configurable wasm URL in the ESM build). The user requirement is "full
Markdown engine, preferably WASM" — WASM is a preference, and the task allows
exactly one ready-made browser alternative when markdown-wasm is stale or
Vite-unusable. Both conditions are met, so the alternative branch applies.

## markdown-wasm facts (verified, primary sources)

- Latest version: **1.2.0**, published **2021-07-01** —
  https://registry.npmjs.org/markdown-wasm (dist-tags.latest = 1.2.0).
- Last upstream commit: **2021-07-06** (readme) —
  https://api.github.com/repos/rsms/markdown-wasm/commits. Tags stop at
  `v1.2.0`; the repo has **no GitHub releases** at all
  (https://api.github.com/repos/rsms/markdown-wasm/releases → `[]`).
- **No security updates since 2021.** It bundles a 2020-era snapshot of the
  md4c C library compiled to WASM; no release channel exists to pick up md4c
  fixes.
- License: **MIT** (npm package.json `license` field).
- Package layout (from tarball `markdown-wasm-1.2.0.tgz`):
  - ESM: `dist/markdown.es.js` (`module`/`jsnext:main`)
  - legacy browser script: `dist/markdown.js` (`browser`)
  - node: `dist/markdown.node.js` (`main`)
  - types: **`markdown.d.ts` at package root** (`typings` field), not in `dist/`
  - wasm binary: `dist/markdown.wasm` (fetched at runtime in the browser)
- API (from `markdown.d.ts` + `dist/markdown.es.js`):
  - `export const ready: Promise<...>` — module init is async; **`parse()` is
    synchronous only after `await ready`**.
  - `export function parse(s, o?) : string` (or `Uint8Array` with `bytes:true`).
  - `export enum ParseFlags` — verified from the ES bundle's flag table:
    `DEFAULT = 2823` =
    COLLAPSE_WHITESPACE(1) | PERMISSIVE_ATX_HEADERS(2) |
    PERMISSIVE_URL_AUTO_LINKS(4) | TABLES(256) | STRIKETHROUGH(512) |
    TASK_LISTS(2048) — i.e. **DEFAULT includes strikethrough, tables,
    tasklists**, matching the parent-provided facts. `NO_HTML = 96`
    (NO_HTML_BLOCKS 32 | NO_HTML_SPANS 64) disables raw HTML blocks/spans.
  - `allowJSURIs` option defaults to **false** → `javascript:` link targets
    are rejected at the parser level by default. (Still sanitize; see below.)
- **Why it breaks under Vite (verified in `dist/markdown.es.js`):** the wasm
  filename is the hardcoded string `"markdown.wasm"`, resolved as
  `locateFile ? locateFile(x, base) : base + x` where the browser `base` comes
  from `document.currentScript.src`. Under ESM (`import`), `currentScript` is
  null → base is `""` → the browser fetches `<page-root>/markdown.wasm`, which
  Vite does not emit. The ESM exports are only `{ ready, ParseFlags, parse }` —
  **there is no public `wasmURL`/`wasmBinary`/`locateFile` override** in the
  ESM build.
  - Open, unfixed: https://github.com/rsms/markdown-wasm/issues/26
    "ESM loading fails in the browser" (opened 2024-08-11).
  - https://github.com/rsms/markdown-wasm/issues/23 "How to explicitly specify
    the location of markdown.wasm?" closed without an upstream option; the
    reporter rolled their own component.
  - The only workaround is copying `markdown.wasm` into Vite's `public/` so the
    page-root URL resolves — fragile under base-path changes and offline
    packaging, and it pins a 2021 binary.

## Alternative considered (one, per scope): `marked` + `dompurify`

- `marked` **18.0.14**, published 2026-09-22, MIT, **zero dependencies**,
  engines node >= 20 — https://registry.npmjs.org/marked. Fully synchronous,
  plain ESM/UMD JS, no wasm, no asset URL config: works identically in browser,
  Vite build, SSR (`renderToStaticMarkup` pipeline) and native `bun test`.
  GFM mode (default) covers tables, strikethrough, task lists — same feature
  set as markdown-wasm DEFAULT.
- `dompurify` **3.4.16**, published 2026-09-23, license `MPL-2.0 OR Apache-2.0`,
  zero dependencies — https://registry.npmjs.org/dompurify. Required **in
  addition regardless of engine**: markdown-wasm's `NO_HTML` only disables raw
  HTML; neither engine sanitizes output. Explicit dependency, authorized.
  Never treat the WASM memory sandbox as an HTML-safety boundary.

## Recommended pins (exact)

```jsonc
// apps/web dependencies (or tests workspace for jsdom only)
"marked": "18.0.14",      // exact pin, no ^
"dompurify": "3.4.16",    // exact pin
// devDependencies of tests/ workspace (DOMPurify under bun test needs a DOM):
"jsdom": "30.1.1"         // engines node ^22.22.2 || ^24.15.0 || >=26 (Bun ≥1.2 satisfies)
```

## Browser load pattern (Vite, singletons, memoization)

```ts
// apps/web/src/lib/markdown.ts  (new file, only file importing both deps)
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true }); // full engine, GFM default

// Safe links: http(s) absolute or root-relative only; block
// javascript:/data:/vbscript:/protocol-relative. Images are removed entirely
// (no tracking autofetch) until a product decision defines an allowlist.
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attr !== "href") return;
  const v = data.keepAttr ? String(data.attrValue) : "";
  const safe = /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//"));
  if (!safe) { node.removeAttribute("href"); data.keepAttr = false; }
});
const PURIFY = { FORBID_TAGS: ["img", "style", "iframe", "form"], FORBID_ATTR: ["style"], ALLOWED_URI_REGEXP: /^https?:/i };

const cache = new Map<string, string>(); // memoize completed messages
export function renderMarkdown(md: string, memoKey?: string): string {
  if (memoKey && cache.has(memoKey)) return cache.get(memoKey)!;
  const html = DOMPurify.sanitize(marked.parse(md, { async: false }) as string, PURIFY);
  if (memoKey && cache.size < 500) cache.set(memoKey, html); // bounded
  return html;
}
```

- `marked.parse(..., { async: false })` is synchronous — no async init, no
  `ready` await, streaming-safe (unclosed fences render as code blocks).
- No WASM, so no init-once lifecycle to manage; module import is the singleton.
- Set `DOMPurify` hooks once at module load (init-once equivalent).
- Current hand-rolled `renderMarkdown` in
  `apps/web/src/pages/legal/legal-page.tsx:49` (159-line subset renderer) is
  the replacement target; `tests/chat-markdown.test.tsx` and
  `tests/markdown-safe-links.test.tsx` already encode the safety contract and
  must keep passing (they will need the import path to stay stable or be
  repointed by the implementation agent, not by this research pass).

## SSR / Bun-test strategy

- **Engine (marked):** pure JS, sync — tests run in native Bun with no DOM and
  no await. `renderToStaticMarkup` + string assertions match the existing
  test style in `tests/chat-markdown.test.tsx`.
- **DOMPurify:** requires a `window`. Under `bun test`, build one from jsdom:
  ```ts
  import { JSDOM } from "jsdom";
  import createDOMPurify from "dompurify";
  const purify = createDOMPurify(new JSDOM("").window);
  ```
  Either instantiate per test file or register a global DOM
  (`@happy-dom/global-registrator`); jsdom is the DOMPurify-documented option.
  No browser needed; no wasm await needed (this is the main test-strategy win
  over markdown-wasm, whose Bun test would have to `await realWASM ready` and
  shim the node/browser detection).
- **Benchmark (runnable, measured, no fabricated speedup):**
  `tests/markdown-bench.test.ts` should parse a realistic ~2–5 KB assistant
  reply (fences, table, list, inline code) N=1000 with `performance.now()`
  around `renderMarkdown`, then `console.log` mean/p50/p99 ms. Assertions only
  on "completed without error + output non-empty + identical output for
  cached vs uncached first input" — never assert a speedup number vs another
  engine (nothing to compare against once markdown-wasm is rejected).

## Offline asset packaging / perf / security tradeoffs

- **marked + DOMPurify:** both bundle into the Vite JS output; zero runtime
  network fetches; fully offline after install. Added gzipped weight ≈ tens of
  KB (marked ~35 KB min.gz class + DOMPurify ~22 KB min.gz class — measure with
  `vp build` output, do not trust these numbers as spec).
- **markdown-wasm (rejected):** wasm binary ~100 KB must be served as a
  separate asset (public/ copy under Vite), async init (`await ready`), plus
  the fragility above. Its parse speed advantage exists but was never measured
  here and does not justify the supply-chain freeze.
- **Security:** sanitization boundary is DOMPurify only. Link policy
  (http(s)/root-relative, block `javascript:`/`data:`/protocol-relative) is
  enforced by the hook above + `ALLOWED_URI_REGEXP`; existing regression tests
  in `tests/markdown-safe-links.test.tsx` cover the contract. Images are
  hard-forbidden by default (no tracking autofetch) until explicitly defined.
- **Supply chain:** two small, actively maintained, zero-dependency packages
  pinned exact, vs one 4.5-year-frozen package shipping a prebuilt 2021 binary.

## Open items for the parent

1. Exact-version pins above are this pass's recommendation; the dependency
   install must preserve the owner's dirty lockfile changes byte-for-byte
   (read-before-edit; stage explicit paths only).
2. Image policy (currently hard-forbidden) needs a product decision before any
   allowlist is added.
3. No automatic quarter/year discount feature and no rolling-window limits are
   approved — see `docs/research/xkiro-pricing-reference.md`.
