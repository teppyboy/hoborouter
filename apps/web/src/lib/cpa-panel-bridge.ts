import { z } from "zod";

const channels = [
  "qwen",
  "gemini",
  "kimi",
  "aistudio",
  "claude",
  "codex",
  "antigravity",
  "xai",
  "iflow",
  "vertex",
] as const;
const text = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 256 && !/[\u0000-\u001f\u007f]/.test(value),
  );
const filename = text.refine((value) => !/[\\/]/.test(value) && value !== "." && value !== "..");
const alias = z
  .object({
    name: text,
    alias: text,
    fork: z.boolean().optional(),
    force_mapping: z.boolean().optional(),
  })
  .strict();
export const panelMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("setAuthFileStatus"),
      args: z.object({ name: filename, disabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("deleteAuthFiles"),
      args: z
        .object({
          names: z
            .array(filename)
            .min(1)
            .max(50)
            .refine((names) => new Set(names).size === names.length),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("replaceModelAliases"),
      args: z.object({ channel: z.enum(channels), aliases: z.array(alias).max(200) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("replaceModelExclusions"),
      args: z.object({ provider: z.enum(channels), models: z.array(text).max(500) }).strict(),
    })
    .strict(),
]);
export type PanelProposal = z.infer<typeof panelMutationSchema>;
const readSchema = z
  .object({
    operation: z.enum(["readConfig", "listAuthFiles", "readModelAliases", "readModelExclusions"]),
  })
  .strict();
const envelopeSchema = z
  .object({
    type: z.literal("hbr-cpa-panel:request"),
    version: z.literal(1),
    channel: z.string().max(128),
    id: z.number().int().min(1).max(2147483647),
    operation: z.string(),
    args: z.unknown().optional(),
  })
  .strict();
const preparedSchema = z
  .object({
    approval_id: z.string().min(1).max(256),
    proposal: panelMutationSchema,
    expires_at: z.number().int(),
  })
  .strict();
const dataSchema = z.object({ data: z.unknown() }).strict();
export interface PanelConfirmation {
  proposal: PanelProposal;
  expiresAt: number;
  confirm: () => void;
  cancel: () => void;
}
export type PanelFetch = (input: string, init: RequestInit) => Promise<Response>;
interface BridgeOptions {
  frame: { postMessage: (message: unknown, targetOrigin: string) => void };
  channel: string;
  csrf: string;
  fetcher?: PanelFetch;
  onProposal: (confirmation: PanelConfirmation | null) => void;
  onUnavailable?: () => void;
}
interface Pending {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
}
class PanelFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const LIMIT = 64 * 1024;

/** Opaque origin alone is not identity: pin source, channel, and this bridge's lifetime. */
export class CpaPanelBridge {
  private active = true;
  private seen = new Set<number>();
  private pending = new Map<number, Pending>();
  private mutationId: number | null = null;
  private readonly options: BridgeOptions;
  constructor(options: BridgeOptions) {
    this.options = options;
  }
  get pendingCount() {
    return this.pending.size;
  }
  init() {
    if (this.active)
      this.options.frame.postMessage(
        { type: "hbr-cpa-panel:init", version: 1, channel: this.options.channel },
        "*",
      );
  }
  handle(event: { source: unknown; origin: string; data: unknown }) {
    if (!this.active || event.source !== this.options.frame || event.origin !== "null") return;
    try {
      if (new TextEncoder().encode(JSON.stringify(event.data)).length > LIMIT) return;
    } catch {
      return;
    }
    const envelope = envelopeSchema.safeParse(event.data);
    if (!envelope.success || envelope.data.channel !== this.options.channel) return;
    const { id, operation } = envelope.data;
    const body = Object.prototype.hasOwnProperty.call(event.data, "args")
      ? { operation, args: envelope.data.args }
      : { operation };
    const read = readSchema.safeParse(body);
    const mutation = panelMutationSchema.safeParse(body);
    if (!read.success && !mutation.success) return;
    if (this.seen.has(id)) return;
    if (this.seen.size >= 4096) {
      this.unavailable();
      return;
    }
    this.seen.add(id);
    if (this.pending.size >= 32 || (mutation.success && this.mutationId !== null)) {
      this.reply(id, 429, {
        error: { code: "HBR_PANEL_BUSY", message: "Panel is busy. Wait for the current request." },
      });
      return;
    }
    const pending: Pending = {
      controller: new AbortController(),
      timer: setTimeout(() => this.timeout(id, false), 30000),
      mutation: mutation.success,
    };
    this.pending.set(id, pending);
    if (mutation.success) this.mutationId = id;
    void this.dispatch(
      id,
      read.success ? "read" : "prepare",
      read.success ? read.data : mutation.data,
    );
  }
  dispose() {
    if (!this.active) return;
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    this.pending.clear();
    this.seen.clear();
    this.mutationId = null;
    this.options.onProposal(null);
  }
  private unavailable() {
    this.dispose();
    this.options.onUnavailable?.();
  }
  private reply(id: number, status: number, data: unknown) {
    if (this.active)
      this.options.frame.postMessage(
        {
          type: "hbr-cpa-panel:response",
          version: 1,
          channel: this.options.channel,
          id,
          status,
          data,
        },
        "*",
      );
  }
  private finish(id: number, status: number, data: unknown) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    this.pending.delete(id);
    if (this.mutationId === id) {
      this.mutationId = null;
      this.options.onProposal(null);
    }
    this.reply(id, status, data);
  }
  private timeout(id: number, executing: boolean) {
    this.finish(id, 504, {
      error: {
        code: executing ? "HBR_PANEL_RESULT_UNKNOWN" : "HBR_PANEL_TIMEOUT",
        message: executing
          ? "Result unknown. Refresh state before making another change. Do not retry automatically."
          : "Panel request expired. Refresh and try again.",
      },
    });
  }
  private async request(
    id: number,
    endpoint: "read" | "prepare" | "execute",
    body: unknown,
  ): Promise<unknown> {
    const pending = this.pending.get(id);
    if (!pending) throw new PanelFailure(410, "HBR_PANEL_EXPIRED", "Panel request expired.");
    const response = await (this.options.fetcher ?? fetch)(`/api/v1/admin/cpa/panel/${endpoint}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: pending.controller.signal,
      headers: { "Content-Type": "application/json", "x-hbr-panel-csrf": this.options.csrf },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      this.unavailable();
      throw new PanelFailure(
        403,
        "HBR_PANEL_SESSION_EXPIRED",
        "Admin session expired. Reload the page.",
      );
    }
    if (!response.ok)
      throw new PanelFailure(
        response.status,
        endpoint === "execute" ? "HBR_PANEL_RESULT_UNKNOWN" : "HBR_PANEL_REQUEST_FAILED",
        endpoint === "execute"
          ? "Change not confirmed. Refresh state before retrying."
          : "Panel request rejected. Refresh and try again.",
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new PanelFailure(
        502,
        "HBR_PANEL_INVALID_RESPONSE",
        "Panel returned an invalid response.",
      );
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > LIMIT) throw new Error("oversize");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PanelFailure(
        502,
        "HBR_PANEL_INVALID_RESPONSE",
        "Panel returned an invalid response.",
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  private async dispatch(id: number, endpoint: "read" | "prepare" | "execute", body: unknown) {
    try {
      const response = await this.request(id, endpoint, body);
      const pending = this.pending.get(id);
      if (!pending || !this.active) return;
      if (endpoint !== "prepare") {
        const parsed = dataSchema.safeParse(response);
        if (!parsed.success)
          throw new PanelFailure(
            502,
            "HBR_PANEL_INVALID_RESPONSE",
            "Panel returned an invalid response.",
          );
        this.finish(id, 200, parsed.data.data);
        return;
      }
      const prepared = preparedSchema.safeParse(response);
      if (
        !prepared.success ||
        prepared.data.expires_at <= Date.now() ||
        prepared.data.expires_at > Date.now() + 60000
      )
        throw new PanelFailure(
          502,
          "HBR_PANEL_INVALID_RESPONSE",
          "Panel returned an invalid proposal.",
        );
      const { approval_id, proposal, expires_at } = prepared.data;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.timeout(id, false), expires_at - Date.now());
      let decided = false;
      this.options.onProposal({
        proposal,
        expiresAt: expires_at,
        cancel: () => {
          if (decided) return;
          decided = true;
          this.finish(id, 409, {
            error: { code: "HBR_PANEL_CANCELLED", message: "Change cancelled in the admin panel." },
          });
        },
        confirm: () => {
          if (decided || !this.active || !this.pending.has(id)) return;
          decided = true;
          if (Date.now() >= expires_at) {
            this.timeout(id, false);
            return;
          }
          this.options.onProposal(null);
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => this.timeout(id, true), 30000);
          void this.dispatch(id, "execute", { approval_id });
        },
      });
    } catch (error) {
      const failure =
        error instanceof PanelFailure
          ? error
          : new PanelFailure(
              502,
              endpoint === "execute" ? "HBR_PANEL_RESULT_UNKNOWN" : "HBR_PANEL_UNAVAILABLE",
              endpoint === "execute"
                ? "Result unknown. Refresh state before making another change."
                : "Panel unavailable. Refresh and try again.",
            );
      this.finish(id, failure.status, { error: { code: failure.code, message: failure.message } });
    }
  }
}
