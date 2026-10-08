// Public quickstart: real, copy-pasteable curl / OpenAI SDK (Python, JS)
// snippets against the instance's configured base URL. Snippets are plain
// strings rendered as text (React escapes them; no dangerouslySetInnerHTML)
// and interpolated values are escaped for their target language, so a
// hostile admin-configured base URL can't break out of the snippet string.
// Only YOUR_API_KEY appears as a key placeholder — real keys are never shown.
import { PageHeader, CopyButton } from "../../components/page";
import { PublicLayout } from "../../components/public-layout";
import { Card, CardContent } from "../../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { usePublicCatalog, usePublicInstance, type PublicInstance } from "../../lib/public-queries";
import { useT } from "../../lib/i18n/t";

// Quickstart copy: inline LocaleEntry set (see lib/i18n/common.ts). Code
// snippets, language names (curl/Python/JavaScript) and literal tokens stay
// verbatim — only the prose around them is translated.
const quickstartCopy = {
  title: { en: "Quickstart", vi: "Hướng dẫn nhanh" },
  description: {
    en: "Make your first request through the OpenAI-compatible gateway.",
    vi: "Gửi request đầu tiên qua cổng API tương thích OpenAI.",
  },
  step1Title: { en: "1. Create an account and top up", vi: "1. Tạo tài khoản và nạp tín dụng" },
  signUp: { en: "Sign up", vi: "Đăng ký" },
  andSignIn: { en: "and sign in.", vi: "và đăng nhập." },
  step1TopUp: {
    en: "Top up credits in Billing → Credits by QR (PayOS) or manual confirmation.",
    vi: "Nạp tín dụng tại Nạp tín dụng → Credits bằng QR (PayOS) hoặc xác nhận thủ công.",
  },
  step1ApiKey: {
    en: "Create an API key under API Keys. It is shown once — store it safely.",
    vi: "Tạo API key trong API Keys. Key chỉ hiển thị một lần — hãy lưu an toàn.",
  },
  step1Model: {
    en: "Pick a model id from the pricing page, e.g.",
    vi: "Chọn một model id tại trang bảng giá, ví dụ:",
  },
  step2Title: { en: "2. Call the API", vi: "2. Gọi API" },
  step2SdkLead: {
    en: "Any OpenAI SDK works: set the base URL to",
    vi: "Bất kỳ SDK OpenAI nào cũng dùng được: đặt base URL thành",
  },
  step2SdkTail: { en: "and use your API key.", vi: "và dùng API key của bạn." },
  copyExample: { en: "Copy {lang} example", vi: "Copy ví dụ {lang}" },
  exampleAria: { en: "{lang} example", vi: "ví dụ {lang}" },
  streamingLead: {
    en: "Responses follow the OpenAI chat-completions schema. Streaming is supported with",
    vi: "Phản hồi theo schema chat-completions của OpenAI. Hỗ trợ streaming với",
  },
  streamingTail: { en: ".", vi: "." },
  agentTitle: {
    en: "3. Connect your coding agent",
    vi: "3. Kết nối coding agent của bạn",
  },
  sdkTabsAria: { en: "Request examples", vi: "Ví dụ gọi API" },
  agentTabsAria: { en: "Coding agent clients", vi: "Các coding agent" },
  agentCodexLead: {
    en: "Codex reads providers from the user-level ~/.codex/config.toml:",
    vi: "Codex đọc provider từ file user-level ~/.codex/config.toml:",
  },
  agentOpencodeLead: {
    en: "OpenCode reads opencode.json from your project root:",
    vi: "OpenCode đọc opencode.json ở thư mục gốc dự án:",
  },
  agentPiLead: {
    en: "pi reads ~/.pi/agent/models.json (run /model afterwards to reload):",
    vi: "pi đọc ~/.pi/agent/models.json (chạy /model sau đó để nạp lại):",
  },
  agentNote: {
    en: 'Use the same API key: set HBR_API_KEY once in your shell with export HBR_API_KEY="YOUR_API_KEY". The snippets below reference the variable — no client shows the key itself.',
    vi: 'Dùng cùng một API key: đặt HBR_API_KEY một lần trong shell bằng export HBR_API_KEY="YOUR_API_KEY". Các đoạn cấu hình dưới đây chỉ tham chiếu biến — không client nào hiển thị key.',
  },
  agentCodexDocs: { en: "Codex config reference", vi: "Codex config reference" },
  agentOpencodeDocs: { en: "OpenCode providers docs", vi: "Tài liệu providers của OpenCode" },
  agentPiDocs: { en: "pi model catalog", vi: "Danh mục model của pi" },
  agentClaudeLead: {
    en: "Claude Code is not yet supported: it requires the Anthropic Messages API (/v1/messages), which this gateway does not serve yet. Use Codex, OpenCode, or pi with the OpenAI-compatible endpoint above — watch this page for updates.",
    vi: "Claude Code chưa được hỗ trợ: nó cần Anthropic Messages API (/v1/messages), mà cổng API này chưa phục vụ. Hãy dùng Codex, OpenCode hoặc pi với endpoint tương thích OpenAI ở trên — theo dõi trang này để cập nhật.",
  },
  agentExampleAria: { en: "{lang} config example", vi: "ví dụ cấu hình {lang}" },
  agentCopyExample: { en: "Copy {lang} config", vi: "Copy cấu hình {lang}" },
} as const;

