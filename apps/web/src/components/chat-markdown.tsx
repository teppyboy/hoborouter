import { Fragment, createElement, memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { renderMarkdownHtml } from "../lib/chat-markdown";
import { useT } from "../lib/i18n/t";

// Copy affordance strings; en/vi both required by LocaleEntry typing.
const COPY = {
  copy: { en: "Copy code", vi: "Sao chép mã" },
  copied: { en: "Copied", vi: "Đã sao chép" },
  copyFailed: { en: "Copy failed", vi: "Sao chép thất bại" },
} as const;

// Fenced-block wrapper: header (language label + copy button) is React-owned
// chrome — it is never part of the sanitized DOM produced by the engine, so
// model output cannot forge or style it. The sanitized <pre> is rendered as
// a child exactly as the sanitizer emitted it.
function CodeBlock({ lang, text, children }: { lang: string; text: string; children: ReactNode }) {
  const t = useT(COPY);
  const [state, setState] = useState<"idle" | "ok" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(id);
  }, [state]);
  const onCopy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => setState("ok"),
      () => setState("failed"),
    );
  };
  return (
    <div className="relative my-2 [&_pre]:mt-0! [&_pre]:mb-0!" data-code-block={lang || undefined}>
      <div className="flex items-center justify-end gap-1 pr-1">
        <span data-code-lang className="mr-auto font-mono text-xs text-muted-foreground">
          {lang}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={t("copy")}
          className="flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          {state === "ok" ? t("copied") : state === "failed" ? t("copyFailed") : t("copy")}
        </button>
      </div>
      {children}
    </div>
  );
}

// Fenced/indented code block detector over the SANITIZED tree: only blocks the
// engine kept survive here. text is the exact decoded code content (entities
// already resolved by DOMParser); the single trailing newline comes from the
// fence, not the code, so it is stripped like every mainstream markdown UI.
function codeBlockInfo(node: Node): { lang: string; text: string } | null {
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  if (el.tagName !== "PRE") return null;
  const code = el.querySelector("code");
  if (!code) return null;
  const raw = code.textContent ?? "";
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1] ?? "";
  return { lang, text };
}

// Chat message body rendered by the full markdown engine
// (lib/chat-markdown.ts: marked + DOMPurify). The sanitized HTML is parsed
// and converted to React elements, so no raw-HTML sink (innerHTML /
// dangerouslySetInnerHTML) exists: React escapes every text node, and only
// tags that survived the DOMPurify allowlist can become elements.

// Only attributes the sanitizer allowlist can emit are mapped; anything else
// on the sanitized DOM is dropped.
const ATTR_MAP: Record<string, (v: string) => [string, unknown]> = {
  href: (v) => ["href", v],
  title: (v) => ["title", v],
  target: (v) => ["target", v],
  rel: (v) => ["rel", v],
  type: (v) => ["type", v],
  class: (v) => ["className", v],
  colspan: (v) => ["colSpan", Number(v)],
  rowspan: (v) => ["rowSpan", Number(v)],
  align: (v) => ["align", v],
  checked: () => ["defaultChecked", true],
  disabled: () => ["disabled", true],
};

function toReact(node: Node, key: number): ReactNode {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const props: Record<string, unknown> = { key };
  for (const attr of el.attributes) {
    const map = ATTR_MAP[attr.name];
    if (map) {
      const [name, value] = map(attr.value);
      props[name] = value;
    }
  }
  const children: ReactNode[] = [];
  let i = 0;
  for (const child of el.childNodes) children.push(toReact(child, i++));
  return createElement(el.tagName.toLowerCase(), props, children.length ? children : undefined);
}

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  // useMemo recomputes parse + sanitize + DOM-tree conversion only when
  // content changes; combined with memo() this keeps completed messages from
  // re-parsing when a sibling message streams. (useMemo is a performance
  // hint, not an execution guarantee under StrictMode — recomputation is
  // idempotent and side-effect free, so a double run is harmless.)
  const nodes: ReactNode[] = useMemo(() => {
    const html = renderMarkdownHtml(content);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const tree: ReactNode[] = [];
    let i = 0;
    for (const child of parsed.body.childNodes) {
      const block = codeBlockInfo(child);
      if (block) {
        tree.push(
          <CodeBlock key={i++} lang={block.lang} text={block.text}>
            {toReact(child, 0)}
          </CodeBlock>,
        );
      } else {
        tree.push(toReact(child, i++));
      }
    }
    return tree;
  }, [content]);
  return (
    <div
      className={
        // Horizontal containment + typography for model output. Arbitrary
        // Tailwind variants style the engine's DOM from outside the sanitized
        // HTML (the HTML itself carries no styles).
        "wrap-anywhere overflow-x-auto " +
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold " +
        "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold " +
        "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold " +
        "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold " +
        "[&_p]:my-2 [&_p]:[overflow-wrap:anywhere] " +
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 " +
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 " +
        "[&_li]:my-0.5 " +
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
        "[&_em]:italic [&_strong]:font-semibold " +
        "[&_del]:text-muted-foreground [&_del]:line-through " +
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 " +
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] " +
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:whitespace-pre " +
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[0.85em] " +
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs " +
        "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold " +
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top " +
        "[&_hr]:my-3 [&_hr]:border-border " +
        "[&_input[type=checkbox]]:mr-1 [&_input[type=checkbox]]:align-middle"
      }
      data-streaming={streaming || undefined}
    >
      {nodes.length ? <Fragment>{nodes}</Fragment> : null}
    </div>
  );
});
