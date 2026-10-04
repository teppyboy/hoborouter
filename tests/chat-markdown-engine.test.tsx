// Chat markdown engine (marked + DOMPurify): real parser, real sanitizer.
// No mocks: tests run the actual engine. DOMPurify needs a DOM; jsdom (the
// DOMPurify-documented option; happy-dom silently fails its removeChild under
// DOMPurify) is a devDependency of the tests workspace and installed as the
// global before the engine module is imported.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

// Globals the engine needs (DOMPurify/DOMParser bind to these). Original
// property descriptors are captured and restored in afterAll so running this
// file before/after other chat test files in the same process cannot break
// their authoring environment.
const GLOBAL_KEYS = ["window", "document", "Node", "Element", "DOMParser"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

beforeAll(() => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    Node: object;
    Element: object;
    DOMParser: unknown;
    close: () => void;
  };
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    Node: win.Node,
    Element: win.Element,
    DOMParser: win.DOMParser,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
});

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const { ChatMarkdown } = await import("../apps/web/src/components/chat-markdown");
const { renderMarkdownHtml, fallbackNoticeHtml } = await import("../apps/web/src/lib/chat-markdown");

const html = (md: string) => renderToStaticMarkup(<ChatMarkdown content={md} />);

// --- GFM structure -------------------------------------------------------

test("GFM table renders header and body rows", () => {
  const out = html("| a | b |\n|---|---|\n| 1 | 2 |");
  expect(out).toContain("<table");
  expect(out).toContain("<th");
  expect(out).toContain("<td");
  expect(out).toContain(">1</td>");
});

test("nested unordered list renders inner ul inside li", () => {
  const out = html("- one\n  - inner\n- two");
  expect(out).toContain("<ul");
  expect(out).toContain("<li>one<ul");
  expect(out).toContain("<li>inner</li>");
});

test("nested emphasis: bold containing em", () => {
  const out = html("**bold *inner* end**");
  expect(out).toContain("<strong");
  expect(out).toContain("<em>inner</em>");
});

test("underscore emphasis and strong", () => {
  const out = html("_em_ and __strong__");
  expect(out).toContain("<em>em</em>");
  expect(out).toContain("<strong>strong</strong>");
});

test("strikethrough renders del", () => {
  const out = html("~~gone~~");
  expect(out).toContain("<del>gone</del>");
});

test("task list renders disabled checkboxes", () => {
  const out = html("- [x] done\n- [ ] todo");
  expect(out).toContain('type="checkbox"');
  expect(out).toContain("done");
  expect(out).toContain("todo");
});

test("checkbox is not focusable (disabled attribute present)", () => {
  const out = html("- [x] done");
  expect(out).toContain("disabled");
});

// --- fenced code fidelity ------------------------------------------------

test("fenced code preserves // comments exactly", () => {
  const out = html("```\n// keep me\nconst a = 1; // trailing\n```");
  expect(out).toContain("// keep me");
  expect(out).toContain("// trailing");
});

test("multiline fenced code keeps newlines verbatim", () => {
  const out = html("```ts\nline1\n\nline3\n```");
  expect(out).toContain("line1\n\nline3");
});

test("unclosed fence (streaming) still renders a code block", () => {
  const out = html("```js\nlet x = 1;\nx++;");
  expect(out).toContain("<pre");
  expect(out).toContain("let x = 1;\nx++;");
});

test("HTML inside a code fence is escaped, not injected", () => {
  const out = html("```\n<script>alert(1)</script>\n```");
  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;script&gt;");
});

test("single newline becomes a line break (breaks mode)", () => {
  const out = html("first\nsecond");
  expect(out).toContain("<br");
});

// --- sanitizer: raw HTML, handlers, dangerous URIs, images ---------------

test("script tag is fully removed including its contents", () => {
  const out = html("before <script>alert(1)</script> after");
  expect(out).not.toContain("<script");
  expect(out).not.toContain("alert(1)");
  expect(out).toContain("before");
  expect(out).toContain("after");
});

test("event handler attributes never render", () => {
  const out = html('<div onmouseover="alert(1)">hover</div>');
  expect(out).not.toContain("onmouseover");
  expect(out).not.toContain("alert(1)"); // attribute value must go, even as text of a kept attr
});

test("svg and iframe are stripped", () => {
  const out = html("<svg><circle/></svg><iframe src=\"https://evil.example\"></iframe>");
  expect(out).not.toContain("<svg");
  expect(out).not.toContain("<iframe");
});

test("javascript: and data: and protocol-relative links never become anchors", () => {
  for (const md of [
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "[x](vbscript:msgbox)",
    "[x](//evil.example)",
  ]) {
    const out = html(md);
    expect(out).not.toContain("<a ");
    expect(out).toContain("x");
  }
});

