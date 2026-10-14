import { useEffect, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { checkPassword } from "@hoborouter/shared";
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { useSession } from "../../lib/auth";
import { ApiError, api } from "../../lib/api";
import { formatDate, formatVnd } from "../../lib/format";
import { useWorkspaceStore } from "../../lib/workspace";
import { AdminGate, useAdminQuery, type AdminModel } from "./shared";
import { useT } from "../../lib/i18n/t";


// Admin users copy: inline LocaleEntry set (see lib/i18n/common.ts). Names,
// emails, identifiers and role values (admin/user badges) are never translated.
const usersCopy = {
  title: { en: "Users", vi: "Người dùng" },
  usersTable: { en: "Users list", vi: "Danh sách người dùng" },
  description: { en: "Instance users.", vi: "Người dùng trên instance." },
  addUser: { en: "Add user", vi: "Thêm người dùng" },
  email: { en: "Email", vi: "Email" },
  name: { en: "Name", vi: "Tên" },
  emailStatus: { en: "Email status", vi: "Trạng thái email" },
  unavailable: { en: "Unavailable", vi: "Không xác định" },
  verified: { en: "Verified", vi: "Đã xác minh" },
  unverified: { en: "Unverified", vi: "Chưa xác minh" },
  copyUserId: { en: "Copy user ID", vi: "Sao chép ID người dùng" },
  joined: { en: "Joined", vi: "Ngày tham gia" },
  role: { en: "Role", vi: "Vai trò" },
  workspaces: { en: "Workspaces", vi: "Workspace" },
  edit: { en: "Edit", vi: "Sửa" },
  resetPassword: { en: "Reset password", vi: "Đặt lại mật khẩu" },
  remove: { en: "Remove", vi: "Xóa" },
  editAria: { en: "Edit {email}", vi: "Sửa {email}" },
  resetAria: { en: "Reset password for {email}", vi: "Đặt lại mật khẩu cho {email}" },
  removeAria: { en: "Remove {email}", vi: "Xóa {email}" },
  noUsers: { en: "No users", vi: "Không có người dùng" },
  removeTitle: { en: "Remove user?", vi: "Xóa người dùng?" },
  removeDesc: {
    en: "Remove {name} ({email})? Their sessions are revoked and they can no longer sign in. Billing history is kept.",
    vi: "Xóa {name} ({email})? Các phiên của họ sẽ bị thu hồi và họ không thể đăng nhập nữa. Lịch sử thanh toán được giữ lại.",
  },
  cancel: { en: "Cancel", vi: "Hủy" },
  editTitle: { en: "Edit user", vi: "Sửa người dùng" },
  editDesc: {
    en: "Change the name or email of {name} ({email}). Changing the email revokes all of their sessions and they must sign in again.",
    vi: "Thay đổi tên hoặc email của {name} ({email}). Đổi email sẽ thu hồi tất cả phiên của họ và họ phải đăng nhập lại.",
  },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  save: { en: "Save", vi: "Lưu" },
  resetTitle: { en: "Reset password", vi: "Đặt lại mật khẩu" },
  resetDesc: {
    en: "Set a new password for {name} ({email}). No old password is needed. This signs the user out of all their sessions and they must sign in again.",
    vi: "Đặt mật khẩu mới cho {name} ({email}). Không cần mật khẩu cũ. Thao tác này đăng xuất người dùng khỏi mọi phiên và họ phải đăng nhập lại.",
  },
  newPassword: { en: "New password", vi: "Mật khẩu mới" },
  confirmPassword: { en: "Confirm new password", vi: "Xác nhận mật khẩu mới" },
  resetting: { en: "Resetting…", vi: "Đang đặt lại…" },
  createTitle: { en: "Add user", vi: "Thêm người dùng" },
  createDesc: {
    en: "Create a user with an initial password.",
    vi: "Tạo người dùng với mật khẩu ban đầu.",
  },
  password: { en: "Password", vi: "Mật khẩu" },
  instanceAdmin: { en: "Instance admin", vi: "Quản trị instance" },
  creating: { en: "Creating…", vi: "Đang tạo…" },
  create: { en: "Create", vi: "Tạo" },
  passwordRule: {
    en: "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
    vi: "Ít nhất 8 ký tự, gồm chữ hoa và chữ thường, một chữ số và một ký tự đặc biệt",
  },
  minChars: { en: "At least 8 characters", vi: "Ít nhất 8 ký tự" },
  maxChars: { en: "At most 200 characters", vi: "Tối đa 200 ký tự" },
  passwordsMismatch: { en: "Passwords do not match", vi: "Mật khẩu không khớp" },
  removeSelf: {
    en: "You cannot remove your own account. Ask another instance admin.",
    vi: "Bạn không thể xóa tài khoản của chính mình. Hãy nhờ quản trị instance khác.",
  },
  lastAdmin: {
    en: "This is the last instance admin. Promote another admin first.",
    vi: "Đây là quản trị instance cuối cùng. Hãy nâng quyền một quản trị khác trước.",
  },
  // Member-to-member ownership transfer still happens inside the workspace
  // (Settings → Members): the server transfer_to contract exists but choosing
  // a transferee needs that workspace's member list, which this page never
  // loads. The confirm action covers the no-other-members case instead.
  soleOwnerNamed: {
    en: "This user is the sole owner of: {names}. Transfer ownership first — an owner of each workspace can promote another member in that workspace's Settings → Members.",
    vi: "Người dùng này là chủ sở hữu duy nhất của: {names}. Hãy chuyển quyền sở hữu trước — chủ sở hữu của workspace có thể nâng quyền một thành viên khác trong Settings → Members của workspace đó.",
  },
  soleOwner: {
    en: "This user is the sole owner of at least one workspace. Transfer ownership first — an owner of each workspace can promote another member in that workspace's Settings → Members.",
    vi: "Người dùng này là chủ sở hữu duy nhất của ít nhất một workspace. Hãy chuyển quyền sở hữu trước — chủ sở hữu của workspace có thể nâng quyền một thành viên khác trong Settings → Members của workspace đó.",
  },
  // The sole-owner 409 offers a real second action: confirm-remove deletes
  // empty sole-owned workspaces and archives ones with history (the server
  // archives rather than deletes whenever money/ledger rows would break).
  // Member-to-member transfer keeps happening in the workspace's Settings →
  // Members (needs that workspace's member list, which this page never loads).
  soleOwnerConfirm: {
    en: "Delete workspaces and remove",
    vi: "Xóa workspace và xóa người dùng",
  },
  soleOwnerConfirmHint: {
    en: "Empty sole-owned workspaces are deleted; ones with usage or ledger history are archived (suspended, records kept). Funded wallets block removal.",
    vi: "Workspace chỉ có một chủ và trống sẽ bị xóa; workspace có lịch sử sử dụng hoặc sổ cái sẽ được lưu trữ (tạm ngưng, giữ hồ sơ). Ví còn tiền sẽ chặn việc xóa.",
  },
  workspaceFunded: {
    en: "A workspace wallet still holds funds or a reservation. Settle or withdraw the funds first; money history cannot be deleted.",
    vi: "Ví của workspace vẫn còn tiền hoặc đang có khoản đặt cọc. Hãy xử lý số tiền trước; lịch sử tiền không thể bị xóa.",
  },
  emailTaken: {
    en: "A user with this email already exists.",
    vi: "Đã tồn tại người dùng với email này.",
  },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
  updatedToast: { en: "Updated {name}", vi: "Đã cập nhật {name}" },
  resetToast: {
    en: "Password reset for {name}; all their sessions were signed out",
    vi: "Đã đặt lại mật khẩu cho {name}; tất cả phiên của họ đã bị đăng xuất",
  },
  removedToast: { en: "Removed {name}", vi: "Đã xóa {name}" },
  createdToast: { en: "User created", vi: "Đã tạo người dùng" },

  // Wallet adjustment dialog (per user).
  manageWallet: { en: "Adjust wallet", vi: "Điều chỉnh ví" },
  walletAria: { en: "Adjust wallet for {email}", vi: "Điều chỉnh ví cho {email}" },
  walletTitle: { en: "Adjust wallet", vi: "Điều chỉnh ví" },
  walletDesc: {
    en: "Adjust the TOPUP wallet balance of {name} ({email}). Pick the workspace explicitly; the change is recorded in that workspace's ledger.",
    vi: "Điều chỉnh số dư ví TOPUP của {name} ({email}). Chọn workspace rõ ràng; thay đổi được ghi vào sổ của workspace đó.",
  },
  pickWorkspace: { en: "Workspace", vi: "Workspace" },
  pickPlaceholder: { en: "Select a workspace…", vi: "Chọn một workspace…" },
  balanceLabel: { en: "Balance", vi: "Số dư" },
  reservedLabel: { en: "Reserved", vi: "Đang giữ" },
  noTopupWallet: {
    en: "This workspace has no TOPUP wallet.",
    vi: "Workspace này không có ví TOPUP.",
  },
  credit: { en: "Credit", vi: "Cộng" },
  debit: { en: "Debit", vi: "Trừ" },
  amountLabel: { en: "Amount (VND)", vi: "Số tiền (VND)" },
  amountRule: {
    en: "Enter a positive whole number of VND",
    vi: "Nhập số VND nguyên dương",
  },
  reasonLabel: { en: "Reason", vi: "Lý do" },
  review: { en: "Review", vi: "Xem lại" },
  estimateLabel: { en: "Balance will change", vi: "Số dư sẽ thay đổi" },
  apply: { en: "Apply adjustment", vi: "Áp dụng điều chỉnh" },
  applying: { en: "Applying…", vi: "Đang áp dụng…" },
  back: { en: "Back", vi: "Quay lại" },
  receiptTitle: { en: "Adjustment recorded", vi: "Đã ghi nhận điều chỉnh" },
  replayedNotice: {
    en: "This adjustment was already applied (idempotent replay); no funds moved again.",
    vi: "Điều chỉnh này đã được áp dụng trước đó (phát lại idempotent); không trừ/cộng thêm lần nữa.",
  },
  viewLedger: { en: "Open workspace ledger", vi: "Mở sổ của workspace" },
  insufficient: {
    en: "Insufficient balance: the wallet would drop below its reserved amount.",
    vi: "Số dư không đủ: ví sẽ xuống dưới mức đang giữ.",
  },
  overflow: {
    en: "The resulting balance would overflow the allowed maximum.",
    vi: "Số dư kết quả sẽ vượt quá giới hạn cho phép.",
  },
  idempotencyMismatch: {
    en: "This idempotency key was already used with different parameters. Start a new adjustment.",
    vi: "Khóa idempotency đã được dùng với tham số khác. Hãy tạo điều chỉnh mới.",
  },

  // Key management dialog (per user).
  manageKeys: { en: "Manage keys", vi: "Quản lý key" },
  keysAria: { en: "Manage keys for {email}", vi: "Quản lý key cho {email}" },
  keysTitle: { en: "API keys", vi: "API key" },
  keysDesc: {
    en: "Generic API keys of {name}'s ({email}) workspaces. Plaintext is shown only once, at grant.",
    vi: "API key chung của các workspace của {name} ({email}). Bản rõ chỉ hiển thị một lần khi tạo.",
  },
  createKey: { en: "Create key", vi: "Tạo key" },
  keyName: { en: "Key name", vi: "Tên key" },
  modelAllowlist: { en: "Model allowlist", vi: "Danh sách mô hình" },
  modelAllowlistDesc: {
    en: "Leave empty for unrestricted access to all models.",
    vi: "Để trống để cho phép truy cập mọi mô hình.",
  },
  allModels: { en: "All models", vi: "Mọi mô hình" },
  unrestrictedWarning: {
    en: "No models selected: this key will have unrestricted access to ALL models.",
    vi: "Chưa chọn mô hình nào: key này sẽ được truy cập MỌI mô hình.",
  },
  shownOnceWarning: {
    en: "This key is shown once and cannot be recovered. Copy it now.",
    vi: "Key này chỉ hiển thị một lần và không thể khôi phục. Hãy sao chép ngay.",
  },
  confirmCreate: { en: "Create key", vi: "Tạo key" },
  keyCreated: { en: "Key created — copy it now", vi: "Đã tạo key — hãy sao chép ngay" },
  copyKeyLabel: { en: "Copy key", vi: "Sao chép key" },
  done: { en: "Done", vi: "Xong" },
  noKeys: { en: "No keys in this workspace", vi: "Không có key trong workspace này" },
  statusLabel: { en: "Status", vi: "Trạng thái" },
  createdLabel: { en: "Created", vi: "Ngày tạo" },
  lastUsed: { en: "Last used", vi: "Dùng lần cuối" },
  modelsLabel: { en: "Models", vi: "Mô hình" },
  revoke: { en: "Revoke", vi: "Thu hồi" },
  revokeTitle: { en: "Revoke key {prefix}?", vi: "Thu hồi key {prefix}?" },
  revokeReasonLabel: { en: "Reason", vi: "Lý do" },
  confirmRevoke: { en: "Revoke key", vi: "Thu hồi key" },
  revoking: { en: "Revoking…", vi: "Đang thu hồi…" },
  revokedToast: { en: "Key revoked", vi: "Đã thu hồi key" },
  keyNameRequired: { en: "Key name is required", vi: "Cần tên key" },
  revokeReasonRequired: { en: "Reason is required", vi: "Cần lý do" },

  // User detail dialog (read-only account/membership/wallet/key overview).
  viewAria: { en: "Details for {email}", vi: "Chi tiết {email}" },
  detailTitle: { en: "User details", vi: "Chi tiết người dùng" },
  detailDesc: {
    en: "Account, membership, wallet and key overview of {name} ({email}). Sensitive values (passwords, key plaintext) are never shown.",
    vi: "Tổng quan tài khoản, membership, ví và key của {name} ({email}). Giá trị nhạy cảm (mật khẩu, bản rõ key) không bao giờ được hiển thị.",
  },
  sectionAccount: { en: "Account", vi: "Tài khoản" },
  sectionMemberships: { en: "Workspaces & roles", vi: "Workspace & vai trò" },
  sectionWallets: { en: "Wallet balances", vi: "Số dư ví" },
  sectionKeys: { en: "API keys", vi: "API key" },
  noMemberships: {
    en: "No workspace memberships",
    vi: "Không thuộc workspace nào",
  },
  detailKeysUnavailable: {
    en: "Keys for this workspace are unavailable",
    vi: "Không xem được key của workspace này",
  },
  close: { en: "Close", vi: "Đóng" },
  searchPlaceholder: { en: "Search name, email or ID", vi: "Tìm theo tên, email hoặc ID" },
  roleAll: { en: "All roles", vi: "Mọi vai trò" },
  roleAdmin: { en: "Admins", vi: "Quản trị" },
  roleMember: { en: "Members", vi: "Thành viên" },
  showing: { en: "Showing {from}–{to} of {total}", vi: "Hiển thị {from}–{to} của {total}" },
  prevPage: { en: "Previous", vi: "Trước" },
  nextPage: { en: "Next", vi: "Sau" },
  userActions: { en: "User actions", vi: "Thao tác người dùng" },
  viewDetail: { en: "View detail", vi: "Xem chi tiết" },
  moneyBlocking: { en: "Money blocking removal", vi: "Tiền đang chặn việc xóa" },
  availableLabel: { en: "Available", vi: "Khả dụng" },
  viewPending: { en: "View pending requests", vi: "Xem yêu cầu đang chờ" },
  pendingHeading: { en: "Pending billing in {name}", vi: "Thanh toán đang chờ trong {name}" },
  pendingOlder: { en: "…and {n} older pending records", vi: "…và {n} bản ghi chờ cũ hơn" },
  noPending: { en: "No pending billing records.", vi: "Không có bản ghi thanh toán đang chờ." },
  noFunds: { en: "No funds remain; retry removal.", vi: "Không còn tiền; thử xóa lại." },
  requestState: { en: "State", vi: "Trạng thái" },
  openRequestLog: { en: "Open in request log", vi: "Mở trong nhật ký yêu cầu" },
  subscriptionWalletNote: {
    en: "Subscription wallet: funded by the workspace subscription; no manual withdrawal.",
    vi: "Ví gói cước: được cấp từ gói đăng ký của workspace; không rút thủ công.",
  },
  resolutionHint: {
    en: "Resolution uses the existing audited controls only: adjust the wallet balance here, or review records in the request log. In-flight requests are never force-cancelled and money history is never deleted.",
    vi: "Chỉ dùng các điều khiển đã được kiểm toán: điều chỉnh số dư ví tại đây hoặc xem lại bản ghi trong nhật ký yêu cầu. Không bao giờ ép hủy yêu cầu đang chạy và lịch sử tiền không bao giờ bị xóa.",
  },
} as const;

type UsersT = (key: keyof typeof usersCopy, vars?: Record<string, string | number>) => string;

function removeErrorMessage(err: unknown, t: UsersT): string {
  if (err instanceof ApiError) {
    if (err.code === "CANNOT_REMOVE_SELF") return t("removeSelf");
    if (err.code === "LAST_ADMIN") return t("lastAdmin");
    if (err.code === "WORKSPACE_FUNDED") return t("workspaceFunded");
    if (err.code === "SOLE_OWNER") {
      const sole = err as ApiError & SoleOwnerWorkspaces;
      const names = sole.workspaces?.map((w) => w.name).join(", ");
      return names ? t("soleOwnerNamed", { names }) : t("soleOwner");
    }
    if (err.code === "EMAIL_TAKEN") return t("emailTaken");
  }
  return err instanceof Error ? err.message : t("requestFailed");
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  created_at: number;
  // EXISTS(...) over Postgres → real boolean.
  is_instance_admin: boolean;
  /** Better Auth emailVerified flag; absent on pre-email-verification payloads. */
  email_verified?: boolean;
  workspace_count: number;
}

export interface BlockedWallet {
  id: string;
  kind: string;
  balance_vnd: number;
  reserved_vnd: number;
  available_vnd: number;
}

export interface BlockedWorkspace {
  id: string;
  name: string;
  wallets: BlockedWallet[];
}

interface SoleOwnerWorkspaces {
  workspaces?: { id: string; name: string; wallets?: BlockedWallet[] }[];
}

/** Bounded pending-billing record from /admin/workspaces/:ws/pending-billing. */
export interface PendingRecord {
  request_id: string;
  created_at: number;
  status: string;
  dispatch_state: string;
  endpoint: string;
  billing_reservation: { id: string; status: string; cap_vnd: number } | null;
}

export interface UsersPageData {
  data: AdminUser[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface UsersServerControls {
  q: string;
  onQChange: (v: string) => void;
  role: string;
  onRoleChange: (v: string) => void;
  sort: "created_at" | "email" | "name";
  order: "asc" | "desc";
  onSortChange: (sort: "created_at" | "email" | "name", order: "asc" | "desc") => void;
  total: number;
  limit: number;
  offset: number;
  onOffsetChange: (o: number) => void;
}

const makeCreateSchema = (t: UsersT) =>
  z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().refine((v) => checkPassword(v).length === 0, {
      message: t("passwordRule"),
    }),
    instance_admin: z.boolean(),
  });
type CreateValues = z.infer<ReturnType<typeof makeCreateSchema>>;

const editSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
});
type EditValues = z.infer<typeof editSchema>;

