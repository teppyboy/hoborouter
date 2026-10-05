// Public landing page. Marketing copy is honest by policy: only claims the
// product actually ships (OpenAI-compatible gateway, multiple providers,
// VND credits, PayOS QR top-up). No price claims, no performance numbers.
import { PublicLayout } from "../../components/public-layout";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { usePublicInstance, type PublicInstance } from "../../lib/public-queries";

const POINTS = [
  {
    title: "One OpenAI-compatible API",
    description:
      "Point your existing OpenAI SDK, curl script or coding agent at /v1/chat/completions. No provider-specific rewrites.",
  },
  {
    title: "Multiple AI providers",
    description:
      "Chat with models from several providers through a single account and a single API key.",
  },
  {
    title: "Pay in VND, by QR",
    description:
      "Top up credits in Vietnamese dong via QR (PayOS) or manual confirmation — no international card needed.",
  },
  {
    title: "Self-service dashboard",
    description:
      "Create API keys, watch usage per request, and track your credit balance in real time.",
  },
];

export function Landing({ instance }: { instance?: PublicInstance | null }) {
  return (
    <PublicLayout instance={instance}>
      <div className="flex flex-col gap-10 py-6 sm:py-12">
        <section className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Use AI models through one API, pay in VND
          </h1>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            {instance?.name ?? "Hoborouter"} is an OpenAI-compatible gateway to multiple AI
            providers. Top up credits with a QR code and call any published model with the tools you
            already use.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href="/signup">Create an account</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/pricing">See pricing</a>
            </Button>
          </div>
        </section>
        <section className="grid gap-4 sm:grid-cols-2">
          {POINTS.map((p) => (
            <Card key={p.title}>
              <CardHeader>
                <CardTitle className="text-base">{p.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{p.description}</CardContent>
            </Card>
          ))}
        </section>
        <section className="max-w-2xl text-sm text-muted-foreground">
          <h2 className="font-medium text-foreground">Getting started</h2>
          <p className="mt-2">
            Sign up, top up credits by QR, create an API key, then follow the{" "}
            <a href="/docs/quickstart" className="underline hover:text-foreground">
              quickstart
            </a>{" "}
            to make your first request. Per-model prices are listed live on the{" "}
            <a href="/pricing" className="underline hover:text-foreground">
              pricing page
            </a>
            .
          </p>
        </section>
      </div>
    </PublicLayout>
  );
}

export default function LandingPage() {
  const instance = usePublicInstance();
  return <Landing instance={instance.data ?? null} />;
}