// No line breaks in interpolated values: a newline in the base URL or model id
// would inject a new shell statement / break the snippet layout.
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ");
// Escape for a shell double-quoted string (the curl URL argument):
// backslash, double quote, dollar and backtick would otherwise terminate or
// expand inside "...".
const escapeShellDq = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
// Escape for a double-quoted string in Python/JS.
const escapeDq = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Normalize the admin-configured base URL so "/v1" is appended exactly once:
// strip trailing slashes, then a trailing "/v1" (it is re-appended at every
// use site). The admin config may or may not include the suffix
// (trustedBaseUrl() passes BETTER_AUTH_URL/HBR_BASE_URL through raw), so both
// SDK snippets and agent config snippets must go through this.
const normalizeBase = (s: string) => oneLine(s).replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * The three quickstart snippets for a base URL + model id. Exported for tests:
 * Radix Tabs renders only the active tab in SSR, so the Python/JS bodies are
 * asserted on these strings directly. The JSON body is built with
 * JSON.stringify so any value is safely embedded; the URL/model values are
 * escaped per language before interpolation.
 */
export function buildSnippets(baseUrl: string, model: string) {
  const normalized = normalizeBase(baseUrl);
  const url = `${normalized}/v1/chat/completions`;
  const safeModel = oneLine(model);

  const body = JSON.stringify(
    { model: safeModel, messages: [{ role: "user", content: "Hello!" }] },
    null,
    4,
  )
    // Keep the JSON on the -d '...' continuation lines.
    .split("\n")
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join("\n");

  const curl = [
    `curl "${escapeShellDq(url)}" \\`,
    `  -H "Authorization: Bearer YOUR_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join("\n");

  const python = [
    `from openai import OpenAI`,
    ``,
    `client = OpenAI(`,
    `    api_key="YOUR_API_KEY",`,
    `    base_url="${escapeDq(normalized)}/v1",`,
    `)`,
    ``,
    `response = client.chat.completions.create(`,
    `    model="${escapeDq(safeModel)}",`,
    `    messages=[{"role": "user", "content": "Hello!"}],`,
    `)`,
    `print(response.choices[0].message.content)`,
  ].join("\n");

  const js = [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({`,
    `  apiKey: "YOUR_API_KEY",`,
    `  baseURL: "${escapeDq(normalized)}/v1",`,
    `});`,
    ``,
    `const response = await client.chat.completions.create({`,
    `  model: "${escapeDq(safeModel)}",`,
    `  messages: [{ role: "user", content: "Hello!" }],`,
    `});`,
    `console.log(response.choices[0].message.content);`,
  ].join("\n");

  return { curl, python, js };
}

// Escape for a TOML basic (double-quoted) string: backslash and quote would
// otherwise terminate the string, and raw control characters (including tab)
// are forbidden in TOML basic strings.
const escapeTomlDq = (s: string) =>
  oneLine(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // TOML basic strings forbid raw control characters; escape them per the
    // TOML spec (\t, other C0/del as \uXXXX). Char map avoids a control-char
    // regex (lint no-control-regex).
    .split("")
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code < 32 || code === 127) {
        return c === "\t" ? "\\t" : "\\u" + code.toString(16).padStart(4, "0");
      }
      return c;
    })
    .join("");