test("safe http(s) and root-relative links keep their anchors", () => {
  const out = html("[ext](https://example.com) [int](/keys)");
  expect(out).toContain('href="https://example.com"');
  expect(out).toContain('href="/keys"');
});

test("external links get target=_blank and noopener noreferrer", () => {
  const out = html("[x](https://example.com)");
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
});

test("root-relative link stays same-tab (no target=_blank)", () => {
  const out = html("[x](/keys)");
  expect(out).not.toContain('target="_blank"');
});

test("images never fetch: no <img>, no src, alt text preserved", () => {
  const out = html("![cat photo](https://evil.example/track.png)");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("evil.example/track.png");
  expect(out).toContain("cat photo");
});

test("data-URI image is blocked and alt preserved", () => {
  const out = html("![alt text](data:image/png;base64,AAAA)");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("data:image");
  expect(out).toContain("alt text");
});

test("blockquote renders with quoted content", () => {
  const out = html("> quoted line\n> second line");
  expect(out).toContain("<blockquote");
  expect(out).toContain("quoted line");
});

test("ordered list renders ol with li items", () => {
  const out = html("1. first\n2. second\n3. third");
  expect(out).toContain("<ol");
  expect(out).toContain("<li>first</li>");
  expect(out).toContain("<li>third</li>");
});

test("autolinked bare URL becomes a safe anchor", () => {
  const out = html("see <https://example.com/docs> now");
  expect(out).toContain('href="https://example.com/docs"');
  expect(out).toContain('rel="noopener noreferrer"');
});

test("backslash root-relative link never becomes an off-origin anchor", () => {
  // Browsers normalize literal "\\" to "/" in URLs, so a literal
  // "/\\evil.example" href would resolve to "//evil.example" (protocol-
  // relative, off-origin) — the href policy rejects any literal backslash.
  // marked percent-encodes the backslash, and %5C is NOT a separator in
  // browsers, so "/%5Cevil.example" is an ordinary same-origin path.
  const out = html("[x](/\\\\evil.example)");
  expect(out).not.toContain('href="//evil.example');
  expect(out).not.toContain('href="\\\\evil.example');
  expect(out).toContain('href="/%5Cevil.example"');
  expect(out).toContain("x");
});

test("control characters cannot smuggle a link scheme", () => {
  // Browsers strip tab/CR/LF from URLs. A tab inside a bare markdown
  // destination is not a link at all (literal text, safe); an angle-form
  // destination does parse into an anchor, and the sanitizer must reject the
  // tab-bearing href.
  expect(html("[x](java\tscript:alert(1))")).not.toContain("<a ");
  const angle = html("[x](<java\tscript:alert(1)>)");
  expect(angle).not.toContain("<a ");
  expect(angle).toContain("x");
});

test("whitespace-padded and encoded-scheme hrefs stay non-anchors", () => {
  for (const md of ["[x]( javascript:alert(1))", "[x](jav\u0000ascript:alert(1))"]) {
    const out = html(md);
    expect(out).not.toContain("<a ");
    expect(out).toContain("x");
  }
});

test("fragment and uppercase-HTTP hrefs survive", () => {
  const frag = html("[x](#section)");
  expect(frag).toContain('href="#section"');
  const upper = html("[x](HTTP://EXAMPLE.COM)");
  expect(upper).toContain('href="HTTP://EXAMPLE.COM"');
});

test("raw model inputs are denied; only GFM tasklist checkboxes survive", () => {
  for (const md of ['<input type="password" name="pw">', '<input type="text" value="enter password">', "<input>"]) {
    const out = html(md);
    expect(out).not.toContain("<input");
  }
  const task = html("- [x] ok");
  expect(task).toContain('type="checkbox"');
  expect(task).toContain("disabled");
});

// --- robustness ----------------------------------------------------------

test("engine never returns blank output", () => {
  const out = html("plain text only");
  expect(out.length).toBeGreaterThan(0);
  expect(out).toContain("plain text only");
});

test("fallback: sanitize failure yields explicit notice plus escaped plaintext, not blank", () => {
  // fallbackNoticeHtml is the exact catch-path output: a notice and the
  // escaped original text, never blank, never raw HTML.
  const fallback = fallbackNoticeHtml("<img src=x onerror=alert(1)>boom");
  expect(fallback).toContain("boom");
  expect(fallback).not.toContain("<img");
  expect(fallback.toLowerCase()).toContain("could not render");
});

test("renderMarkdownHtml output is a string of sanitized HTML", () => {
  expect(typeof renderMarkdownHtml("**b**")).toBe("string");
  expect(renderMarkdownHtml("**b**")).toContain("<strong>b</strong>");
});
