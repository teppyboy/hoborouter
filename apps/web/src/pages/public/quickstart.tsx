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

/**
 * The three quickstart snippets for a base URL + model id. Exported for tests:
 * Radix Tabs renders only the active tab in SSR, so the Python/JS bodies are
 * asserted on these strings directly. The JSON body is built with
 * JSON.stringify so any value is safely embedded; the URL/model values are
 * escaped per language before interpolation.
 */
export function buildSnippets(baseUrl: string, model: string) {
  const url = `${oneLine(baseUrl)}/v1/chat/completions`;
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
    `    base_url="${escapeDq(oneLine(baseUrl))}/v1",`,
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
    `  baseURL: "${escapeDq(oneLine(baseUrl))}/v1",`,
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

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative rounded-md border border-border bg-muted/40">
      <div className="absolute right-2 top-2">
        <CopyButton value={code} label={`Copy ${label} example`} />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed" aria-label={`${label} example`}>
        <code>{code}</code>
      </pre>
    </div>
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
  // Trusted admin config; placeholder until it loads so SSR/tests never
  // invent a hostname. Interpolations are escaped inside buildSnippets.
  const baseUrl = instance?.api_base_url ?? "YOUR_BASE_URL";
  const model = exampleModelId ?? "YOUR_MODEL_ID";
  const { curl, python, js } = buildSnippets(baseUrl, model);

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
        <PageHeader
          title="Quickstart"
          description="Make your first request through the OpenAI-compatible gateway."
        />

        <section className="max-w-2xl">
          <h2 className="text-lg font-semibold">1. Create an account and top up</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <a href="/signup" className="underline hover:text-foreground">
                Sign up
              </a>{" "}
              and sign in.
            </li>
            <li>Top up credits in Billing → Credits by QR (PayOS) or manual confirmation.</li>
            <li>Create an API key under API Keys. It is shown once — store it safely.</li>
            <li>Pick a model id from the pricing page, e.g. {modelDisplay}.</li>
          </ol>
        </section>

        <section className="max-w-3xl space-y-3">
          <h2 className="text-lg font-semibold">2. Call the API</h2>
          <p className="text-sm text-muted-foreground">
            Any OpenAI SDK works: set the base URL to{" "}
            <code className="font-mono text-xs">{baseUrl}/v1</code> and use your API key.
          </p>
          <Card>
            <CardContent className="pt-6">
              <Tabs defaultValue="curl">
                <TabsList>
                  <TabsTrigger value="curl">curl</TabsTrigger>
                  <TabsTrigger value="python">Python</TabsTrigger>
                  <TabsTrigger value="js">JavaScript</TabsTrigger>
                </TabsList>
                <TabsContent value="curl">
                  <Snippet code={curl} label="curl" />
                </TabsContent>
                <TabsContent value="python">
                  <Snippet code={python} label="Python" />
                </TabsContent>
                <TabsContent value="js">
                  <Snippet code={js} label="JavaScript" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">
            Responses follow the OpenAI chat-completions schema. Streaming is supported with{" "}
            <code className="font-mono text-xs">"stream": true</code>.
          </p>
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
