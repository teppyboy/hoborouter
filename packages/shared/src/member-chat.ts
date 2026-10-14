// Shared member-chat policy DTOs — dependency-free, type-only. Frozen wire
// shapes for the admin policy and member access endpoints.
import type { EpochMs } from "./index";

/** Admin GET/PUT /workspaces/:id/member-chat-policy body. */
export interface MemberChatPolicy {
  enabled: boolean;
  /**
   * Positive VND daily per-user cap. NULL only while disabled — an enabled
   * policy is ALWAYS explicitly capped (DB CHECK
   * workspaces_member_chat_cap_required); frontends must never treat an
   * enabled member as uncapped. Admin un-capping = disable the policy.
   */
  daily_cap_vnd: number | null;
}

/** GET /workspaces/:id/member-chat-access body (self, authorized member). */
export interface MemberChatAccess {
  role: "owner" | "admin" | "member";
  can_chat: boolean;
  /** NULL only when the policy is disabled (can_chat false). */
  daily_cap_vnd: number | null;
  /** Used VND in the current UTC day, including live admission holds. */
  used_vnd: number;
  /** daily_cap_vnd - used_vnd; NULL only when disabled. Never negative. */
  remaining_vnd: number | null;
  /** Epoch ms when the current UTC period rolls over. */
  resets_at: EpochMs;
}
