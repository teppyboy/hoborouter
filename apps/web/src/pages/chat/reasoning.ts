// Canonical reasoning effort selection for the Chat page (OpenRouter parity
// plan Task 6 web controls).
//
// Tolerant public metadata contract: clients are never given route or effort
// metadata — the only server signal is the stored capability mirror
// ("reasoning") from the public catalog. The selector therefore offers the
// canonical public effort ladder and the gateway stays the single validator:
// an authored model without a matching route rejects the request with a
// pre-reservation 400 (before any wallet hold), and an un-authored model
// passes the form through verbatim. Public effort labels only — CPA route,
// upstream model, and provider identifiers never appear in this module.
import type { LocaleEntry } from "../../lib/i18n/t";

/** Canonical public effort ladder (mirrors the gateway's accepted values). */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Selector value meaning "send no reasoning field" (upstream default). */
export const EFFORT_UNSET = "default";

export type ChatCompletionBody = {
  model: string;
  messages: unknown;
  stream: true;
  /** Canonical OpenRouter carrier; present only for an explicit effort. */
  reasoning?: { effort: ReasoningEffort };
};

/** True only when the stored capabilities explicitly carry "reasoning";
 * absent/null/unknown lists never infer support (tolerant metadata). */
export function supportsReasoning(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes("reasoning");
}

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/**
 * Request body exactly as the gateway receives it: the pre-change chat
 * serialization plus at most ONE canonical effort carrier. "default" (or any
 * non-effort value) omits the field entirely so legacy/un-authored models see
 * a byte-identical body shape.
 */
export function buildChatRequestBody(input: {
  model: string;
  messages: unknown;
  effort: string;
}): ChatCompletionBody {
  const body: ChatCompletionBody = { model: input.model, messages: input.messages, stream: true };
  if (isReasoningEffort(input.effort)) body.reasoning = { effort: input.effort };
  return body;
}

/** Bilingual selector labels; canonical effort ids stay verbatim where no
 * common short form exists (xhigh). */
export const EFFORT_LABELS: Record<ReasoningEffort, LocaleEntry> = {
  none: { en: "Off", vi: "Tắt" },
  minimal: { en: "Minimal", vi: "Thấp nhất" },
  low: { en: "Low", vi: "Thấp" },
  medium: { en: "Medium", vi: "Trung bình" },
  high: { en: "High", vi: "Cao" },
  xhigh: { en: "xhigh", vi: "xhigh" },
  max: { en: "Max", vi: "Tối đa" },
};
