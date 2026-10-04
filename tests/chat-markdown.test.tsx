// renderMarkdown SSR regression: fenced code blocks (chat replies) must
// render as pre/code with exact text and newlines, survive an unclosed fence
// (still-streaming reply), never inject HTML, and keep headings/lists working.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { renderMarkdown } = await import("../apps/web/src/pages/legal/legal-page");

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

test("fenced code block renders pre/code with exact code text and newlines", () => {
  const out = html("Before\n```typescript\nconst a = 1;\nif (a) {\n  console.log(a);\n}\n```\nAfter");
  expect(out).toContain("<pre");
  expect(out).toContain("<code>");
  // Newlines and indentation survive verbatim; the fence lines themselves
  // are consumed.
  expect(out).toContain("const a = 1;\nif (a) {\n  console.log(a);\n}");
  expect(out).not.toContain("```");
  expect(out).toContain("Before");
  expect(out).toContain("After");
});

test("unclosed fence while streaming still renders as a code block", () => {
  const out = html("```ts\nlet x = 1;\nx++;");
  expect(out).toContain("<pre");
  expect(out).toContain("let x = 1;\nx++;");
  expect(out).not.toContain("```");
});

test("HTML inside a code block is escaped, not injected", () => {
  const out = html("```\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n```");
  expect(out).not.toContain("<script>");
  expect(out).not.toContain("<img ");
  expect(out).toContain("&lt;script&gt;");
});

test("inline HTML outside code is still escaped as plain text", () => {
  const out = html("<b>bold</b>");
  expect(out).not.toContain("<b>bold</b>");
  expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
});

test("headings and lists still render alongside fenced blocks", () => {
  const out = html("## Title\n\n- one\n- two\n\n```\ncode line\n```\n\n1. first\n2. second");
  expect(out).toContain("<h3");
  expect(out).toContain("Title");
  expect(out).toContain("<ul");
  expect(out).toContain("<li>one</li>");
  expect(out).toContain("<ol");
  expect(out).toContain("<li>first</li>");
  expect(out).toContain("code line");
});

test("legal-page basics unchanged: paragraphs, bold, links, blockquote", () => {
  const out = html(
    "Plain **bold** text.\n\n[Docs](https://example.com) link.\n\n> quoted line",
  );
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain('href="https://example.com"');
  expect(out).toContain("<blockquote");
  expect(out).toContain("quoted line");
});
