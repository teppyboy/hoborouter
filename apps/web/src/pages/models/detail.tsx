import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { PageHeader, CopyButton, ErrorState, EmptyState } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Separator } from "../../components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { formatUsdMicroPer1m } from "../../lib/format";
import { useCatalogModel } from "./data";
import { useT } from "../../lib/i18n/t";

// Model detail copy: inline LocaleEntry set (see lib/i18n/common.ts). The
// public model id, capability values and code samples stay verbatim.
const detailCopy = {
  back: { en: "Back", vi: "Quay lại" },
  description: {
    en: "Published model pricing. Prices are per 1M tokens, in USD.",
    vi: "Giá mô hình đã xuất bản. Giá trên 1M token, tính bằng USD.",
  },
  copyModelId: { en: "Copy model ID", vi: "Copy model ID" },
  notFound: { en: "Model not found", vi: "Không tìm thấy mô hình" },
  notFoundDesc: { en: 'No published model "{id}".', vi: 'Không có mô hình đã xuất bản "{id}".' },
  pricing: { en: "Pricing", vi: "Giá" },
  inputPrice: { en: "Input / 1M", vi: "Input / 1M" },
  outputPrice: { en: "Output / 1M", vi: "Output / 1M" },
  cachedInputPrice: { en: "Cached input / 1M", vi: "Input cache / 1M" },
  reasoningPrice: { en: "Reasoning / 1M", vi: "Suy luận / 1M" },
  details: { en: "Details", vi: "Chi tiết" },
  provider: { en: "Provider", vi: "Nhà cung cấp" },
  contextWindow: { en: "Context window", vi: "Cửa sổ ngữ cảnh" },
  displayName: { en: "Display name", vi: "Tên hiển thị" },
  descriptionLabel: { en: "Description", vi: "Mô tả" },
  capabilities: { en: "Capabilities", vi: "Năng lực" },
  quickstart: { en: "Quickstart", vi: "Hướng dẫn nhanh" },
  sdkJs: { en: "OpenAI SDK (JS)", vi: "OpenAI SDK (JS)" },
  sdkPy: { en: "OpenAI SDK (Python)", vi: "OpenAI SDK (Python)" },
} as const;

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
    messages=[{"role": "user", "content": "Hello" }],
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

function PriceRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-4 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{formatUsdMicroPer1m(value)}</dd>
    </div>
  );
}

export default function ModelDetailPage() {
  const t = useT(detailCopy);
  // Route is splat "/models/$"; public id may contain '/', read the splat param.
  const params = useParams({ strict: false }) as { _splat?: string; modelId?: string };
  const rawId = params._splat ?? params.modelId ?? "";
  const publicId = decodeURIComponent(rawId);
  const [origin] = useState(() => window.location.origin);
  const modelQ = useCatalogModel(publicId);

  if (modelQ.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  if (modelQ.isError)
    return modelQ.error instanceof Error && "status" in modelQ.error ? (
      ((
        <div className="space-y-4">
          <PageHeader title={t("notFound")} />
          <EmptyState title={t("notFound")} description={t("notFoundDesc", { id: publicId })} />
        </div>
      ) as React.ReactNode)
    ) : (
      <ErrorState message={modelQ.error.message} />
    );

  const model = modelQ.data;
  const { curl, js, py } = codeSamples(origin, publicId);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}>
        <ChevronLeft className="size-4" /> {t("back")}
      </Button>
      <PageHeader
        title={publicId}
        description={t("description")}
        actions={<CopyButton value={publicId} label={t("copyModelId")} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">{t("pricing")}</div>
          <dl className="divide-y divide-border text-sm">
            <PriceRow label={t("inputPrice")} value={model.price.input_usd_micro_per_1m} />
            <PriceRow label={t("outputPrice")} value={model.price.output_usd_micro_per_1m} />
            <PriceRow label={t("cachedInputPrice")} value={model.price.cached_input_usd_micro_per_1m} />
            <PriceRow label={t("reasoningPrice")} value={model.price.reasoning_usd_micro_per_1m} />
          </dl>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">{t("details")}</div>
          <dl className="divide-y divide-border text-sm">
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">{t("provider")}</dt>
              <dd className="font-mono">{model.provider}</dd>
            </div>
            <div className="flex items-center justify-between px-4 py-2">
              <dt className="text-muted-foreground">{t("contextWindow")}</dt>
              <dd className="font-mono">
                {model.context_window != null ? model.context_window.toLocaleString() : "—"}
              </dd>
            </div>
            {model.display_name && (
              <div className="flex items-center justify-between px-4 py-2">
                <dt className="text-muted-foreground">{t("displayName")}</dt>
                <dd>{model.display_name}</dd>
              </div>
            )}
            {model.description && (
              <div className="px-4 py-2">
                <dt className="text-muted-foreground">{t("descriptionLabel")}</dt>
                <dd className="mt-1 text-sm">{model.description}</dd>
              </div>
            )}
            <div className="px-4 py-2">
              <dt className="text-muted-foreground">{t("capabilities")}</dt>
              <dd className="mt-1">
                {model.capabilities.length === 0 ? (
                  <span className="text-muted-foreground text-sm">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {model.capabilities.map((c) => (
                      <Badge key={c} variant="secondary" className="font-mono text-xs">
                        {c}
                      </Badge>
                    ))}
                  </div>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border px-4 py-2">
          <span className="text-sm font-medium">{t("quickstart")}</span>
          <span className="font-mono text-xs text-muted-foreground">base URL: {origin}/v1</span>
        </div>
        <div className="p-4">
          <Tabs defaultValue="curl">
            <TabsList>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="js">{t("sdkJs")}</TabsTrigger>
              <TabsTrigger value="py">{t("sdkPy")}</TabsTrigger>
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
        Replace{" "}
        <Badge variant="secondary" className="font-mono text-xs">
          {PLACEHOLDER_KEY}
        </Badge>
        with a key from API Keys.
      </p>
    </div>
  );
}
