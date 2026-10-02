// Dark-mode toggle for public pages (login/privacy/terms). Unlike the
// app-shell 3-way toggle, public pages have no theme effect elsewhere
// (main.tsx never calls applyTheme), so this owns applying the theme and
// tracking the system preference while theme is "system".
import { useEffect, useState } from "react";
import { SunMoon } from "lucide-react";
import { applyTheme, useThemeStore } from "../lib/theme";
import { Button } from "./ui/button";

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  // Guard window: renders in SSR tests under Bun where window is undefined.
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  const dark = theme === "dark" || (theme === "system" && systemDark);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, systemDark]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <SunMoon className={dark ? "size-4 text-foreground" : "size-4"} />
    </Button>
  );
}
