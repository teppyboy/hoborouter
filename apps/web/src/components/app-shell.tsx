import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  BookOpen,
  Boxes,
  CreditCard,
  Gift,
  Info,
  CircleHelp,
  Settings2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  PanelLeft,
  PanelLeftClose,
  FileClock,
  ScrollText,
  Server,
  Settings,
  Shuffle,
  Sun,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { authClient, useSession } from "../lib/auth";
import { signOutAndReset } from "../lib/logout";
import { applyTheme, useThemeStore, type Theme } from "../lib/theme";
import { useSidebarStore } from "../lib/sidebar";
import { useWorkspaceStore } from "../lib/workspace";
import { preloadChunk, preloadNavChunksOnIdle } from "../lib/prefetch";
import { gravatarUrl } from "../lib/avatar";
import { resendVerification, type SessionUser } from "../lib/auth";
import { LanguageToggle } from "./language-toggle";
import { usePublicConfig } from "./turnstile";
import { useT, useLocaleEntry, type LocaleEntry } from "../lib/i18n/t";
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
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./ui/sheet";

interface NavItem {
  // Inline LocaleEntry: the sidebar is a small closed label set, so a named
  // dictionary would only add key-collision churn (see lib/i18n/common.ts).
  label: LocaleEntry;
  to: string;
  icon: LucideIcon;
}

const NAV_GROUPS: { label: LocaleEntry | ""; items: NavItem[] }[] = [
  {
    label: "",
    items: [{ label: { en: "Overview", vi: "Tổng quan" }, to: "/", icon: LayoutDashboard }],
  },
  {
    label: { en: "AI Gateway", vi: "AI Gateway" },
    items: [
      { label: { en: "Models", vi: "Mô hình" }, to: "/models", icon: Boxes },
      { label: { en: "API Keys", vi: "Khoá API" }, to: "/keys", icon: KeyRound },
      { label: { en: "Chat", vi: "Chat" }, to: "/chat", icon: MessageSquare },
      { label: { en: "Logs", vi: "Nhật ký" }, to: "/logs", icon: ScrollText },
      { label: { en: "Usage", vi: "Sử dụng" }, to: "/usage", icon: BarChart3 },
    ],
  },
  {
    label: { en: "Billing", vi: "Thanh toán" },
    items: [
      { label: { en: "Credits", vi: "Số dư" }, to: "/billing/credits", icon: Wallet },
      { label: { en: "Bundles", vi: "Gói" }, to: "/billing/bundles", icon: Package },
      { label: { en: "Payments", vi: "Giao dịch" }, to: "/billing/payments", icon: CreditCard },
    ],
  },
  {
    label: { en: "Help", vi: "Trợ giúp" },
    items: [
      // Links to the existing public routes; no duplicated tutorial/faq/about page.
      { label: { en: "Tutorials", vi: "Hướng dẫn" }, to: "/docs/quickstart", icon: BookOpen },
      { label: { en: "FAQ", vi: "Hỏi đáp" }, to: "/faq", icon: CircleHelp },
      { label: { en: "About", vi: "Giới thiệu" }, to: "/about", icon: Info },
    ],
  },
  {
    label: "",
    items: [{ label: { en: "Settings", vi: "Cài đặt" }, to: "/settings", icon: Settings }],
  },
];

const ADMIN_HEADING: LocaleEntry = { en: "Admin", vi: "Quản trị" };