/**
 * Coding-agent config snippets (Codex / OpenCode / pi) for a base URL +
 * model id. Exported for tests: Radix Tabs renders only the active tab in
 * SSR. JSON snippets are built with JSON.stringify so any value is safely
 * embedded; TOML values go through escapeTomlDq. Keys are only ever
 * referenced by the HBR_API_KEY environment variable — never rendered.
 *
 * Wire facts (do not invent fields):
 * - Codex: user-level ~/.codex/config.toml; project config ignores
 *   model_providers. `wire_api` omitted — `responses` is the documented
 *   default and the gateway serves /v1/responses.
 * - OpenCode: `npm: "@ai-sdk/openai-compatible"` with the documented
 *   `{env:VAR}` interpolation in provider options (no literal key).
 * - pi: ~/.pi/agent/models.json, `api: "openai-completions"`; the key option
 *   supports `$NAME`/`${NAME}` env interpolation per the installed pi docs.
 */
export function buildAgentConfigSnippets(baseUrl: string, model: string) {
  const safeUrl = `${normalizeBase(baseUrl)}/v1`;
  const safeModel = oneLine(model);

  const codex = [
    `# ~/.codex/config.toml`,
    `model = "${escapeTomlDq(safeModel)}"`,
    `model_provider = "hoborouter"`,
    ``,
    `[model_providers.hoborouter]`,
    `name = "Hoborouter"`,
    `base_url = "${escapeTomlDq(safeUrl)}"`,
    `env_key = "HBR_API_KEY"`,
  ].join("\n");

  const opencode = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        hoborouter: {
          npm: "@ai-sdk/openai-compatible",
          name: "Hoborouter",
          options: {
            baseURL: safeUrl,
            apiKey: "{env:HBR_API_KEY}",
          },
          models: { [safeModel]: { name: safeModel } },
        },
      },
    },
    null,
    2,
  );

  const pi = JSON.stringify(
    {
      providers: {
        hoborouter: {
          baseUrl: safeUrl,
          api: "openai-completions",
          apiKey: "$HBR_API_KEY",
          models: [{ id: safeModel }],
        },
      },
    },
    null,
    2,
  );

  return { codex, opencode, pi };
}

