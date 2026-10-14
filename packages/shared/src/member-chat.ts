// Shared member-chat policy DTOs — dependency-free, type-only. Frozen wire
// shapes for the admin policy and member access endpoints.
import type { EpochMs } from "./index";

/** Admin GET/PUT /workspaces/:id/member-chat-policy body. */
export interface MemberChatPolicy {
  enabled: boolean;
  /** Positive VND daily per-user cap; NULL = uncapped. NULL while disabled. */
  daily_cap_vnd: number | null;
}

/** GET /workspaces/:id/member-chat-access body (self, authorized member). */
export interface MemberChatAccess {
  role: "owner" | "admin" | "member";
  can_chat: boolean;
  daily_cap_vnd: number | null;
  /** Used VND in the current UTC day, including live admission holds. */
  used_vnd: number;
  /** daily_cap_vnd - used_vnd, or NULL when uncapped. Never negative. */
  remaining_vnd: number | null;
  /** Epoch ms when the current UTC period rolls over. */
  resets_at: EpochMs;
}