const makeResetSchema = (t: UsersT) =>
  z
    .object({
      newPassword: z.string().refine((v) => checkPassword(v).length === 0, {
        message: t("passwordRule"),
      }),
      confirmPassword: z.string().min(8, t("minChars")).max(200, t("maxChars")),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: t("passwordsMismatch"),
      path: ["confirmPassword"],
    });
type ResetValues = z.infer<ReturnType<typeof makeResetSchema>>;

/** Removes a user; returns workspaces list on 409 SOLE_OWNER so UI can name them. */
async function removeUser(id: string, opts?: { confirm?: boolean }): Promise<void> {
  const res = await fetch(`/api/v1/admin/users/${id}`, {
    method: "DELETE",
    credentials: "include",
    ...(opts?.confirm ? { body: JSON.stringify({ confirm: true }) } : {}),
  });
  if (res.ok) return;
  let code = "unknown";
  let message = `Request failed (${res.status})`;
  let extra: SoleOwnerWorkspaces = {};
  try {
    const body = await res.json();
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.workspaces) extra = body.error;
  } catch {
    // non-JSON error body
  }
  const err = new ApiError(res.status, code, message) as ApiError & SoleOwnerWorkspaces;
  Object.assign(err, extra);
  throw err;
}

const USERS_LIMIT = 200;

