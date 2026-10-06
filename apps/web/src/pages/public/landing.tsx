// Public landing page. Marketing copy is honest by policy: only claims the
// product actually ships (OpenAI-compatible gateway, multiple providers,
// VND credits, PayOS QR top-up). No price claims, no performance numbers.
import { PublicLayout } from "../../components/public-layout";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { usePublicInstance, type PublicInstance } from "../../lib/public-queries";

// Small closed marketing copy set → inline LocaleEntry (see lib/i18n/common.ts).
const POINTS: { title: LocaleEntry; description: LocaleEntry }[] = [
  {
    title: { en: "One OpenAI-compatible API", vi: "Một API tương thích OpenAI" },
    description: {
      en: "Point your existing OpenAI SDK, curl script or coding agent at /v1/chat/completions. No provider-specific rewrites.",
      vi: "Trỏ SDK OpenAI, script curl hoặc coding agent sẵn có của bạn tới /v1/chat/completions. Không cần viết lại theo từng nhà cung cấp.",
    },
  },
  {
    title: { en: "Multiple AI providers", vi: "Nhiều nhà cung cấp AI" },
    description: {
      en: "Chat with models from several providers through a single account and a single API key.",
      vi: "Trò chuyện với các mô hình từ nhiều nhà cung cấp qua một tài khoản và một API key duy nhất.",
    },
  },
  {
    title: { en: "Pay in VND, by QR", vi: "Thanh toán bằng VND, qua QR" },
    description: {
      en: "Top up credits in Vietnamese dong via QR (PayOS) or manual confirmation — no international card needed.",
      vi: "Nạp tín dụng bằng tiền Việt (VND) qua QR (PayOS) hoặc xác nhận thủ công — không cần thẻ quốc tế.",
    },
  },
  {
    title: { en: "Self-service dashboard", vi: "Dashboard tự phục vụ" },
    description: {
      en: "Create API keys, watch usage per request, and track your credit balance in real time.",
      vi: "Tạo API key, theo dõi mức sử dụng từng request và xem số dư tín dụng theo thời gian thực.",
    },
  },
];

const heroTitle: LocaleEntry = {
  en: "Use AI models through one API, pay in VND",
  vi: "Dùng các mô hình AI qua một API, thanh toán bằng VND",
};
// Rendered right after the instance name; Vietnamese follows its own syntax.
const heroBody: LocaleEntry = {
  en: "is an OpenAI-compatible gateway to multiple AI providers. Top up credits with a QR code and call any published model with the tools you already use.",
  vi: "là cổng API tương thích OpenAI kết nối nhiều nhà cung cấp AI. Nạp tín dụng bằng mã QR và gọi bất kỳ mô hình đã xuất bản bằng chính công cụ bạn đang dùng.",
};
const createAccount: LocaleEntry = { en: "Create an account", vi: "Tạo tài khoản" };
const seePricing: LocaleEntry = { en: "See pricing", vi: "Xem bảng giá" };
const gettingStarted: LocaleEntry = { en: "Getting started", vi: "Bắt đầu" };
const startedLead: LocaleEntry = {
  en: "Sign up, top up credits by QR, create an API key, then follow the",
  vi: "Đăng ký, nạp tín dụng bằng QR, tạo API key, sau đó làm theo",
};
const quickstartLink: LocaleEntry = { en: "quickstart", vi: "hướng dẫn nhanh" };
const startedMiddle: LocaleEntry = {
  en: "to make your first request. Per-model prices are listed live on the",
  vi: "để gửi request đầu tiên. Giá từng mô hình được cập nhật trực tiếp tại",
};
const pricingLink: LocaleEntry = { en: "pricing page", vi: "trang bảng giá" };
const startedEnd: LocaleEntry = { en: ".", vi: "." };

function LandingPoint({ point }: { point: { title: LocaleEntry; description: LocaleEntry } }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{useLocaleEntry(point.title)}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {useLocaleEntry(point.description)}
      </CardContent>
    </Card>
  );
}

export function Landing({ instance }: { instance?: PublicInstance | null }) {
  const heroTitleText = useLocaleEntry(heroTitle);
  const heroBodyText = useLocaleEntry(heroBody);
  const createAccountText = useLocaleEntry(createAccount);
  const seePricingText = useLocaleEntry(seePricing);
  const gettingStartedText = useLocaleEntry(gettingStarted);
  const startedLeadText = useLocaleEntry(startedLead);
  const quickstartText = useLocaleEntry(quickstartLink);
  const startedMiddleText = useLocaleEntry(startedMiddle);
  const pricingText = useLocaleEntry(pricingLink);
  const startedEndText = useLocaleEntry(startedEnd);
  return (
    <PublicLayout instance={instance}>
      <div className="flex flex-col gap-10 py-6 sm:py-12">
        <section className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{heroTitleText}</h1>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            <span className="font-medium text-foreground">{instance?.name ?? "Hoborouter"}</span>{" "}
            {heroBodyText}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href="/signup">{createAccountText}</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/pricing">{seePricingText}</a>
            </Button>
          </div>
        </section>
        <section className="grid gap-4 sm:grid-cols-2">
          {POINTS.map((p) => (
            <LandingPoint key={p.title.en} point={p} />
          ))}
        </section>
        <section className="max-w-2xl text-sm text-muted-foreground">
          <h2 className="font-medium text-foreground">{gettingStartedText}</h2>
          <p className="mt-2">
            {startedLeadText}{" "}
            <a href="/docs/quickstart" className="underline hover:text-foreground">
              {quickstartText}
            </a>{" "}
            {startedMiddleText}{" "}
            <a href="/pricing" className="underline hover:text-foreground">
              {pricingText}
            </a>
            {startedEndText}
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
