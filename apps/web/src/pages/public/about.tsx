// Public About page: app version and full git revision (both build-time
// injected, never hardcoded literals) and the instance's admin-configured
// support channels.
// Contact info is rendered by SupportLinks, which validates every channel
// value; nothing here can leak credentials because the public instance
// endpoint only exposes display name, base URL and support links.
import { PageHeader } from "../../components/page";
import { PublicLayout } from "../../components/public-layout";
import { SupportLinks, supportLinks } from "../../components/support-links";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { appVersion, gitRevision } from "../../lib/version";
import { usePublicInstance, type PublicInstance } from "../../lib/public-queries";
import { useShellSession } from "../../lib/session";

const aboutTitle: LocaleEntry = { en: "About", vi: "Giới thiệu" };
const aboutDescription: LocaleEntry = {
  en: "Hoborouter is an OpenAI-compatible gateway in front of multiple AI providers, with per-token billing in VND.",
  vi: "Hoborouter là cổng API tương thích OpenAI phía trước nhiều nhà cung cấp AI, tính tiền theo token bằng VND.",
};
const versionLabel: LocaleEntry = { en: "Version", vi: "Phiên bản" };
const revisionLabel: LocaleEntry = { en: "Revision", vi: "Bản dựng" };
const contactHeading: LocaleEntry = { en: "Contact", vi: "Liên hệ" };
const noContact: LocaleEntry = {
  en: "No contact channels are configured on this instance yet.",
  vi: "Instance này chưa cấu hình kênh liên hệ nào.",
};

export function About({
  instance,
  version,
  revision,
  embedded,
}: {
  instance?: PublicInstance | null;
  /** Release version injected at build time; hidden when unavailable. */
  version?: string | null;
  /** Full commit SHA injected at build time; shown as "—" when unavailable. */
  revision?: string | null;
  /** Rendered inside the app shell (signed-in help navigation): skips
   * PublicLayout — one content source, context-adaptive wrapper only. */
  embedded?: boolean;
}) {
  const title = useLocaleEntry(aboutTitle);
  const description = useLocaleEntry(aboutDescription);
  const versionWord = useLocaleEntry(versionLabel);
  const revisionWord = useLocaleEntry(revisionLabel);
  const contact = useLocaleEntry(contactHeading);
  const noContactText = useLocaleEntry(noContact);
  const shownVersion = version ?? null;
  const shownRevision = revision ?? null;
  const hasContact = supportLinks(instance?.support).length > 0;
  const body = (
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
        {/* Full SHA: select-all keeps the whole revision one click away
              without shipping a copy button; "—" when the build had no SHA. */}
        {shownRevision ? (
          <p className="text-sm text-muted-foreground">
            {revisionWord}:{" "}
            <span className="font-mono text-foreground select-all">{shownRevision}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{revisionWord}: —</p>
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
  );
  if (embedded) return body;
  return <PublicLayout instance={instance}>{body}</PublicLayout>;
}

export default function AboutPage() {
  const instance = usePublicInstance();
  // Same cached session query the router layout used for its shell decision:
  // signed-in users get the embedded page (inside the AppShell), anonymous
  // visitors the public chrome.
  const { data: session } = useShellSession();
  return (
    <About
      instance={instance.data ?? null}
      version={appVersion()}
      revision={gitRevision()}
      embedded={!!session}
    />
  );
}
