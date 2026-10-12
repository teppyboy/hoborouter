// Canonical reasoning effort selection for the Chat page (OpenRouter parity
// plan Task 6 web controls).
//
// Catalog-authored reasoning effort selection for the Chat page (OpenRouter
// parity plan Task 6 web controls).
//
// Public metadata contract: the server projects each model's catalog-authored
// reasoning metadata (supported_efforts from enabled routes, default_effort).
// The selector offers ONLY those authored efforts — a level with no catalog
// route is never shown, so no unsupported option can be sent. The gateway
// stays the single validator: an authored model without a matching route
// rejects the request with a pre-reservation 400 (before any wallet hold),
// and a model with no authored routes passes the form through verbatim.
// Public effort labels only — CPA route, upstream model, and provider
// identifiers never appear in this module.
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

/** Public reasoning metadata shape projected by the catalog APIs. */
export type PublicReasoningMetadata = {
  supported_efforts: string[];
  default_effort: string | null;
};

/**
 * Catalog-authored efforts the selector may offer, in authored order and
 * filtered to known effort ids. Unknown or malformed values are dropped —
 * never shown as selectable options. Empty list = no selector.
 */
export function supportedEffortOptions(
  metadata: PublicReasoningMetadata | null | undefined,
): ReasoningEffort[] {
  if (!metadata || !Array.isArray(metadata.supported_efforts)) return [];
  return metadata.supported_efforts.filter(isReasoningEffort);
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
