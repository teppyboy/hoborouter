// VI/EN language toggle: an accessible button that flips the locale store and
// mirrors it onto <html lang>. Shows the locale you can switch TO (VI/EN), no
// popup/menu dependency. Header/auth integrators mount it later.
import { useEffect } from "react";
import { Languages } from "lucide-react";
import { applyLocale, useLocaleStore } from "../lib/i18n/locale";
import { Button } from "./ui/button";

export function LanguageToggle() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  const next = locale === "en" ? "vi" : "en";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={locale === "en" ? "Switch to Vietnamese" : "Chuyển sang tiếng Anh"}
      onClick={() => setLocale(next)}
    >
      <Languages className="size-4" />
      {next === "vi" ? "VI" : "EN"}
    </Button>
  );
}