export default function AdminUsersPage() {
  const t = useT(usersCopy);
  const { data: session } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  // Server-driven search/sort/pagination: the whole user set is never promised
  // loaded — the server reports total for the pager.
  const [qText, setQText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setQ(qText.trim()), 250);
    return () => window.clearTimeout(id);
  }, [qText]);
  const [role, setRole] = useState("");
  const [sort, setSort] = useState<"created_at" | "email" | "name">("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  // Deep link ?user=<id>&ws=<id> (opaque IDs only, payments.tsx precedent):
  // opens the user detail with the workspace's wallet context preselected.
  const [deepUser, setDeepUser] = useState<string | null>(null);
  const [deepWs, setDeepWs] = useState<string | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("user")) setDeepUser(sp.get("user"));
    if (sp.get("ws")) setDeepWs(sp.get("ws"));
  }, []);
  const params = new URLSearchParams({ sort, order, limit: String(USERS_LIMIT), offset: String(offset) });
  if (q) params.set("q", q);
  if (role) params.set("role", role);
  const query = useAdminQuery<UsersPageData>(
    ["admin", "users", { q, role, sort, order, offset }],
    `/api/v1/admin/users?${params.toString()}`,
  );
  const users = query.data?.data ?? [];
  const total = query.data?.total ?? users.length;
  // A shrunken filter result must not strand the pager past the last page.
  useEffect(() => {
    if (offset > 0 && offset >= total) setOffset(0);
  }, [offset, total]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            {t("addUser")}
          </Button>
        }
      />
      <AdminGate query={query}>
        <UsersTable
          users={users}
          currentUserId={session?.user?.id ?? null}
          serverControls={{
            q: qText,
            onQChange: setQText,
            role,
            onRoleChange: (v) => {
              setRole(v);
              setOffset(0);
            },
            sort,
            order,
            onSortChange: (s, o) => {
              setSort(s);
              setOrder(o);
              setOffset(0);
            },
            total,
            limit: USERS_LIMIT,
            offset,
            onOffsetChange: setOffset,
          }}
          deepLinkUserId={deepUser}
          deepLinkWorkspaceId={deepWs}
        />
      </AdminGate>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export function UsersTable({
  users,
  currentUserId,
  serverControls,
  deepLinkUserId,
  deepLinkWorkspaceId,
}: {
  users: AdminUser[];
  currentUserId: string | null;
  /** Present on the page (server-driven search/sort/pagination); absent in tests. */
  serverControls?: UsersServerControls;
  /** Deep link ?user=<id>&ws=<id>: open detail for this user once the list loads. */
  deepLinkUserId?: string | null;
  deepLinkWorkspaceId?: string | null;
}) {
  const t = useT(usersCopy);
  const [toRemove, setToRemove] = useState<AdminUser | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [toDetail, setToDetail] = useState<AdminUser | null>(null);
  const [toEdit, setToEdit] = useState<AdminUser | null>(null);
  const [toReset, setToReset] = useState<AdminUser | null>(null);
  const [toWallet, setToWallet] = useState<AdminUser | null>(null);
  const [toKeys, setToKeys] = useState<AdminUser | null>(null);
  const [blocked, setBlocked] = useState<BlockedWorkspace[] | null>(null);
  const [openPendingWs, setOpenPendingWs] = useState<string | null>(null);
  const [preselectWs, setPreselectWs] = useState<string | null>(deepLinkWorkspaceId ?? null);
  // Row context menu: pointer coordinates + target (Radix dropdown in
  // controlled mode with a virtual anchor — no context-menu dependency).
  const [menu, setMenu] = useState<{ user: AdminUser; x: number; y: number } | null>(null);
  const [deepOpened, setDeepOpened] = useState(false);
  useEffect(() => {
    if (deepOpened || !deepLinkUserId) return;
    const found = users.find((u) => u.id === deepLinkUserId);
    if (found) {
      setDeepOpened(true);
      setToDetail(found);
    }
  }, [deepOpened, deepLinkUserId, users]);
  const openRemove = (u: AdminUser) => {
    setRemoveError(null);
    setBlocked(null);
    setOpenPendingWs(null);
    setToRemove(u);
  };
  // Server sort header: toggle asc/desc; click again flips (created_at first
  // click = desc like the default list order).
  const sortHeader = (key: "created_at" | "email" | "name", label: string) =>
    serverControls ? (
      <button
        type="button"
        className="-mx-1 -my-3 flex items-center gap-1 px-1 py-3 hover:text-foreground"
        onClick={() =>
          serverControls.onSortChange(
            key,
            serverControls.sort === key && serverControls.order === "asc" ? "desc" : "asc",
          )
        }
      >
        {label}
        {serverControls.sort === key &&
          (serverControls.order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    ) : (
      <>{label}</>
    );

  const columns: ColumnDef<AdminUser, unknown>[] = [
    {
      accessorKey: "email",
      header: () => sortHeader("email", t("email")),
      // Row activation (click/Enter/context menu) is the single route into
      // detail; cells stay passive. Client sorting is off (server sorts).
      enableSorting: false,
      cell: (c) => <span>{c.row.original.email}</span>,
    },
    {
      accessorKey: "email_verified",
      header: t("emailStatus"),
      enableSorting: false,
      cell: (c) => {
        const verified = c.getValue() as boolean | undefined;
        // Undefined means the backend payload predates the flag: report
        // honestly instead of guessing.
        return verified === undefined ? (
          <Badge variant="secondary">{t("unavailable")}</Badge>
        ) : verified ? (
          <Badge variant="default">{t("verified")}</Badge>
        ) : (
          <Badge variant="outline">{t("unverified")}</Badge>
        );
      },
    },
    { accessorKey: "name", header: () => sortHeader("name", t("name")), enableSorting: false },
    {
      accessorKey: "created_at",
      header: () => sortHeader("created_at", t("joined")),
      enableSorting: false,
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
      ),
    },
    {
      accessorKey: "is_instance_admin",
      header: t("role"),
      enableSorting: false,
      cell: (c) =>
        c.getValue() ? (
          <Badge variant="default">admin</Badge>
        ) : (
          <Badge variant="outline">user</Badge>
        ),
    },
    { accessorKey: "workspace_count", header: t("workspaces"), enableSorting: false },
    {
      accessorKey: "id",
      header: "ID",
      // Copy lives inside the detail dialog/context menu; no per-row button.
      enableSorting: false,
      cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string).slice(0, 8)}…</span>,
    },
  ];

  return (
    <>
      {serverControls && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t("searchPlaceholder")}
            placeholder={t("searchPlaceholder")}
            value={serverControls.q}
            onChange={(e) => serverControls.onQChange(e.target.value)}
            className="max-w-64"
          />
          <select
            aria-label={t("role")}
            value={serverControls.role}
            onChange={(e) => serverControls.onRoleChange(e.target.value)}
            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">{t("roleAll")}</option>
            <option value="admin">{t("roleAdmin")}</option>
            <option value="member">{t("roleMember")}</option>
          </select>
        </div>
      )}
      <DataTable
        columns={columns}
        data={users}
        empty={t("noUsers")}
        scroll={{ label: t("usersTable"), fill: true }}
        onRowActivate={(u) => setToDetail(u)}
        onRowContextMenu={(u, pos) => setMenu({ user: u, x: pos.x, y: pos.y })}
        rowAriaLabel={(u) => t("viewAria", { email: u.email })}
      />
      {serverControls && serverControls.total > serverControls.limit && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("showing", {
              from: serverControls.offset + 1,
              to: Math.min(serverControls.offset + serverControls.limit, serverControls.total),
              total: serverControls.total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={serverControls.offset === 0}
              onClick={() =>
                serverControls.onOffsetChange(
                  Math.max(0, serverControls.offset - serverControls.limit),
                )
              }
            >
              {t("prevPage")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={serverControls.offset + serverControls.limit >= serverControls.total}
              onClick={() => serverControls.onOffsetChange(serverControls.offset + serverControls.limit)}
            >
              {t("nextPage")}
            </Button>
          </div>
        </div>
      )}
      {/* Row context menu: same actions as the detail footer, keyboard-operable
          (Shift+F10 opens; Radix provides menu role/Escape/focus handling). */}
      <DropdownMenu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        {/* Zero-size trigger anchored at the pointer: the installed Radix
            dropdown-menu has no virtualRef, so the anchor is a real element. */}
        <DropdownMenuTrigger
          tabIndex={-1}
          aria-label={t("userActions")}
          style={{
            position: "fixed",
            left: menu?.x ?? 0,
            top: menu?.y ?? 0,
            width: 0,
            height: 0,
            padding: 0,
            border: "none",
          }}
        />
        <DropdownMenuContent align="start">
          {menu && (
            <>
              <DropdownMenuItem onSelect={() => setToDetail(menu.user)}>{t("viewDetail")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setToEdit(menu.user)}>{t("edit")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setToReset(menu.user)}>{t("resetPassword")}</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setPreselectWs(null);
                  setToWallet(menu.user);
                }}
              >
                {t("manageWallet")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setToKeys(menu.user)}>{t("manageKeys")}</DropdownMenuItem>
              {menu.user.id !== currentUserId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => openRemove(menu.user)}>
                    {t("remove")}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) {
            setToRemove(null);
            setRemoveError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDesc", {
                name: toRemove?.name ?? "",
                email: toRemove?.email ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          {removeError && <p className="text-destructive text-sm">{removeError}</p>}
          {blocked && toRemove && (
            <section aria-label={t("moneyBlocking")} className="space-y-2 rounded-md border p-3 text-sm">
              <p className="font-medium">{t("moneyBlocking")}</p>
              <p className="text-muted-foreground text-xs">{t("resolutionHint")}</p>
              {blocked.map((ws) => (
                <div key={ws.id} className="space-y-2 rounded border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{ws.name}</p>
                    <a
                      href={`/admin/users?user=${toRemove.id}&ws=${ws.id}`}
                      className="text-xs underline underline-offset-4"
                    >
                      {t("viewDetail")}
                    </a>
                  </div>
                  {ws.wallets.length === 0 && (
                    <p className="text-muted-foreground text-xs">{t("noFunds")}</p>
                  )}
                  {ws.wallets.map((w) => (
                    <div key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge variant="outline">{w.kind}</Badge>
                      {w.kind === "topup" ? (
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          onClick={() => {
                            setPreselectWs(ws.id);
                            setToWallet(toRemove);
                          }}
                        >
                          {t("balanceLabel")}: {formatVnd(w.balance_vnd)}
                        </button>
                      ) : (
                        <span>
                          {t("balanceLabel")}: {formatVnd(w.balance_vnd)} — {t("subscriptionWalletNote")}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-expanded={openPendingWs === ws.id}
                        className="underline underline-offset-4"
                        onClick={() => setOpenPendingWs(openPendingWs === ws.id ? null : ws.id)}
                      >
                        {t("reservedLabel")}: {formatVnd(w.reserved_vnd)}
                      </button>
                      <span>
                        {t("availableLabel")}: {formatVnd(w.available_vnd)}
                      </span>
                    </div>
                  ))}
                  {openPendingWs === ws.id && (
                    <PendingList workspaceId={ws.id} workspaceName={ws.name} />
                  )}
                </div>
              ))}
            </section>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRemove(null)}>
              {t("cancel")}
            </Button>
            {toRemove && (
              <RemoveButton
                user={toRemove}
                t={t}
                onError={setRemoveError}
                onBlocked={setBlocked}
                onDone={() => setToRemove(null)}
              />
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toDetail && (
        <UserDetailDialog
          user={toDetail}
          currentUserId={currentUserId}
          onClose={() => setToDetail(null)}
          onEdit={(u) => {
            setToDetail(null);
            setToEdit(u);
          }}
          onReset={(u) => {
            setToDetail(null);
            setToReset(u);
          }}
          onWallet={(u) => {
            setToDetail(null);
            setToWallet(u);
          }}
          onKeys={(u) => {
            setToDetail(null);
            setToKeys(u);
          }}
          onRemove={(u) => {
            // Close detail first, THEN open the confirm dialog on a later
            // tick: unmounting one Radix layer while mounting another in the
            // same commit corrupts the dismissable-layer stack.
            setToDetail(null);
            window.setTimeout(() => openRemove(u), 0);
          }}
        />
      )}
      {toEdit && (
        <EditUserDialog
          user={toEdit}
          currentUserId={currentUserId}
          onClose={() => setToEdit(null)}
        />
      )}
      {toReset && <ResetPasswordDialog user={toReset} onClose={() => setToReset(null)} />}
      {toWallet && (
        <ManageWalletDialog
          user={toWallet}
          initialWorkspaceId={preselectWs ?? undefined}
          onClose={() => {
            setToWallet(null);
            setPreselectWs(null);
          }}
        />
      )}
      {toKeys && <ManageKeysDialog user={toKeys} onClose={() => setToKeys(null)} />}
    </>
  );
}

function EditUserDialog({
  user,
  currentUserId,
  onClose,
}: {
  user: AdminUser;
  currentUserId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const t = useT(usersCopy);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: user.name, email: user.email },
  });

  const save = useMutation({
    mutationFn: (values: EditValues) =>
      api<{ user: { id: string; name: string; email: string } }>(`/api/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
        }),
      }),
    onSuccess: (data) => {
      toast.success(t("updatedToast", { name: data.user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // An email change revokes the target's sessions server-side; if the
      // admin edited their own email, refresh the local session store.
      if (data.user.email !== user.email && user.id === currentUserId) void refetchSession();
      onClose();
    },
    onError: (err) => {
      // Duplicate email maps onto the email field; everything else inline.
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
        form.setError("email", { message: t("emailTaken") });
      } else {
        setFormError(err instanceof Error ? err.message : t("requestFailed"));
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>
            {t("editDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit((values) => save.mutate(values))}>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Ada Lovelace" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("email")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="ada@example.com" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {formError && <p className="text-destructive text-sm">{formError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  onClose();
                }}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("saving") : t("save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const t = useT(usersCopy);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ResetValues>({
    resolver: zodResolver(makeResetSchema(t)),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const reset = useMutation({
    mutationFn: (values: ResetValues) =>
      api<{ success: boolean }>(`/api/v1/admin/users/${user.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword: values.newPassword }),
      }),
    onSuccess: () => {
      // The toast never contains the password.
      toast.success(t("resetToast", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // The reset revokes sessions server-side; if the admin reset their own
      // password, refresh the local session store.
      void refetchSession();
      onClose();
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : t("requestFailed")),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("resetTitle")}</DialogTitle>
          <DialogDescription>
            {t("resetDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => reset.mutate(values))}
          >
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("newPassword")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("confirmPassword")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {formError && <p className="text-destructive text-sm">{formError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={reset.isPending}>
                {reset.isPending ? t("resetting") : t("resetPassword")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveButton({
  user,
  t,
  onError,
  onBlocked,
  onDone,
}: {
  user: AdminUser;
  t: UsersT;
  onError: (message: string) => void;
  /** WORKSPACE_FUNDED 409: exact server-locked blocked wallets for the UI. */
  onBlocked: (workspaces: BlockedWorkspace[]) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  // Second stage after a 409 SOLE_OWNER: an explicit confirm asks the server to
  // resolve the sole-owned workspaces (delete empty ones, archive ones with
  // history). The server still refuses funded wallets (WORKSPACE_FUNDED).
  const [soleWorkspaces, setSoleWorkspaces] = useState<NonNullable<
    SoleOwnerWorkspaces["workspaces"]
  > | null>(null);
  const remove = useMutation({
    mutationFn: (confirm: boolean) => removeUser(user.id, confirm ? { confirm: true } : undefined),
    onSuccess: () => {
      toast.success(t("removedToast", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onDone();
    },
    onError: (err) => {
      onError(removeErrorMessage(err, t));
      if (err instanceof ApiError && err.code === "WORKSPACE_FUNDED") {
        const funded = err as ApiError & SoleOwnerWorkspaces;
        onBlocked(
          (funded.workspaces ?? []).filter(
            (w): w is BlockedWorkspace => Array.isArray((w as BlockedWorkspace).wallets),
          ),
        );
      }
      if (err instanceof ApiError && err.code === "SOLE_OWNER") {
        const sole = err as ApiError & SoleOwnerWorkspaces;
        setSoleWorkspaces(sole.workspaces && sole.workspaces.length > 0 ? sole.workspaces : null);
      } else {
        setSoleWorkspaces(null);
      }
    },
  });
  return (
    <div className="flex items-center gap-2">
      {soleWorkspaces && (
        <div className="flex flex-col items-end gap-2 text-right">
          <p className="text-muted-foreground max-w-xs text-sm">{t("soleOwnerConfirmHint")}</p>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(true)}
          >
            {t("soleOwnerConfirm")}
          </Button>
        </div>
      )}
      <Button
        variant="destructive"
        disabled={remove.isPending}
        onClick={() => remove.mutate(false)}
      >
        {remove.isPending ? t("resetting") : t("remove")}
      </Button>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const t = useT(usersCopy);
  const form = useForm<CreateValues>({
    resolver: zodResolver(makeCreateSchema(t)),
    defaultValues: { name: "", email: "", password: "", instance_admin: false },
  });

  const create = useMutation({
    mutationFn: (values: CreateValues) =>
      api<{ id: string }>("/api/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
          password: values.password,
          instance_admin: values.instance_admin,
        }),
      }),
    onSuccess: () => {
      toast.success(t("createdToast"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onOpenChange(false);
      form.reset();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Ada Lovelace" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("email")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="ada@example.com" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("password")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="instance_admin"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                  <FormLabel className="font-normal">{t("instanceAdmin")}</FormLabel>
                </FormItem>
              )}
            />
            {create.error && (
              <p className="text-destructive text-sm">{removeErrorMessage(create.error, t)}</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t("creating") : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// --- Per-user wallet adjustment + key management (frozen admin contracts) ---

export interface UserWorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

export interface UserTopupWallet {
  workspaceId: string;
  kind: "topup";
  balance: number;
  reserved: number;
}

export interface AdminUserContext {
  memberships: UserWorkspaceMembership[];
  wallets: UserTopupWallet[];
}

export interface AdjustReceipt {
  ledgerEntryId: string;
  balanceBefore: number;
  balanceAfter: number;
  reserved: number;
  workspaceId: string;
  replayed: boolean;
}

export interface AdminWorkspaceKey {
  id: string;
  name: string;
  key_prefix: string;
  status: "enabled" | "disabled" | "revoked";
  created_at: number;
  last_used_at: number | null;
  modelIds: string[];
}

/** Frozen C-contract: memberships + per-workspace TOPUP wallet balances. */
function useUserContext(userId: string) {
  return useQuery<AdminUserContext>({
    queryKey: ["admin", "users", userId, "context"],
    queryFn: () => api<AdminUserContext>(`/api/v1/admin/users/${userId}/context`),
    retry: false,
  });
}

function walletErrorMessage(err: unknown, t: UsersT): string {
  if (err instanceof ApiError) {
    if (err.code === "INSUFFICIENT") return t("insufficient");
    if (err.code === "OVERFLOW") return t("overflow");
    if (err.code === "IDEMPOTENCY_MISMATCH") return t("idempotencyMismatch");
  }
  return err instanceof Error ? err.message : t("requestFailed");
}

interface WalletAttempt {
  workspaceId: string;
  delta: number;
  reason: string;
  idempotencyKey: string;
  gen: number;
}

function ManageWalletDialog({
  user,
  onClose,
  initialWorkspaceId,
}: {
  user: AdminUser;
  onClose: () => void;
  /** Deep link / blocked-wallet flow: workspace preselected on open. */
  initialWorkspaceId?: string;
}) {
  const queryClient = useQueryClient();
  const t = useT(usersCopy);
  const contextQuery = useUserContext(user.id);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [mode, setMode] = useState<"credit" | "debit">("credit");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "confirm" | "receipt">("form");
  const [receipt, setReceipt] = useState<AdjustReceipt | null>(null);
  // Submit attempt: the idempotency key is minted once per confirmed attempt
  // and REUSED on retry so a lost response replays instead of double-charging.
  const [attempt, setAttempt] = useState<WalletAttempt | null>(null);
  const genRef = useRef(0);
  // gen of the attempt currently being dispatched (per-attempt, not shared:
  // a second, different attempt may start while the first is in flight).
  const [pendingGen, setPendingGen] = useState<number | null>(null);
  const pendingGenRef = useRef<number | null>(null);

  const memberships = contextQuery.data?.memberships ?? [];
  const wallets = contextQuery.data?.wallets ?? [];
  const selectedWallet = wallets.find((w) => w.workspaceId === workspaceId && w.kind === "topup");
  const selectedMembership = memberships.find((m) => m.workspaceId === workspaceId);

  const amount = /^\d+$/.test(amountText.trim()) ? Number(amountText.trim()) : 0;
  const amountValid = Number.isSafeInteger(amount) && amount > 0;
  const reasonValid = reason.trim().length > 0;
  const targetValid = workspaceId !== "" && selectedWallet !== undefined;

  const adjust = useMutation({
    mutationFn: async (v: WalletAttempt) => {
      const res = await api<AdjustReceipt>(
        `/api/v1/admin/workspaces/${v.workspaceId}/wallet/adjust`,
        {
          method: "POST",
          body: JSON.stringify({
            delta: v.delta,
            reason: v.reason,
            idempotencyKey: v.idempotencyKey,
          }),
        },
      );
      return { res, v };
    },
    onSuccess: ({ res, v }) => {
      // The dispatch landed regardless of where the admin is now: the captured
      // context cache must refresh even when the UI result is dropped.
      void queryClient.invalidateQueries({ queryKey: ["admin", "users", user.id, "context"] });
      // Stale completion: a newer attempt owns the dialog; drop silently
      // (the financial dispatch itself is never cancelled).
      if (v.gen !== genRef.current) return;
      if (pendingGenRef.current === v.gen) {
        pendingGenRef.current = null;
        setPendingGen(null);
      }
      setReceipt(res);
      setStep("receipt");
    },
    onError: (err, v) => {
      if (v.gen !== genRef.current) return;
      if (pendingGenRef.current === v.gen) {
        pendingGenRef.current = null;
        setPendingGen(null);
      }
      setFormError(walletErrorMessage(err, t));
    },
  });

  const switchWorkspace = (id: string) => {
    // Context switch drops pending UX state; an in-flight dispatch keeps
    // running. Bumping the generation retires every result still in flight —
    // otherwise a late completion would re-open its receipt inside the NEW
    // workspace's panel. The retired attempt's pending claim is released too.
    genRef.current++;
    if (pendingGenRef.current !== null) {
      pendingGenRef.current = null;
      setPendingGen(null);
    }
    setWorkspaceId(id);
    setStep("form");
    setFormError(null);
    setReceipt(null);
    setMode("credit");
    setAmountText("");
    setReason("");
  };

  const apply = () => {
    if (!targetValid || !amountValid || !reasonValid) return;
    const delta = mode === "credit" ? amount : -amount;
    let useAttempt = attempt;
    if (
      !useAttempt ||
      useAttempt.workspaceId !== workspaceId ||
      useAttempt.delta !== delta ||
      useAttempt.reason !== reason.trim()
    ) {
      useAttempt = {
        workspaceId,
        delta,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
        gen: ++genRef.current,
      };
      setAttempt(useAttempt);
    }
    pendingGenRef.current = useAttempt.gen;
    setPendingGen(useAttempt.gen);
    adjust.mutate(useAttempt);
  };

  const estimate =
    targetValid && amountValid
      ? selectedWallet.balance + (mode === "credit" ? amount : -amount)
      : null;
  // "Applying…" only while THIS exact attempt is in flight; a changed
  // payload is a new attempt and must stay applicable.
  const pendingThisAttempt =
    pendingGen !== null &&
    attempt !== null &&
    attempt.workspaceId === workspaceId &&
    attempt.delta === (mode === "credit" ? amount : -amount) &&
    attempt.reason === reason.trim();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          // Closing retires in-flight completions the same way a switch does:
          // after unmount their state writes would be no-ops anyway, but the
          // retirement makes the drop explicit and covers any pre-unmount tick.
          genRef.current++;
          if (pendingGenRef.current !== null) {
            pendingGenRef.current = null;
            setPendingGen(null);
          }
        }
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("walletTitle")}</DialogTitle>
          <DialogDescription>
            {t("walletDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="wallet-ws-select" className="text-sm font-medium">
                {t("pickWorkspace")}
              </label>
              <select
                id="wallet-ws-select"
                aria-label={t("pickWorkspace")}
                value={workspaceId}
                onChange={(e) => switchWorkspace(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
              >
                <option value="">{t("pickPlaceholder")}</option>
                {memberships.map((m) => (
                  <option key={m.workspaceId} value={m.workspaceId}>
                    {m.workspaceName}
                  </option>
                ))}
              </select>
            </div>
            {workspaceId !== "" && selectedWallet === undefined && (
              <p className="text-destructive text-sm">{t("noTopupWallet")}</p>
            )}
            {selectedWallet && (
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">{selectedMembership?.workspaceName}</p>
                <p>
                  {t("balanceLabel")}: {formatVnd(selectedWallet.balance)}
                </p>
                <p>
                  {t("reservedLabel")}: {formatVnd(selectedWallet.reserved)}
                </p>
              </div>
            )}
            {targetValid && (
              <>
                <div className="flex gap-2" role="group" aria-label={t("walletTitle")}>
                  <Button
                    type="button"
                    variant={mode === "credit" ? "default" : "outline"}
                    size="sm"
                    aria-pressed={mode === "credit"}
                    onClick={() => setMode("credit")}
                  >
                    {t("credit")}
                  </Button>
                  <Button
                    type="button"
                    variant={mode === "debit" ? "default" : "outline"}
                    size="sm"
                    aria-pressed={mode === "debit"}
                    onClick={() => setMode("debit")}
                  >
                    {t("debit")}
                  </Button>
                </div>
                <div className="space-y-1">
                  <label htmlFor="wallet-amount" className="text-sm font-medium">
                    {t("amountLabel")}
                  </label>
                  <Input
                    id="wallet-amount"
                    aria-label={t("amountLabel")}
                    inputMode="numeric"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                    placeholder="50000"
                  />
                  <p className="text-muted-foreground text-xs">{t("amountRule")}</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="wallet-reason" className="text-sm font-medium">
                    {t("reasonLabel")}
                  </label>
                  <Input
                    id="wallet-reason"
                    aria-label={t("reasonLabel")}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              </>
            )}
            {formError && <p className="text-destructive text-sm">{formError}</p>}
          </div>
        )}

        {step === "confirm" && targetValid && amountValid && reasonValid && (
          <div className="space-y-3 text-sm" aria-live="polite">
            <p className="font-medium">{selectedMembership?.workspaceName}</p>
            <p>{formatVnd(mode === "credit" ? amount : -amount)}</p>
            <p>{reason.trim()}</p>
            <p>
              {t("estimateLabel")}: {formatVnd(selectedWallet.balance)} →{" "}
              {formatVnd(estimate ?? selectedWallet.balance)}
            </p>
            {formError && <p className="text-destructive text-sm">{formError}</p>}
          </div>
        )}

        {step === "receipt" && receipt && (
          <div className="space-y-2 text-sm" role="status" aria-live="polite">
            <p className="font-medium">{t("receiptTitle")}</p>
            <p>
              {t("balanceLabel")}: {formatVnd(receipt.balanceBefore)} →{" "}
              {formatVnd(receipt.balanceAfter)}
            </p>
            <p>
              {t("reservedLabel")}: {formatVnd(receipt.reserved)}
            </p>
            {receipt.replayed && (
              <p className="text-muted-foreground text-xs">{t("replayedNotice")}</p>
            )}
            {/* Workspace context travels with the link so the admin never
                lands in the wrong workspace's ledger. */}
            <a
              href="/billing/credits"
              data-workspace-id={receipt.workspaceId}
              onClick={() => {
                useWorkspaceStore.getState().setWorkspaceId(receipt.workspaceId);
              }}
              className="text-sm underline underline-offset-4"
            >
              {t("viewLedger")}
            </a>
          </div>
        )}

        <DialogFooter>
          {step === "form" && (
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
          )}
          {step === "form" && targetValid && (
            <Button
              type="button"
              disabled={!amountValid || !reasonValid}
              onClick={() => {
                setFormError(null);
                setStep("confirm");
              }}
            >
              {t("review")}
            </Button>
          )}
          {step === "confirm" && (
            <Button type="button" variant="outline" onClick={() => setStep("form")}>
              {t("back")}
            </Button>
          )}
          {step === "confirm" && (
            <Button type="button" disabled={pendingThisAttempt} onClick={apply}>
              {pendingThisAttempt ? t("applying") : t("apply")}
            </Button>
          )}
          {step === "receipt" && (
            <Button type="button" onClick={onClose}>
              {t("done")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface GrantResponse {
  id: string;
  name: string;
  plaintext: string;
  modelIds: string[];
}

function ManageKeysDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const t = useT(usersCopy);
  const contextQuery = useUserContext(user.id);
  const [workspaceId, setWorkspaceId] = useState("");
  const [grantStep, setGrantStep] = useState<"idle" | "confirm" | "plaintext">("idle");
  const [keyName, setKeyName] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  // Plaintext lives ONLY in this dialog's state: cleared when leaving the
  // step, on workspace switch, and on unmount. Never persisted or logged.
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminWorkspaceKey | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const genRef = useRef(0);

  const memberships = contextQuery.data?.memberships ?? [];

  // Real backend (apps/api/src/routes/admin-keys.ts) returns a bare array.
  const keysQuery = useQuery<AdminWorkspaceKey[]>({
    queryKey: ["admin", "user-keys", user.id, workspaceId],
    queryFn: () => api<AdminWorkspaceKey[]>(`/api/v1/admin/workspaces/${workspaceId}/keys`),
    enabled: workspaceId !== "",
    retry: false,
  });

  // Real backend (apps/api/src/routes/admin-catalog.ts) returns a bare array;
  // the allowlist carries DB model ids, which is what the grant endpoint
  // validates (public ids are display-only).
  const modelsQuery = useQuery<AdminModel[]>({
    queryKey: ["admin", "catalog", "models"],
    queryFn: () => api<AdminModel[]>("/api/v1/admin/catalog/models"),
    enabled: workspaceId !== "",
    retry: false,
  });
  const modelLabels = new Map(
    (Array.isArray(modelsQuery.data) ? modelsQuery.data : []).map((m) => [
      m.id,
      m.display_name || m.public_id || m.id,
    ]),
  );

  const grant = useMutation({
    mutationFn: async (v: {
      name: string;
      modelIds: string[];
      gen: number;
      workspaceId: string;
    }) => {
      const res = await api<GrantResponse>(`/api/v1/admin/workspaces/${v.workspaceId}/keys`, {
        method: "POST",
        body: JSON.stringify({ name: v.name, modelIds: v.modelIds }),
      });
      return { res, v };
    },
    onSuccess: ({ res, v }) => {
      // The dispatch landed for v.workspaceId regardless of where the admin
      // is now: refresh that cache even when the UI result is dropped.
      void queryClient.invalidateQueries({
        queryKey: ["admin", "user-keys", user.id, v.workspaceId],
      });
      if (v.gen !== genRef.current) return;
      setPlaintext(res.plaintext);
      setGrantStep("plaintext");
    },
    onError: (err, v) => {
      if (v.gen !== genRef.current) return;
      setPanelError(err instanceof Error ? err.message : t("requestFailed"));
      setGrantStep("idle");
    },
  });

  const revoke = useMutation({
    mutationFn: async (v: { keyId: string; reason: string; gen: number; workspaceId: string }) => {
      const res = await api<{ status: string }>(
        `/api/v1/admin/workspaces/${v.workspaceId}/keys/${v.keyId}/revoke`,
        { method: "POST", body: JSON.stringify({ reason: v.reason }) },
      );
      return { res, v };
    },
    onSuccess: (_data, v) => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "user-keys", user.id, v.workspaceId],
      });
      if (v.gen !== genRef.current) return;
      toast.success(t("revokedToast"));
      setRevokeTarget(null);
      setRevokeReason("");
    },
    onError: (err, v) => {
      if (v.gen !== genRef.current) return;
      setPanelError(err instanceof Error ? err.message : t("requestFailed"));
    },
  });

  const switchWorkspace = (id: string) => {
    // Pending grant/revoke UX is dropped on context switch; in-flight
    // dispatches keep running. Bumping the generation retires every result
    // still in flight — otherwise a late grant would surface its plaintext
    // inside the NEW workspace's panel.
    genRef.current++;
    setWorkspaceId(id);
    setGrantStep("idle");
    setKeyName("");
    setSelectedModels([]);
    setPlaintext(null);
    setPanelError(null);
    setRevokeTarget(null);
    setRevokeReason("");
  };

  const submitGrant = () => {
    if (!keyName.trim()) {
      setPanelError(t("keyNameRequired"));
      return;
    }
    grant.mutate({
      name: keyName.trim(),
      modelIds: selectedModels,
      gen: ++genRef.current,
      workspaceId,
    });
  };

  const submitRevoke = () => {
    if (!revokeTarget || !revokeReason.trim()) return;
    revoke.mutate({
      keyId: revokeTarget.id,
      reason: revokeReason.trim(),
      gen: ++genRef.current,
      workspaceId,
    });
  };

  const keys = Array.isArray(keysQuery.data) ? keysQuery.data : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("keysTitle")}</DialogTitle>
          <DialogDescription>
            {t("keysDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="keys-ws-select" className="text-sm font-medium">
            {t("pickWorkspace")}
          </label>
          <select
            id="keys-ws-select"
            aria-label={t("pickWorkspace")}
            value={workspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">{t("pickPlaceholder")}</option>
            {memberships.map((m) => (
              <option key={m.workspaceId} value={m.workspaceId}>
                {m.workspaceName}
              </option>
            ))}
          </select>
        </div>

        {workspaceId !== "" && keysQuery.isError && (
          <p className="text-destructive text-sm">
            {keysQuery.error instanceof Error ? keysQuery.error.message : t("requestFailed")}
          </p>
        )}

        {workspaceId !== "" && !keysQuery.isError && (
          <>
            {keysQuery.isPending ? (
              <p className="text-muted-foreground text-sm">…</p>
            ) : keys.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("noKeys")}</p>
            ) : (
              <ul className="space-y-2">
                {keys.map((k) => (
                  <li key={k.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{k.name}</span>
                      <Badge variant={k.status === "revoked" ? "outline" : "default"}>
                        {k.status}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs">{k.key_prefix}…</p>
                    <p className="text-muted-foreground text-xs">
                      {t("createdLabel")}: {formatDate(new Date(k.created_at))}
                      {" · "}
                      {t("lastUsed")}: {k.last_used_at ? formatDate(new Date(k.last_used_at)) : "—"}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("modelsLabel")}:{" "}
                      {k.modelIds.length === 0
                        ? t("allModels")
                        : k.modelIds.map((id) => modelLabels.get(id) ?? id).join(", ")}
                    </p>
                    {k.status !== "revoked" && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          setRevokeTarget(k);
                          setRevokeReason("");
                          setPanelError(null);
                        }}
                      >
                        {t("revoke")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {revokeTarget && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">
                  {t("revokeTitle", { prefix: revokeTarget.key_prefix })}
                </p>
                <label htmlFor="revoke-reason" className="text-sm font-medium">
                  {t("revokeReasonLabel")}
                </label>
                <Input
                  id="revoke-reason"
                  aria-label={t("revokeReasonLabel")}
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(null)}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={revoke.isPending || !revokeReason.trim()}
                    onClick={submitRevoke}
                  >
                    {revoke.isPending ? t("revoking") : t("confirmRevoke")}
                  </Button>
                </div>
              </div>
            )}

            {grantStep === "idle" && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t("createKey")}</p>
                <div className="space-y-1">
                  <label htmlFor="grant-name" className="text-sm font-medium">
                    {t("keyName")}
                  </label>
                  <Input
                    id="grant-name"
                    aria-label={t("keyName")}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">{t("modelAllowlist")}</legend>
                  <p className="text-muted-foreground text-xs">{t("modelAllowlistDesc")}</p>
                  {(modelsQuery.data ?? []).map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedModels.includes(m.id)}
                        onChange={() =>
                          setSelectedModels((prev) =>
                            prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                          )
                        }
                        className="size-4 accent-current"
                      />
                      <span>{m.display_name || m.public_id}</span>
                      <span className="font-mono text-xs text-muted-foreground">{m.public_id}</span>
                    </label>
                  ))}
                </fieldset>
                {panelError && <p className="text-destructive text-sm">{panelError}</p>}
                <Button
                  type="button"
                  size="sm"
                  disabled={!keyName.trim()}
                  onClick={() => {
                    setPanelError(null);
                    setGrantStep("confirm");
                  }}
                >
                  {t("createKey")}
                </Button>
              </div>
            )}

            {grantStep === "confirm" && (
              <div className="space-y-2 rounded-md border p-3 text-sm" aria-live="polite">
                <p className="font-medium">{keyName.trim()}</p>
                <p>
                  {t("modelsLabel")}:{" "}
                  {selectedModels.length === 0
                    ? t("allModels")
                    : selectedModels.map((id) => modelLabels.get(id) ?? id).join(", ")}
                </p>
                {selectedModels.length === 0 && (
                  <p className="text-destructive text-sm">{t("unrestrictedWarning")}</p>
                )}
                <p className="text-destructive text-sm">{t("shownOnceWarning")}</p>
                {panelError && <p className="text-destructive text-sm">{panelError}</p>}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setGrantStep("idle")}
                  >
                    {t("back")}
                  </Button>
                  <Button type="button" size="sm" disabled={grant.isPending} onClick={submitGrant}>
                    {grant.isPending ? t("applying") : t("confirmCreate")}
                  </Button>
                </div>
              </div>
            )}

            {grantStep === "plaintext" && plaintext && (
              <div className="space-y-2 rounded-md border p-3" role="status" aria-live="polite">
                <p className="text-sm font-medium">{t("keyCreated")}</p>
                <p className="text-destructive text-sm">{t("shownOnceWarning")}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {plaintext}
                  </code>
                  <CopyButton value={plaintext} label={t("copyKeyLabel")} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    // Leaving the step destroys the plaintext for good.
                    setPlaintext(null);
                    setGrantStep("idle");
                    setKeyName("");
                    setSelectedModels([]);
                  }}
                >
                  {t("done")}
                </Button>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Bounded pending-billing inspection (from the 409 blocked-wallet section) ---

function PendingList({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const t = useT(usersCopy);
  const pendingQuery = useQuery<{ data: PendingRecord[]; total: number; limit: number }>({
    queryKey: ["admin", "pending-billing", workspaceId],
    queryFn: () => api(`/api/v1/admin/workspaces/${workspaceId}/pending-billing`),
    retry: false,
  });
  const rows = pendingQuery.data?.data ?? [];
  const older = Math.max(0, (pendingQuery.data?.total ?? 0) - rows.length);
  return (
    <div className="space-y-1 rounded border bg-muted/30 p-2 text-xs">
      <p className="font-medium">{t("pendingHeading", { name: workspaceName })}</p>
      {pendingQuery.isPending && <p className="text-muted-foreground">…</p>}
      {pendingQuery.isError && (
        <p className="text-destructive">
          {pendingQuery.error instanceof Error ? pendingQuery.error.message : t("requestFailed")}
        </p>
      )}
      {!pendingQuery.isPending && !pendingQuery.isError && rows.length === 0 && (
        <p className="text-muted-foreground">{t("noPending")}</p>
      )}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.request_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={`/admin/request-log?request=${r.request_id}`}
              className="font-mono underline underline-offset-4"
            >
              {r.request_id.slice(0, 8)}…
            </a>
            <Badge variant="outline">{r.dispatch_state}</Badge>
            <span className="text-muted-foreground">
              {t("statusLabel")}: {r.status} · {t("requestState")}:{" "}
              {r.billing_reservation ? `${r.billing_reservation.status} · ${formatVnd(r.billing_reservation.cap_vnd)}` : "—"}
            </span>
            <span className="text-muted-foreground">{t("openRequestLog")}</span>
          </li>
        ))}
      </ul>
      {older > 0 && <p className="text-muted-foreground">{t("pendingOlder", { n: older })}</p>}
    </div>
  );
}

// --- Read-only user detail (clickable from the email column) ---

/** Per-workspace key overview: null keys means the list failed to load. */
interface WorkspaceKeysOverview {
  workspaceId: string;
  keys: AdminWorkspaceKey[] | null;
}

function UserDetailDialog({
  user,
  currentUserId,
  onClose,
  onEdit,
  onReset,
  onWallet,
  onKeys,
  onRemove,
}: {
  user: AdminUser;
  currentUserId: string | null;
  onClose: () => void;
  onEdit: (user: AdminUser) => void;
  onReset: (user: AdminUser) => void;
  onWallet: (user: AdminUser) => void;
  onKeys: (user: AdminUser) => void;
  onRemove: (user: AdminUser) => void;
}) {
  const t = useT(usersCopy);
  const contextQuery = useUserContext(user.id);
  const memberships = contextQuery.data?.memberships ?? [];
  const wallets = contextQuery.data?.wallets ?? [];
  const workspaceNames = new Map(memberships.map((m) => [m.workspaceId, m.workspaceName]));

  // All membership workspaces in one shot (each list endpoint is
  // per-workspace). A failed workspace renders an honest unavailable note
  // instead of failing the whole overview.
  const keysOverviewQuery = useQuery<WorkspaceKeysOverview[]>({
    queryKey: ["admin", "user-detail-keys", user.id],
    queryFn: () =>
      Promise.all(
        memberships.map(async (m): Promise<WorkspaceKeysOverview> => {
          try {
            return {
              workspaceId: m.workspaceId,
              keys: await api<AdminWorkspaceKey[]>(
                `/api/v1/admin/workspaces/${m.workspaceId}/keys`,
              ),
            };
          } catch {
            return { workspaceId: m.workspaceId, keys: null };
          }
        }),
      ),
    enabled: memberships.length > 0,
    retry: false,
  });

  // Same cache key as ManageKeysDialog: public model metadata for labels only.
  const modelsQuery = useQuery<AdminModel[]>({
    queryKey: ["admin", "catalog", "models"],
    queryFn: () => api<AdminModel[]>("/api/v1/admin/catalog/models"),
    retry: false,
  });
  const modelLabels = new Map(
    (Array.isArray(modelsQuery.data) ? modelsQuery.data : []).map((m) => [
      m.id,
      m.display_name || m.public_id || m.id,
    ]),
  );

  const pending = contextQuery.isPending || keysOverviewQuery.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("detailTitle")}</DialogTitle>
          <DialogDescription>
            {t("detailDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-1 rounded-md border p-3 text-sm">
          <p className="font-medium">{t("sectionAccount")}</p>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs">{user.id}</span>
            <CopyButton value={user.id} label={t("copyUserId")} />
          </div>
          <p>
            {t("email")}: {user.email}
          </p>
          <p>
            {t("name")}: {user.name}
          </p>
          <p>
            {t("joined")}: {formatDate(new Date(user.created_at))}
          </p>
          <p>
            {t("emailStatus")}:{" "}
            {user.email_verified === undefined ? (
              <Badge variant="secondary">{t("unavailable")}</Badge>
            ) : user.email_verified ? (
              <Badge variant="default">{t("verified")}</Badge>
            ) : (
              <Badge variant="outline">{t("unverified")}</Badge>
            )}
          </p>
          <p>
            {t("role")}:{" "}
            {user.is_instance_admin ? (
              <Badge variant="default">admin</Badge>
            ) : (
              <Badge variant="outline">user</Badge>
            )}
          </p>
        </section>

        {pending && <p className="text-muted-foreground text-sm">…</p>}
        {contextQuery.isError && (
          <p className="text-destructive text-sm">
            {contextQuery.error instanceof Error ? contextQuery.error.message : t("requestFailed")}
          </p>
        )}

        {!pending && (
          <>
            <section className="space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">{t("sectionMemberships")}</p>
              {memberships.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("noMemberships")}</p>
              ) : (
                <ul className="space-y-1">
                  {memberships.map((m) => (
                    <li key={m.workspaceId} className="flex items-center gap-2">
                      <span>{m.workspaceName}</span>
                      <Badge variant="secondary">{m.role}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">{t("sectionWallets")}</p>
              {memberships.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("noMemberships")}</p>
              ) : (
                <ul className="space-y-2">
                  {memberships.map((m) => {
                    const wallet = wallets.find(
                      (w) => w.workspaceId === m.workspaceId && w.kind === "topup",
                    );
                    return (
                      <li key={m.workspaceId}>
                        <p className="font-medium">{m.workspaceName}</p>
                        {wallet ? (
                          <p className="text-muted-foreground text-xs">
                            {t("balanceLabel")}: {formatVnd(wallet.balance)} · {t("reservedLabel")}:{" "}
                            {formatVnd(wallet.reserved)}
                          </p>
                        ) : (
                          <p className="text-muted-foreground text-xs">{t("noTopupWallet")}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="space-y-2 rounded-md border p-3 text-sm">
              <p className="font-medium">{t("sectionKeys")}</p>
              {memberships.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("noMemberships")}</p>
              ) : (
                (keysOverviewQuery.data ?? []).map((ws) => (
                  <div key={ws.workspaceId} className="space-y-1">
                    <p className="text-xs font-medium">
                      {workspaceNames.get(ws.workspaceId) ?? ws.workspaceId}
                    </p>
                    {ws.keys === null ? (
                      <p className="text-muted-foreground text-xs">{t("detailKeysUnavailable")}</p>
                    ) : ws.keys.length === 0 ? (
                      <p className="text-muted-foreground text-xs">{t("noKeys")}</p>
                    ) : (
                      <ul className="space-y-1">
                        {ws.keys.map((k) => (
                          <li key={k.id} className="text-xs">
                            <span className="font-medium">{k.name}</span>{" "}
                            <span className="font-mono">{k.key_prefix}…</span>{" "}
                            <Badge variant={k.status === "revoked" ? "outline" : "default"}>
                              {k.status}
                            </Badge>
                            <span className="block text-muted-foreground">
                              {t("createdLabel")}: {formatDate(new Date(k.created_at))} ·{" "}
                              {t("lastUsed")}:{" "}
                              {k.last_used_at ? formatDate(new Date(k.last_used_at)) : "—"} ·{" "}
                              {t("modelsLabel")}:{" "}
                              {k.modelIds.length === 0
                                ? t("allModels")
                                : k.modelIds.map((id) => modelLabels.get(id) ?? id).join(", ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </section>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onEdit(user)}>
            {t("edit")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onReset(user)}>
            {t("resetPassword")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onWallet(user)}>
            {t("manageWallet")}
          </Button>
          <Button type="button" variant="outline" onClick={() => onKeys(user)}>
            {t("manageKeys")}
          </Button>
          {user.id !== currentUserId && (
            <Button type="button" variant="destructive" onClick={() => onRemove(user)}>
              {t("remove")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