// Admin sidebar groups: main admin tools, then a dedicated Logs section so
// audit + request logs read as one logging area instead of scattered items.
const ADMIN_GROUPS: { label: LocaleEntry; items: NavItem[] }[] = [
  {
    label: ADMIN_HEADING,
    items: [
      { label: { en: "Users", vi: "Người dùng" }, to: "/admin/users", icon: Users },
      { label: { en: "Models", vi: "Mô hình" }, to: "/admin/models", icon: Boxes },
      { label: { en: "Payments", vi: "Giao dịch" }, to: "/admin/payments", icon: CreditCard },
      {
        label: { en: "Bundles & plans", vi: "Gói & kế hoạch" },
        to: "/admin/bundles",
        icon: Package,
      },
      { label: { en: "Promotions", vi: "Khuyến mãi" }, to: "/admin/promotions", icon: Gift },
      { label: { en: "CPA", vi: "CPA" }, to: "/admin/cpa", icon: Server },
      { label: { en: "Settings", vi: "Cài đặt" }, to: "/admin/settings", icon: Settings2 },
    ],
  },
  {
    label: { en: "Logs", vi: "Nhật ký" },
    items: [
      { label: { en: "Audit log", vi: "Nhật ký kiểm tra" }, to: "/admin/audit", icon: ScrollText },
      {
        label: { en: "Request log", vi: "Nhật ký yêu cầu" },
        to: "/admin/request-log",
        icon: FileClock,
      },
    ],
  },
];

// Shell chrome strings outside the nav dictionary: aria labels and the
// unverified-email banner. Inline LocaleEntry set (see lib/i18n/common.ts).
const SHELL = {
  workspace: { en: "Workspace", vi: "Workspace" },
  accountMenu: { en: "Account menu", vi: "Menu tài khoản" },
  account: { en: "Account", vi: "Tài khoản" },
  signOut: { en: "Sign out", vi: "Đăng xuất" },
  expandSidebar: { en: "Expand sidebar", vi: "Mở rộng thanh bên" },
  collapseSidebar: { en: "Collapse sidebar", vi: "Thu gọn thanh bên" },
  openNavigation: { en: "Open navigation", vi: "Mở điều hướng" },
  mainNavigation: { en: "Main navigation", vi: "Điều hướng chính" },
  checkingAdmin: { en: "Checking admin…", vi: "Đang kiểm tra quyền quản trị…" },
  verifyEmail: {
    en: "Please verify your email address ({email}).",
    vi: "Vui lòng xác thực địa chỉ email của bạn ({email}).",
  },
  sending: { en: "Sending…", vi: "Đang gửi…" },
  resend: { en: "Resend", vi: "Gửi lại" },
  dismiss: { en: "Dismiss", vi: "Bỏ qua" },
  emailSent: {
    en: "Verification email sent — check your inbox",
    vi: "Đã gửi email xác thực — hãy kiểm tra hộp thư",
  },
  emailRateLimited: {
    en: "Too many emails requested; try again in a minute",
    vi: "Yêu cầu email quá nhiều; thử lại sau một phút",
  },
  emailFailed: {
    en: "Could not send the verification email; try again later",
    vi: "Không gửi được email xác thực; thử lại sau",
  },
} as const;