function Snippet({ code, lang }: { code: string; lang: string }) {
  const t = useT(quickstartCopy);
  return (
    <div className="relative rounded-md border border-border bg-muted/40">
      <div className="absolute right-2 top-2">
        <CopyButton value={code} label={t("copyExample", { lang })} />
      </div>
      <pre
        className="overflow-x-auto p-4 text-xs leading-relaxed"
        aria-label={t("exampleAria", { lang })}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function AgentSnippet({ code, lang }: { code: string; lang: string }) {
  const t = useT(quickstartCopy);
  return (
    <div className="relative rounded-md border border-border bg-muted/40">
      <div className="absolute right-2 top-2">
        <CopyButton value={code} label={t("agentCopyExample", { lang })} />
      </div>
      <pre
        className="overflow-x-auto p-4 text-xs leading-relaxed"
        aria-label={t("agentExampleAria", { lang })}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function AgentDocsLinks({ target }: { target: "codex" | "opencode" | "pi" }) {
  const t = useT(quickstartCopy);
  const links = {
    codex: {
      href: "https://developers.openai.com/codex/config-reference",
      label: t("agentCodexDocs"),
    },
    opencode: { href: "https://opencode.ai/docs/providers/", label: t("agentOpencodeDocs") },
    // pi ships its docs with the install; the catalog is the canonical URL.
    pi: { href: "https://pi.dev/models", label: t("agentPiDocs") },
  };
  const link = links[target];
  return (
    <a href={link.href} className="underline hover:text-foreground" rel="noreferrer">
      {link.label}
    </a>
  );
}

export function Quickstart({
  instance,
  exampleModelId,
}: {
  instance?: PublicInstance | null;
  /** A published public model id from the catalog; falls back to a placeholder. */
  exampleModelId?: string | null;
}) {
  const t = useT(quickstartCopy);
  // Trusted admin config; placeholder until it loads so SSR/tests never
  // invent a hostname. Interpolations are escaped inside buildSnippets.
  const baseUrl = instance?.api_base_url ?? "YOUR_BASE_URL";
  const model = exampleModelId ?? "YOUR_MODEL_ID";
  const { curl, python, js } = buildSnippets(baseUrl, model);
  const { codex, opencode, pi } = buildAgentConfigSnippets(baseUrl, model);

  const modelDisplay = exampleModelId ? (
    <a href="/pricing" className="underline hover:text-foreground">
      {model}
    </a>
  ) : (
    model
  );

  return (
    <PublicLayout instance={instance}>
      <div className="space-y-6 py-6">
        <PageHeader title={t("title")} description={t("description")} />

        <section className="max-w-2xl">
          <h2 className="text-lg font-semibold">{t("step1Title")}</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <a href="/signup" className="underline hover:text-foreground">
                {t("signUp")}
              </a>{" "}
              {t("andSignIn")}
            </li>
            <li>{t("step1TopUp")}</li>
            <li>{t("step1ApiKey")}</li>
            <li>
              {t("step1Model")} {modelDisplay}.
            </li>
          </ol>
        </section>

        <section className="max-w-3xl space-y-3">
          <h2 className="text-lg font-semibold">{t("step2Title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("step2SdkLead")}{" "}
            <code className="font-mono text-xs">{normalizeBase(baseUrl)}/v1</code>{" "}
            {t("step2SdkTail")}
          </p>
          <Card>
            <CardContent className="pt-6">
              <Tabs defaultValue="curl">
                <TabsList aria-label={t("sdkTabsAria")}>
                  <TabsTrigger value="curl">curl</TabsTrigger>
                  <TabsTrigger value="python">Python</TabsTrigger>
                  <TabsTrigger value="js">JavaScript</TabsTrigger>
                </TabsList>
                <TabsContent value="curl">
                  <Snippet code={curl} lang="curl" />
                </TabsContent>
                <TabsContent value="python">
                  <Snippet code={python} lang="Python" />
                </TabsContent>
                <TabsContent value="js">
                  <Snippet code={js} lang="JavaScript" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">
            {t("streamingLead")} <code className="font-mono text-xs">"stream": true</code>
            {t("streamingTail")}
          </p>
        </section>

        <section className="max-w-3xl space-y-3">
          <h2 className="text-lg font-semibold">{t("agentTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("agentNote")}</p>
          <Card>
            <CardContent className="space-y-3 pt-6">
              <Tabs defaultValue="codex">
                <TabsList aria-label={t("agentTabsAria")}>
                  <TabsTrigger value="codex">Codex</TabsTrigger>
                  <TabsTrigger value="opencode">OpenCode</TabsTrigger>
                  <TabsTrigger value="pi">pi</TabsTrigger>
                  <TabsTrigger value="claude">Claude Code</TabsTrigger>
                </TabsList>
                <TabsContent value="codex" className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("agentCodexLead")} <AgentDocsLinks target="codex" />.
                  </p>
                  <AgentSnippet code={codex} lang="Codex" />
                </TabsContent>
                <TabsContent value="opencode" className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("agentOpencodeLead")} <AgentDocsLinks target="opencode" />.
                  </p>
                  <AgentSnippet code={opencode} lang="OpenCode" />
                </TabsContent>
                <TabsContent value="pi" className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("agentPiLead")} <AgentDocsLinks target="pi" />.
                  </p>
                  <AgentSnippet code={pi} lang="pi" />
                </TabsContent>
                {/* Honest notice only: the gateway serves no /v1/messages
                  route, so any config snippet here would fake support. */}
                <TabsContent value="claude">
                  <p className="text-sm text-muted-foreground" role="note">
                    {t("agentClaudeLead")}
                  </p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </section>
      </div>
    </PublicLayout>
  );
}

export default function QuickstartPage() {
  const instance = usePublicInstance();
  const catalog = usePublicCatalog();
  // First published model as the concrete example; never an upstream id —
  // the catalog route only returns published public ids.
  const exampleModelId = catalog.data?.data[0]?.public_id ?? null;
  return <Quickstart instance={instance.data ?? null} exampleModelId={exampleModelId} />;
}
