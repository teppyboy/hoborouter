import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { PageHeader, CopyButton, ErrorState, EmptyState } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Separator } from "../../components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { formatVnd, formatDate } from "../../lib/format";
import { useWorkspaceModels, type WorkspaceModel } from "./data";

const PLACEHOLDER_KEY = "sk-hbr-YOUR_KEY";

function codeSamples(origin: string, modelId: string) {
  const url = `${origin}/v1/chat/completions`;
  const curl = `curl ${url} \\
  -H "Authorization: Bearer ${PLACEHOLDER_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`;
  const js = `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${PLACEHOLDER_KEY}",
  baseURL: "${origin}/v1",
});

const res = await client.chat.completions.create({
  model: "${modelId}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(res.choices[0].message.content);`;
  const py = `from openai import OpenAI

client = OpenAI(
    api_key="${PLACEHOLDER_KEY}",
    base_url="${origin}/v1",
)

res = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(res.choices[0].message.content)`;
  return { curl, js, py };
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}

export default function ModelDetailPage() {
  const { modelId: rawId } = useParams({ strict: false }) as { modelId: string };
  const publicId = decodeURIComponent(rawId);
  const [origin] = useState(() => window.location.origin);
  const modelsQ = useWorkspaceModels();

  if (modelsQ.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  if (modelsQ.isError) return <ErrorState message={modelsQ.error.message} />;

  const model = (modelsQ.data ?? []).find((m: WorkspaceModel) => m.public_model === publicId);
  if (!model)
    return (
      <div className="space-y-4">
        <PageHeader title="Model" />
        <EmptyState title="Model not found" description={`No published model "${publicId}" in this workspace.`} />
      </div>
    );

  const { curl, js, py } = codeSamples(origin, publicId);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}>
        <ChevronLeft className="size-4" /> Back
      </Button>
      <PageHeader
        title={publicId}
        description="Published model pricing for this workspace. Prices are per 1M tokens."
        actions={<CopyButton value={publicId} label="Copy model ID" />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">Pricing</div>
          <dl className="divide-y divide-border text-sm">
            {[
              ["Input / 1M", formatVnd(model.price_input_per_1m)],
              ["Output / 1M", formatVnd(model.price_output_per_1m)],
              ["Cached input / 1M", "Not available yet"],
              ["Reasoning / 1M", "Not available yet"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-4 py-2">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={`font-mono ${v === "Not available yet" ? "text-muted-foreground" : ""}`}>
                  {v}
                </dd>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">Effective since</dt>
              <dd className="font-mono">{formatDate(new Date(model.effective_at))}</dd>
            </div>
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">Price snapshot</dt>
              <dd className="font-mono">{model.snapshot_id ?? "—"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">Details</div>
          <dl className="divide-y divide-border text-sm">
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="font-mono">{publicId.split("/")[0] ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">Context window</dt>
              <dd className="font-mono">Not available yet</dd>
            </div>
            <div className="px-4 py-2">
              <dt className="text-muted-foreground">Capabilities</dt>
              <dd className="mt-1 text-muted-foreground text-sm">
                Not available yet — capabilities are not exposed by the session models endpoint.
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm font-medium">Quickstart</span>
          <span className="font-mono text-xs text-muted-foreground">base URL: {origin}/v1</span>
        </div>
        <div className="p-4">
          <Tabs defaultValue="curl">
            <TabsList>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="js">OpenAI SDK (JS)</TabsTrigger>
              <TabsTrigger value="py">OpenAI SDK (Python)</TabsTrigger>
            </TabsList>
            <Separator className="my-3" />
            <TabsContent value="curl">
              <CodeBlock code={curl} />
            </TabsContent>
            <TabsContent value="js">
              <CodeBlock code={js} />
            </TabsContent>
            <TabsContent value="py">
              <CodeBlock code={py} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        Replace <Badge variant="secondary" className="font-mono text-xs">{PLACEHOLDER_KEY}</Badge>
        with a key from API Keys.
      </p>
    </div>
  );
}
