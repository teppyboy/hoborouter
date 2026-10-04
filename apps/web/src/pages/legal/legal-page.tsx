import { Link } from "@tanstack/react-router";
import { Shuffle } from "lucide-react";
import { ThemeToggle } from "../../components/theme-toggle";

// Renders a small, safe subset of inline markdown: links, bold, code.
function inline(text: string, keyBase: string) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      // Untrusted markdown (Chat pipes model output here): only http(s) and
      // same-origin relative paths may become anchors. "//host" is protocol-relative
      // and can point off-origin, so it is excluded.
      const href = m[2] ?? "";
      const safe = /^(https?:\/\/|\/(?!\/))/.test(href);
      parts.push(
        safe ? (
          <a key={`${keyBase}-${i++}`} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel={href.startsWith("/") ? undefined : "noopener noreferrer"} className="text-primary underline underline-offset-2">
            {m[1]}
          </a>
        ) : (
          <span key={`${keyBase}-${i++}`} className="text-primary underline underline-offset-2">{m[1]}</span>
        ),
      );
    } else if (m[3] !== undefined) {
      parts.push(<strong key={`${keyBase}-${i++}`}>{m[3]}</strong>);
    } else if (m[5] !== undefined) {
      // Single-asterisk emphasis, checked after links/bold/code so it never
      // matches inside a link target/label, bold, or inline code. Unterminated
      // markers simply stay literal (streaming-safe).
      parts.push(<em key={`${keyBase}-${i++}`}>{m[5]}</em>);
    } else {
      parts.push(<code key={`${keyBase}-${i++}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[4]}</code>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");

/** Tiny safe markdown renderer: headings, paragraphs, lists, blockquotes, bold, links, code. No HTML injection. */
export function renderMarkdown(md: string) {
  // Strip HTML comments (including multi-line) so malformed comment syntax can never leak into rendered text.
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--|-->/g, "").split("\n");
  const at = (n: number): string => lines[n] ?? "";
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = at(i);
    if (line.startsWith("```")) {
      // Fenced code block: ``` with optional language, until a closing fence
      // or end of text (a still-streaming reply may not have closed yet).
      // Content renders as a raw text node — no inline markdown, no HTML.
      const buf: string[] = [];
      i++;
      while (i < lines.length && !at(i).startsWith("```")) buf.push(at(i++));
      if (i < lines.length) i++; // consume the closing fence
      out.push(
        <pre key={k++} className="my-3 max-w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm leading-6">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#+\s*/, "");
      const id = slug(text);
      const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4";
      out.push(
        <Tag key={k++} id={id} className={level <= 2 ? "mt-8 scroll-mt-8 text-xl font-semibold" : "mt-6 scroll-mt-8 text-base font-semibold"}>
          {inline(text, `h${k}`)}
        </Tag>,
      );
      i++;
    } else if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(at(i))) items.push(at(i++).replace(/^[-*]\s*/, ""));
      out.push(
        <ul key={k++} className="my-3 list-disc space-y-1 pl-6">
          {items.map((it, j) => <li key={j}>{inline(it, `l${k}-${j}`)}</li>)}
        </ul>,
      );
    } else if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(at(i))) items.push(at(i++).replace(/^\d+\.\s*/, ""));
      out.push(
        <ol key={k++} className="my-3 list-decimal space-y-1 pl-6">
          {items.map((it, j) => <li key={j}>{inline(it, `o${k}-${j}`)}</li>)}
        </ol>,
      );
    } else if (line.startsWith(">")) {
      out.push(
        <blockquote key={k++} className="my-4 border-l-2 border-border pl-4 text-sm text-muted-foreground">
          {inline(line.replace(/^>\s*/, ""), `q${k}`)}
        </blockquote>,
      );
      i++;
    } else if (line.trim() === "" || line.startsWith("  ") || line.startsWith("**Operator:**") || line.startsWith("**Contact:**") || line.startsWith("**Effective date:**")) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && at(i).trim() !== "" && !/^([#>-]|\d+\.\s|```)/.test(at(i))) para.push(at(i++));
      out.push(<p key={k++} className="my-3 leading-7">{inline(para.join(" "), `p${k}`)}</p>);
    }
  }
  return out;
}

export function LegalPage({ title, md }: { title: string; md: string }) {
  const content = md;
  const headings = content
    .split("\n")
    .filter((l) => /^##\s/.test(l))
    .map((l) => ({ id: slug(l.replace(/^##\s*/, "")), text: l.replace(/^##\s*/, "") }));
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-prose px-6 py-10">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <Shuffle className="size-5 shrink-0" aria-hidden />
            <span className="text-lg font-bold tracking-tight">Hoborouter</span>
          </Link>
          <ThemeToggle />
        </div>
        <h1 className="mt-6 text-3xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated: 2026-10-02</p>
        {headings.length > 0 && (
          <nav className="mt-6 rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium">On this page</p>
            <ul className="space-y-1">
              {headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className="text-muted-foreground hover:text-foreground">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article>{renderMarkdown(content)}</article>
        <footer className="mt-12 border-t pt-4 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground">Hoborouter</Link>
          {" · "}
          <Link to="/terms" className="hover:text-foreground">Terms</Link>
          {" · "}
          <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
        </footer>
      </div>
    </div>
  );
}
