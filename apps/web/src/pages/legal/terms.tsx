import termsMd from "./content/terms.md?raw";
import { LegalPage } from "./legal-page";

export default function TermsPage() {
  return <LegalPage title="Terms of Service" md={termsMd} />;
}
