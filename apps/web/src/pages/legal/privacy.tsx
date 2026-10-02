import privacyMd from "./content/privacy.md?raw";
import { LegalPage } from "./legal-page";

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" md={privacyMd} />;
}
