// Safe-link regression: inline() must not render <a href> for untrusted
// model output piped through renderMarkdown (Chat). Only http(s) and
// same-origin relative paths may become anchors; everything else degrades
// to plain text.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../apps/web/src/pages/legal/legal-page";

function hrefs(md: string): string[] {
  const html = renderToStaticMarkup(<>{renderMarkdown(md)}</>);
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string);
}

test.each([
  ["[x](javascript:alert(1))", "javascript:alert(1)"],
  ["[x](JAVASCRIPT:alert(1))", "JAVASCRIPT:alert(1)"],
  ["[x](data:text/html,hi)", "data:text/html,hi"],
  ["[x](vbscript:msgbox)", "vbscript:msgbox"],
  ["[x](//evil.com)", "//evil.com"],
])("dangerous href %s never renders", (md, bad) => {
  const html = renderToStaticMarkup(<>{renderMarkdown(md)}</>);
  expect(hrefs(md)).not.toContain(bad);
  expect(html).not.toContain("<a ");
  expect(html).toContain("x");
});

test.each([
  ["[x](https://example.com)", "https://example.com"],
  ["[x](/keys)", "/keys"],
])("safe href %s keeps its anchor", (md, href) => {
  expect(hrefs(md)).toContain(href);
});

test("external links get noopener noreferrer and target=_blank", () => {
  const html = renderToStaticMarkup(<>{renderMarkdown("[x](https://example.com)")}</>);
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('target="_blank"');
});

test("legal page content still renders its links", () => {
  const html = renderToStaticMarkup(
    <>{renderMarkdown("See [docs](https://example.com/docs) and the [keys page](/keys).")}</>,
  );
  expect(html).toContain("https://example.com/docs");
  expect(html).toContain("/keys");
});
