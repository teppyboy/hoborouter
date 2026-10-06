// Public About page: app version (build-time injected package version, never
// a hardcoded literal) and the instance's admin-configured support channels.
// Contact info is rendered by SupportLinks, which validates every channel
// value; nothing here can leak credentials because the public instance
// endpoint only exposes display name, base URL and support links.
import { PageHeader } from "../../components/page";
import { PublicLayout } from "../../components/public-layout";
import { SupportLinks, supportLinks } from "../../components/support-links";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { appVersion } from "../../lib/version";
import { usePublicInstance, type PublicInstance } from "../../lib/public-queries";

const aboutTitle: LocaleEntry = { en: "About", vi: "Giới thiệu" };
const aboutDescription: LocaleEntry = {
  en: "Hoborouter is an OpenAI-compatible gateway in front of multiple AI providers, with per-token billing in VND.",
  vi: "Hoborouter là cổng API tương thích OpenAI phía trước nhiều nhà cung cấp AI, tính tiền theo token bằng VND.",
};
const versionLabel: LocaleEntry = { en: "Version", vi: "Phiên bản" };
const contactHeading: LocaleEntry = { en: "Contact", vi: "Liên hệ" };
const noContact: LocaleEntry = {
  en: "No contact channels are configured on this instance yet.",
  vi: "Instance này chưa cấu hình kênh liên hệ nào.",
};

export function About({
  instance,
  version,
}: {
  instance?: PublicInstance | null;
  /** Package version injected at build time; hidden when unavailable. */
  version?: string | null;
}) {
  const title = useLocaleEntry(aboutTitle);
  const description = useLocaleEntry(aboutDescription);
  const versionWord = useLocaleEntry(versionLabel);
  const contact = useLocaleEntry(contactHeading);
  const noContactText = useLocaleEntry(noContact);
  const shownVersion = version ?? null;
  const hasContact = supportLinks(instance?.support).length > 0;
  return (
    <PublicLayout instance={instance}>
      <div className="max-w-2xl space-y-8 py-6">
        <PageHeader title={title} description={description} />

        <section aria-labelledby="about-version-heading" className="space-y-2">
          <h2 id="about-version-heading" className="text-lg font-semibold">
            {versionWord}
          </h2>
          {shownVersion ? (
            <p className="text-sm text-muted-foreground">
              {versionWord}: <span className="font-mono text-foreground">{shownVersion}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{versionWord}: —</p>
          )}
        </section>

        <section aria-labelledby="about-contact-heading" className="space-y-2">
          <h2 id="about-contact-heading" className="text-lg font-semibold">
            {contact}
          </h2>
          {/* SupportLinks validates each configured channel and renders only
              the usable ones; keep an explicit empty state rather than a
              silent blank block when the instance has no contact info. */}
          <div className="text-sm">
            <SupportLinks support={instance?.support} />
            {!hasContact && <p className="text-muted-foreground">{noContactText}</p>}
          </div>
        </section>
      </div>
    </PublicLayout>
  );
}

export default function AboutPage() {
  const instance = usePublicInstance();
  return <About instance={instance.data ?? null} version={appVersion()} />;
}