/** Reactive translator over SHELL; use inside components only. */
function useShellT() {
  return useT(SHELL);
}

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
  const st = useShellT();
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
      <SelectTrigger aria-label={st("workspace")} className="w-full gap-2">
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
  const st = useShellT();
  const aboutLabel = useLocaleEntry({ en: "About", vi: "Giới thiệu" });
  const settingsLabel = useLocaleEntry({ en: "Settings", vi: "Cài đặt" });
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const account = st("account");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={st("accountMenu")} className="max-w-48 gap-2">
          <UserAvatar
            name={session?.user?.name}
            email={session?.user?.email}
            image={session?.user?.image}
          />
          <span className="hidden truncate sm:inline">{session?.user?.name ?? account}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Radix popper sizes to fit-content: without a viewport-bounded
        // max-width, a long email (wrap-anywhere needs a bounded container)
        // would push the menu past a 375px viewport.
        className="max-w-[calc(100vw-1.5rem)]"
      >
        <DropdownMenuLabel>
          <p className="text-sm font-medium text-foreground">{session?.user?.name ?? account}</p>
          {/* wrap-anywhere keeps long emails inside the panel without */}
          {/* masking: the full address stays rendered and accessible. */}
          <p className="text-xs font-normal text-muted-foreground wrap-anywhere">
            {session?.user?.email}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/about" preload="intent">
            <Info className="size-4" /> {aboutLabel}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            to="/settings"
            preload="intent"
            onMouseEnter={() => preloadChunk("/settings")}
            onFocus={() => preloadChunk("/settings")}
          >
            <Settings className="size-4" /> {settingsLabel}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            // Drop workspace-scoped queries before the session dies so no
            // refetch fires against an invalidated cookie (401 noise).
            useWorkspaceStore.setState({ workspaceId: null });
            void signOutAndReset(
              queryClient,
              () => authClient.signOut(),
              () => window.location.assign("/login"),
            );
          }}
        >
          <LogOut className="size-4" /> {st("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  /** Called on link selection; the mobile sheet uses it to close itself. */
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const label = useLocaleEntry(item.label);
  const link = (
    <Link
      to={item.to}
      preload="intent"
      viewTransition
      onMouseEnter={() => preloadChunk(item.to)}
      onFocus={() => preloadChunk(item.to)}
      onClick={onNavigate}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent font-medium text-foreground before:absolute before:left-0 before:top-1/2 before:h-4 before:-translate-y-1/2 before:w-0.5 before:rounded-full before:bg-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Optional email verification is a notification, not a gate: the banner shows
 * only when the backend actually sends mail (SMTP configured, advertised via
 * public-config) and the signed-in user's Better Auth flag says unverified.
 * No SMTP → no banner. Unverified users can use the app normally.
 */
export function UnverifiedEmailBanner({ user }: { user: SessionUser | null }) {
  const [dismissed, setDismissed] = useState(false);
  const { data: config } = usePublicConfig();
  const [sending, setSending] = useState(false);
  // Hooks must run before the early return below.
  const verifyEmail = useLocaleEntry(SHELL.verifyEmail);
  const sendingLabel = useLocaleEntry(SHELL.sending);
  const resendLabel = useLocaleEntry(SHELL.resend);
  const dismissLabel = useLocaleEntry(SHELL.dismiss);
  const sentToast = useLocaleEntry(SHELL.emailSent);
  const rateLimitedToast = useLocaleEntry(SHELL.emailRateLimited);
  const failedToast = useLocaleEntry(SHELL.emailFailed);
  if (
    dismissed ||
    !config?.emailVerification.enabled ||
    !user ||
    user.emailVerified !== false ||
    !user.email
  ) {
    return null;
  }
  const resend = async () => {
    setSending(true);
    const { ok, rateLimited } = await resendVerification(user.email as string);
    setSending(false);
    if (ok) toast.success(sentToast);
    else if (rateLimited) toast.error(rateLimitedToast);
    else toast.error(failedToast);
  };
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
    >
      {/* wrap-anywhere: the email must break rather than force the row past */}
      {/* the viewport; the full sentence stays visible (no overflow mask). */}
      <span className="wrap-anywhere">{verifyEmail.replace("{email}", user.email)}</span>
      <span className="ml-auto flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => void resend()} disabled={sending}>
          {sending ? sendingLabel : resendLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          {dismissLabel}
        </Button>
      </span>
    </div>
  );
}

/** Sidebar section heading ("AI Gateway", "Billing", "Admin"), locale-aware. */
function GroupHeading({ label }: { label: LocaleEntry }) {
  return (
    <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">{useLocaleEntry(label)}</p>
  );
}

/** Shared nav body for the desktop aside and the mobile sheet. */
function NavLinks({
  pathname,
  collapsed,
  isAdmin,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  isAdmin: boolean | null;
  onNavigate?: () => void;
}) {
  const st = useShellT();
  return (
    <>
      {NAV_GROUPS.map((group, gi) => (
        <div key={gi} className={cn(gi > 0 && "mt-4")}>
          {group.label && !collapsed && <GroupHeading label={group.label} />}
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              item={item}
              active={pathname === item.to}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
      {isAdmin === true && (
        <div className="mt-4">
          {ADMIN_GROUPS.map((group, gi) => (
            <div key={gi} className={cn(gi > 0 && "mt-4")}>
              {!collapsed && <GroupHeading label={group.label} />}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  item={item}
                  active={pathname === item.to}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {isAdmin === null && !collapsed && (
        <div className="mt-4 px-2">
          <Badge variant="secondary">{st("checkingAdmin")}</Badge>
        </div>
      )}
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const st = useShellT();
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
  const { data: session } = useSession();
  // Mobile drawer: closed on route change and on link selection (Escape and
  // focus return are handled by the Radix dialog primitives underneath Sheet).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Render-time adjustment instead of an effect: no extra render pass.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setMobileNavOpen(false);
  }
  // Hover-expand: a collapsed desktop rail temporarily opens under the pointer
  // without touching the persisted store state (display-only). The aside is
  // hidden below md, so these handlers never fire for the mobile sheet.
  const [hovered, setHovered] = useState(false);
  const displayCollapsed = collapsed && !hovered;

  return (
    <TooltipProvider>
      {/* h-dvh bounds the authenticated shell so main can hand a fixed
        height to fill-list pages; main stays the default scroller for forms
        and other non-fill pages. */}
      <div className="flex h-dvh pb-safe">
        <aside
          onMouseEnter={() => collapsed && setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className={cn(
            "hidden shrink-0 flex-col border-r border-border transition-[width] duration-200 ease-in-out md:flex",
            displayCollapsed ? "w-14" : "w-52",
          )}
        >
          <div
            className={cn(
              "flex h-12 items-center gap-2 border-b border-border px-3",
              displayCollapsed && "justify-center px-0",
            )}
          >
            {/* Collapsed rail keeps a single control: the Shuffle logo itself
              acts as the expand affordance (keyboard- and pointer-reachable,
              same persisted toggle as the expanded rail's close button). */}
            {displayCollapsed ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={st("expandSidebar")}
                aria-expanded={false}
                title={st("expandSidebar")}
                onClick={toggleCollapsed}
              >
                <Shuffle className="size-4" />
              </Button>
            ) : (
              <>
                <Shuffle className="size-4 shrink-0" aria-hidden />
                <span className="text-sm font-semibold">Hoborouter</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7"
                  // The action follows the persisted state, not the hover-only
                  // expansion: a hover-expanded rail still offers Expand.
                  aria-label={collapsed ? st("expandSidebar") : st("collapseSidebar")}
                  aria-expanded={!collapsed}
                  title={collapsed ? st("expandSidebar") : st("collapseSidebar")}
                  onClick={toggleCollapsed}
                >
                  <ToggleIcon className="size-4" />
                </Button>
              </>
            )}
          </div>
          <nav className="flex-1 overflow-y-auto p-2 text-sm">
            <NavLinks pathname={pathname} collapsed={displayCollapsed} isAdmin={isAdmin} />
          </nav>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/80 pr-4 pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={st("openNavigation")}
                  className="size-11 md:hidden"
                >
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              {/* SheetContent owns the safe-area insets; no extra padding here. */}
              <SheetContent side="left">
                <SheetTitle className="flex items-center gap-2 px-1 text-sm font-semibold">
                  <Shuffle className="size-4 shrink-0" aria-hidden />
                  Hoborouter
                </SheetTitle>
                <SheetDescription className="sr-only">{st("mainNavigation")}</SheetDescription>
                <nav className="flex-1 overflow-y-auto p-2 text-sm">
                  <NavLinks
                    pathname={pathname}
                    collapsed={false}
                    isAdmin={isAdmin}
                    onNavigate={() => setMobileNavOpen(false)}
                  />
                </nav>
              </SheetContent>
            </Sheet>
            <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
              <WorkspaceSwitcher />
            </div>
            <div className="flex-1" />
            <LanguageToggle />
            <ThemeToggle />
            <Separator orientation="vertical" className="h-4" />
            <UserMenu />
          </header>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <UnverifiedEmailBanner user={session?.user ?? null} />
            {emptyWorkspaces ? <CreateWorkspace /> : children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
