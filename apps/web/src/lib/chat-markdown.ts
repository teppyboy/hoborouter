import { marked } from "marked";
import DOMPurify from "dompurify";
import type { DOMPurify as DOMPurifyInstance } from "dompurify";

// Chat markdown engine: full CommonMark/GFM parser (marked) with DOMPurify as
// the only HTML-safety boundary. Every HTML string consumed by
// components/chat-markdown.tsx comes from renderMarkdownHtml below — never
// from a caller.

marked.setOptions({ gfm: true, breaks: true });

// Remote images are blocked (no auto-fetch, no tracking pixels) but the alt
// text survives so model replies stay readable. Allowing remote fetches needs
// a product-level allowlist decision first.
marked.use({
  renderer: {
    image(token) {
      const alt = typeof token.text === "string" ? token.text : "";
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<span class="md-img-alt"${title}>[image: ${escapeHtml(alt)}]</span>`;
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Whitelist = exactly the tags marked itself emits for GFM (task-list
// checkboxes need input). Anything the model injects (script/svg/iframe/
// style/b/custom elements) is stripped. DOMPurify always removes event
// handlers; the href hook below pins link targets to http(s), root-relative,
// or fragment — javascript:/data:/vbscript://host are rejected. img is
// deliberately absent: images never fetch.
const ALLOWED_TAGS = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "em",
  "strong",
  "del",
  "code",
  "pre",
  "a",
  "hr",
  "span",
  "input",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];
const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: [
    "href",
    "title",
    "target",
    "rel",
    "type",
    "checked",
    "disabled",
    "colspan",
    "rowspan",
    "align",
    "class",
  ],
};

// DOMPurify binds to a window at instance creation, so the singleton is
// created lazily on first render (window exists then, both in the browser and
// in tests that install a DOM before rendering). The page origin is captured
// with it so href policy can resolve root-relative targets.
let purify: DOMPurifyInstance | null = null;
let boundOrigin = "";
function getPurify(): DOMPurifyInstance {
  if (!purify) {
    purify = DOMPurify(window);
    boundOrigin = window.location?.origin ?? "";
    purify.addHook("afterSanitizeAttributes", hardenLinks);
    purify.addHook("uponSanitizeAttribute", hrefPolicy);
    purify.addHook("uponSanitizeElement", denyRawInputs);
  }
  return purify;
}

// External http(s) links open in a new tab with noopener noreferrer;
// root-relative links stay same-tab.
function hardenLinks(node: Element) {
  if (node.nodeName !== "A") return;
  const href = node.getAttribute("href") ?? "";
  if (/^https?:/i.test(href)) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
}

// Href policy: http(s) absolute, same-origin root-relative (resolved through
// the URL constructor so backslash normalization — browsers treat "\\" as
// "/" — can never produce a protocol-relative off-origin target), or
// fragment. Control characters are rejected outright (browsers strip
// tab/CR/LF from URLs, enabling scheme bypasses like "java\tscript:").
// Everything else — javascript:, data:, vbscript:, //host — is stripped.
// DOMPurify's default URI regexp stays in charge of other attributes (it
// evaluates non-URI attribute values too, e.g. input type="checkbox").
function hrefPolicy(
  _node: Element,
  data: { attrName: string; attrValue: unknown; keepAttr: boolean },
) {
  if (data.attrName !== "href") return;
  const value = String(data.attrValue ?? "");
  // Explicit code-unit gate (no control-character regex class — Biome's
  // eslint(no-control-regex)): EXACTLY the original /\u0000-\u0020\u007F/
  // semantics — drop the href when ANY code unit is C0+space (0x00–0x20) or
  // DEL (0x7F). No widened Unicode classification: astral code units are all
  // > 0x7F and fall through untouched.
  let hasForbiddenCodeUnit = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) {
      hasForbiddenCodeUnit = true;
      break;
    }
  }
  if (hasForbiddenCodeUnit || value.includes("\\")) {
    data.keepAttr = false;
    return;
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("#")) return;
  if (value.startsWith("/") && boundOrigin) {
    try {
      if (new URL(value, boundOrigin).origin === boundOrigin) return;
    } catch {
      // fall through to rejection
    }
  }
  data.keepAttr = false;
}

// Raw model HTML inputs are denied: only GFM tasklist checkboxes survive
// (rendered disabled). Prevents model-inserted credential-phishing inputs
// (text/password/email/etc.) reaching the chat DOM.
function denyRawInputs(node: Node) {
  if (node.nodeName !== "INPUT") return;
  const el = node as Element;
  if ((el.getAttribute("type") ?? "").toLowerCase() !== "checkbox") {
    el.parentNode?.removeChild(el);
  }
}

// Fallback when the engine itself throws (never blank, never raw HTML): an
// explicit notice plus the original text HTML-escaped.
export function fallbackNoticeHtml(md: string): string {
  return `<p class="text-destructive">[markdown engine could not render this message; showing plain text]</p><p>${escapeHtml(md).replace(/\n/g, "<br>")}</p>`;
}

function parse(md: string): string {
  const parsed = marked.parse(md, { async: false });
  return typeof parsed === "string" ? parsed : "";
}

// Memoization lives in React (memo on the component, see
// components/chat-markdown.tsx), not here: this function is stateless.
export function renderMarkdownHtml(md: string): string {
  try {
    return getPurify().sanitize(parse(md), PURIFY_CONFIG) as string;
  } catch {
    return fallbackNoticeHtml(md);
  }
}
