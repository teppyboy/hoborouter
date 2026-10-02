import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Boxes,
  CreditCard,
  Cpu,
  Settings2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  PanelLeftClose,
  ScrollText,
  Settings,
  Shuffle,
  Sun,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { authClient, useSession } from "../lib/auth";
import { applyTheme, useThemeStore, type Theme } from "../lib/theme";
import { useSidebarStore } from "../lib/sidebar";
import { useWorkspaceStore } from "../lib/workspace";
import { preloadChunk, preloadNavChunksOnIdle } from "../lib/prefetch";
import { gravatarUrl } from "../lib/avatar";
import { useCurrentWorkspaceId, useWorkspaces, type Workspace } from "../lib/workspace-queries";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "", items: [{ label: "Overview", to: "/", icon: LayoutDashboard }] },
  {
    label: "AI Gateway",
    items: [
      { label: "Models", to: "/models", icon: Boxes },
      { label: "API Keys", to: "/keys", icon: KeyRound },
      { label: "Logs", to: "/logs", icon: ScrollText },
      { label: "Usage", to: "/usage", icon: BarChart3 },
    ],
  },
  {
    label: "Billing",
    items: [
      { label: "Credits", to: "/billing/credits", icon: Wallet },
      { label: "Payments", to: "/billing/payments", icon: CreditCard },
    ],
  },
  { label: "", items: [{ label: "Settings", to: "/settings", icon: Settings }] },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Users", to: "/admin/users", icon: Users },
  { label: "Models", to: "/admin/models", icon: Boxes },
  { label: "Payments", to: "/admin/payments", icon: CreditCard },
  { label: "Audit log", to: "/admin/audit", icon: ScrollText },
  { label: "System", to: "/admin/system", icon: Cpu },
  { label: "Settings", to: "/admin/settings", icon: Settings2 },
];

/** Detect instance-admin via GET /api/v1/me (200 = session, flag on the payload). */
export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ is_instance_admin?: boolean }>("/api/v1/me")
      .then((me) => !cancelled && setIsAdmin(!!me.is_instance_admin))
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return isAdmin;
}

/** First letters of the first two words/parts of a name or email local-part. */
function initials(name?: string | null, email?: string | null): string {
  const s = name?.trim() || email?.split("@")[0] || "?";
  return s
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function InitialAvatar({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground",
        className,
      )}
      aria-hidden
    >
      {label}
    </span>
  );
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
  const { data: workspaces, isSuccess, refetch } = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  if (!isSuccess || !workspaces?.length) return null;
  const current =
    workspaces.find((w: Workspace) => w.id === workspaceId)?.name ?? workspaces[0]?.name;
  return (
    <Select
      value={workspaceId ?? workspaces[0]?.id}
      onValueChange={setWorkspaceId}
      // Fresh list on open: workspaces can be created outside this cache.
      onOpenChange={(open) => open && void refetch()}
    >
      <SelectTrigger aria-label="Workspace" className="w-full gap-2">
        <InitialAvatar label={initials(current)} />
        <span className="truncate">{current}</span>
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

/** Custom avatar image, falling back to Gravatar, then initials. */
function UserAvatar({
  name,
  email,
  image,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [gravatar, setGravatar] = useState<string | null>(null);
  const [gravatarFailed, setGravatarFailed] = useState(false);
  void gravatarUrl(email).then((u) => {
    if (u) setGravatar(u);
  });
  if (image && !imageFailed) {
    return (
      <img
        src={image}
        alt=""
        className="size-6 shrink-0 rounded-full object-cover"
        onError={() => setImageFailed(true)}
      />
    );
  }
  if (gravatar && !gravatarFailed) {
    return (
      <img
        src={gravatar}
        alt=""
        className="size-6 shrink-0 rounded-full object-cover"
        onError={() => setGravatarFailed(true)}
      />
    );
  }
  return <InitialAvatar label={initials(name, email)} />;
}

function UserMenu() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Account menu" className="max-w-48 gap-2">
          <UserAvatar
            name={session?.user?.name}
            email={session?.user?.email}
            image={session?.user?.image}
          />
          <span className="truncate">{session?.user?.name ?? "Account"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <p className="text-sm font-medium text-foreground">{session?.user?.name ?? "Account"}</p>
          <p className="text-xs font-normal text-muted-foreground">{session?.user?.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            // Drop workspace-scoped queries before the session dies so no
            // refetch fires against an invalidated cookie (401 noise).
            useWorkspaceStore.setState({ workspaceId: null });
            void queryClient.cancelQueries();
            authClient.signOut().then(() => {
              // Session is gone: drop every cached query so the login screen
              // cannot fire workspace-scoped refetches against a dead cookie.
              queryClient.clear();
              window.location.assign("/login");
            });
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      preload="intent"
      viewTransition
      onMouseEnter={() => preloadChunk(item.to)}
      onFocus={() => preloadChunk(item.to)}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent font-medium text-foreground before:absolute before:left-0 before:top-1/2 before:h-4 before:-translate-y-1/2 before:w-0.5 before:rounded-full before:bg-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Warm main nav route chunks once the app has painted.
  useEffect(() => {
    preloadNavChunksOnIdle();
  }, []);
  const isAdmin = useIsAdmin();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  // Empty workspace list means every workspace-scoped query is stuck pending; offer creation instead.
  const { data: workspaces, isSuccess: wsLoaded } = useWorkspaces();
  const emptyWorkspaces = wsLoaded && workspaces?.length === 0;
  const ToggleIcon = collapsed ? PanelLeft : PanelLeftClose;

  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r border-border transition-[width] duration-200",
            collapsed ? "w-14" : "w-52",
          )}
        >
          <div
            className={cn(
              "flex h-12 items-center gap-2 border-b border-border px-3",
              collapsed && "justify-center px-0",
            )}
          >
            <Shuffle className="size-4 shrink-0" aria-hidden />
            {!collapsed && <span className="text-sm font-semibold">Hoborouter</span>}
            {!collapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7"
                aria-label="Collapse sidebar"
                onClick={toggleCollapsed}
              >
                <ToggleIcon className="size-4" />
              </Button>
            )}
          </div>
          <nav className="flex-1 overflow-y-auto p-2 text-sm">
            {NAV_GROUPS.map((group, gi) => (
              <div key={gi} className={cn(gi > 0 && "mt-4")}>
                {group.label && !collapsed && (
                  <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    item={item}
                    active={pathname === item.to}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            ))}
            {isAdmin === true && (
              <div className="mt-4">
                {!collapsed && (
                  <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">Admin</p>
                )}
                {ADMIN_NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    item={item}
                    active={pathname === item.to}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            )}
            {isAdmin === null && !collapsed && (
              <div className="mt-4 px-2">
                <Badge variant="secondary">Checking admin…</Badge>
              </div>
            )}
          </nav>
          {collapsed && (
            <div className="flex justify-center border-t border-border p-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Expand sidebar"
                onClick={toggleCollapsed}
              >
                <ToggleIcon className="size-4" />
              </Button>
            </div>
          )}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
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
    </TooltipProvider>
  );
}
