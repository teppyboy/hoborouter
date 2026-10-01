import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Shield, Sun } from "lucide-react";
import { api } from "../lib/api";
import { authClient, useSession } from "../lib/auth";
import { applyTheme, useThemeStore, type Theme } from "../lib/theme";
import { useWorkspaceStore } from "../lib/workspace";
import { useWorkspaces, type Workspace } from "../lib/workspace-queries";
import { CreateWorkspace } from "./create-workspace";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select";
import { Separator } from "./ui/separator";
import { Badge } from "./ui/badge";

interface NavItem {
  label: string;
  to: string;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "", items: [{ label: "Overview", to: "/" }] },
  {
    label: "AI Gateway",
    items: [
      { label: "Models", to: "/models" },
      { label: "API Keys", to: "/keys" },
      { label: "Logs", to: "/logs" },
      { label: "Usage", to: "/usage" },
    ],
  },
  {
    label: "Billing",
    items: [
      { label: "Credits", to: "/billing/credits" },
      { label: "Payments", to: "/billing/payments" },
    ],
  },
  { label: "", items: [{ label: "Settings", to: "/settings" }] },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Users", to: "/admin/users" },
  { label: "Models", to: "/admin/models" },
  { label: "Providers", to: "/admin/providers" },
  { label: "Pricing", to: "/admin/pricing" },
  { label: "Payments", to: "/admin/payments" },
  { label: "System", to: "/admin/system" },
];

/** Detect instance-admin via GET /api/v1/admin/system (200 = admin, 403 = not), cached for the session. */
function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<unknown>("/api/v1/admin/system")
      .then(() => !cancelled && setIsAdmin(true))
      .catch((err: { status?: number }) => {
        if (!cancelled && err?.status === 403) setIsAdmin(false);
        else if (!cancelled) setIsAdmin(false); // ponytail: 404/500 also hides admin nav
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return isAdmin;
}

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${theme}`}
      onClick={() => {
        const order: Theme[] = ["light", "dark", "system"];
        const next = order[(order.indexOf(theme) + 1) % order.length];
        if (next) setTheme(next);
      }}
    >
      {(() => {
        const Icon = THEME_ICONS[theme];
        return <Icon className="size-4" />;
      })()}
    </Button>
  );
}

function WorkspaceSwitcher() {
  const { data: workspaces, isSuccess } = useWorkspaces();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  if (!isSuccess || !workspaces?.length) return null;
  return (
    <Select value={workspaceId ?? workspaces[0]?.id} onValueChange={setWorkspaceId}>
      <SelectTrigger aria-label="Workspace" className="w-full">
        <span className="truncate">
          {workspaces.find((w: Workspace) => w.id === workspaceId)?.name ?? workspaces[0]?.name}
        </span>
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((w: Workspace) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UserMenu() {
  const { data: session } = useSession();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-40">
          <span className="truncate">{session?.user?.email ?? "Account"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{session?.user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => authClient.signOut().then(() => window.location.assign("/login"))}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAdmin = useIsAdmin();
  // Empty workspace list means every workspace-scoped query is stuck pending; offer creation instead.
  const { data: workspaces, isSuccess: wsLoaded } = useWorkspaces();
  const emptyWorkspaces = wsLoaded && workspaces?.length === 0;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border md:flex">
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          <Shield className="size-4" />
          <span className="text-sm font-semibold">Hoborouter</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 text-sm">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi} className={cn(gi > 0 && "mt-4")}>
              {group.label && (
                <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</p>
              )}
              {group.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "block rounded-md px-2 py-1.5 text-sm",
                    pathname === item.to
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
          {isAdmin === true && (
            <div className="mt-4">
              <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">Admin</p>
              {ADMIN_NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "block rounded-md px-2 py-1.5 text-sm",
                    pathname === item.to
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          )}
          {isAdmin === null && (
            <div className="mt-4 px-2">
              <Badge variant="secondary">Checking admin…</Badge>
            </div>
          )}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-border px-4">
          <div className="w-44">
            <WorkspaceSwitcher />
          </div>
          <div className="flex-1" />
          <ThemeToggle />
          <Separator orientation="vertical" className="h-4" />
          <UserMenu />
        </header>
        <main className="min-w-0 flex-1">{emptyWorkspaces ? <CreateWorkspace /> : children}</main>
      </div>
    </div>
  );
}
