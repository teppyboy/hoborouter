import { Toaster as Sonner } from "sonner";
import { useThemeStore } from "@/lib/theme";

function resolveTheme(theme: "light" | "dark" | "system"): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function Toaster() {
  const theme = resolveTheme(useThemeStore((s) => s.theme));
  return (
    <Sonner
      position="top-right"
      theme={theme}
      toastOptions={{
        classNames: {
          toast:
            "bg-popover text-popover-foreground border border-border rounded-lg shadow-md text-sm",
          description: "text-muted-foreground",
        },
        style: {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties,
      }}
    />
  );
}

export { Toaster };
