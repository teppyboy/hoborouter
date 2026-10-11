import { z } from "zod";

export const panelProviders = [
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
const provider = z.enum(panelProviders);
const text = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const filename = text.refine((s) => !/[\\/%]/.test(s) && !s.includes("..") && s !== ".");
const unique = (values: string[]) => new Set(values).size === values.length;
const alias = z.strictObject({
  name: text,
  alias: text,
  fork: z.boolean().optional(),
  force_mapping: z.boolean().optional(),
});
export const panelReadSchema = z.strictObject({
  operation: z.enum(["readConfig", "listAuthFiles", "readModelAliases", "readModelExclusions"]),
});
export const panelMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("setAuthFileStatus"),
    args: z.strictObject({ name: filename, disabled: z.boolean() }),
  }),
  z.strictObject({
    operation: z.literal("deleteAuthFiles"),
    args: z.strictObject({ names: z.array(filename).min(1).max(50).refine(unique) }),
  }),
  z.strictObject({
    operation: z.literal("replaceModelAliases"),
    args: z.strictObject({
      channel: provider,
      aliases: z
        .array(alias)
        .max(200)
        .refine((a) => unique(a.map((v) => v.alias))),
    }),
  }),
  z.strictObject({
    operation: z.literal("replaceModelExclusions"),
    args: z.strictObject({ provider, models: z.array(text).max(500).refine(unique) }),
  }),
]);
export const panelExecuteSchema = z.strictObject({ approval_id: z.uuid() });
export type PanelRead = z.infer<typeof panelReadSchema>["operation"];
export type PanelMutation = z.infer<typeof panelMutationSchema>;
export type PanelActor = { userId: string; sessionId: string };
export type PanelSafeValue =
  | null
  | boolean
  | number
  | string
  | PanelSafeValue[]
  | { [key: string]: PanelSafeValue };
export const PANEL_BODY_LIMIT = 65_536;

export class PanelError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () =>
  new PanelError(502, "HBR_PANEL_INVALID_RESPONSE", "CPA returned an invalid response");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};

// Check parsed values, not serialized bytes: quotes/backslashes cannot evade this gate.
export function rejectPanelSecrets(value: unknown, secrets: string[]): void {
  const walk = (item: unknown): void => {
    if (typeof item === "string" && secrets.some((s) => s && item.includes(s))) throw invalid();
    if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object")
      for (const [key, val] of Object.entries(item)) {
        walk(key);
        walk(val);
      }
  };
  walk(value);
}

export function projectPanelRead(
  operation: PanelRead,
  payload: unknown,
  secrets: string[],
): PanelSafeValue {
  const input = record(payload);
  let result: PanelSafeValue;
  try {
    switch (operation) {
      case "readConfig": {
        const out: Record<string, PanelSafeValue> = {};
        for (const key of [
          "debug",
          "request-log",
          "logging-to-file",
          "ws-auth",
          "force-model-prefix",
        ]) {
          if (input[key] !== undefined) out[key] = z.boolean().parse(input[key]);
        }
        for (const key of ["request-retry", "max-retry-credentials", "max-retry-interval"]) {
          if (input[key] !== undefined)
            out[key] = z.number().int().min(0).max(1000).parse(input[key]);
        }
        if (input["quota-exceeded"] !== undefined) {
          const quota = record(input["quota-exceeded"]);
          const safe: Record<string, boolean> = {};
          for (const key of ["switch-project", "switch-preview-model"])
            if (quota[key] !== undefined) safe[key] = z.boolean().parse(quota[key]);
          out["quota-exceeded"] = safe;
        }
        if (input.routing !== undefined) {
          const routing = record(input.routing);
          out.routing =
            routing.strategy === undefined
              ? {}
              : {
                  strategy: z
                    .enum(["round-robin", "weighted-round-robin", "fill-first"])
                    .parse(routing.strategy),
                };
        }
        result = out;
        break;
      }
      case "listAuthFiles": {
        const files = z
          .array(
            z.object({
              name: filename,
              type: provider,
              provider,
              disabled: z.boolean(),
              status: z.enum(["active", "disabled", "error", "unknown", "ready", "pending"]),
            }),
          )
          .max(1000)
          .parse(input.files);
        if (!unique(files.map((f) => f.name))) throw invalid();
        result = { files, total: files.length };
        break;
      }
      case "readModelAliases": {
        const values = record(input["oauth-model-alias"]);
        const out: Record<string, PanelSafeValue> = {};
        for (const [channel, aliases] of Object.entries(values)) {
          provider.parse(channel);
          out[channel] = z
            .array(
              z.object({
                name: text,
                alias: text,
                fork: z.boolean().optional(),
                "force-mapping": z.boolean().optional(),
              }),
            )
            .max(200)
            .parse(aliases);
        }
        result = { "oauth-model-alias": out };
        break;
      }
      case "readModelExclusions": {
        const values = record(input["oauth-excluded-models"]);
        const out: Record<string, string[]> = {};
        for (const [channel, models] of Object.entries(values)) {
          provider.parse(channel);
          out[channel] = z.array(text).max(500).parse(models);
        }
        result = { "oauth-excluded-models": out };
        break;
      }
    }
    rejectPanelSecrets(result, secrets);
    if (new TextEncoder().encode(JSON.stringify(result)).length > PANEL_BODY_LIMIT) throw invalid();
    return result;
  } catch {
    throw invalid();
  }
}

export async function boundedPanelJson(request: Request | Response): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PANEL_BODY_LIMIT) throw invalid();
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type PanelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Audit = (
  actor: PanelActor,
  operation: string,
  path: string,
  status: number,
  latency: number,
) => Promise<void>;
const paths: Record<PanelRead, string> = {
  readConfig: "config",
  listAuthFiles: "auth-files",
  readModelAliases: "oauth-model-alias",
  readModelExclusions: "oauth-excluded-models",
};

export class CpaPanelService {
  private approvals = new Map<
    string,
    { actor: PanelActor; proposal: PanelMutation; expires: number }
  >();
  private tokens = new Map<string, { token: string; expires: number }>();
  private secrets: string[];
  constructor(
    private env: Record<string, string | undefined>,
    private fetcher: PanelFetch = fetch,
    private now = Date.now,
    private audit: Audit = async () => {},
  ) {
    this.secrets = Object.entries(env)
      .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))
      .map(([, value]) => value ?? "")
      .filter(Boolean);
  }
  private binding(actor: PanelActor) {
    return `${actor.userId}:${actor.sessionId}`;
  }
  private prune() {
    for (const [id, item] of this.approvals)
      if (item.expires <= this.now()) this.approvals.delete(id);
    for (const [id, item] of this.tokens) if (item.expires <= this.now()) this.tokens.delete(id);
  }
  session(actor: PanelActor): string {
    this.prune();
    const binding = this.binding(actor);
    const existing = this.tokens.get(binding);
    if (existing) return existing.token;
    if (this.tokens.size >= 1024)
      throw new PanelError(429, "HBR_PANEL_BUSY", "Panel capacity reached");
    const token = crypto.randomUUID();
    this.tokens.set(binding, { token, expires: this.now() + 30 * 60_000 });
    return token;
  }
  validateCsrf(actor: PanelActor, token: string | null) {
    this.prune();
    if (!token || this.tokens.get(this.binding(actor))?.token !== token)
      throw new PanelError(403, "HBR_PANEL_CSRF", "Panel session expired or invalid");
  }
  prepare(actor: PanelActor, input: unknown) {
    this.prune();
    const proposal = panelMutationSchema.parse(input);
    rejectPanelSecrets(proposal, this.secrets);
    const count = [...this.approvals.values()].filter(
      (item) => this.binding(item.actor) === this.binding(actor),
    ).length;
    if (count >= 8 || this.approvals.size >= 1024)
      throw new PanelError(429, "HBR_PANEL_BUSY", "Too many pending proposals");
    const approval_id = crypto.randomUUID();
    const expires_at = this.now() + 60_000;
    this.approvals.set(approval_id, { actor: { ...actor }, proposal, expires: expires_at });
    return { approval_id, proposal, expires_at };
  }
  private async call(
    actor: PanelActor | undefined,
    operation: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.env.CPA_MANAGEMENT_KEY)
      throw new PanelError(502, "HBR_PANEL_UNCONFIGURED", "CPA management is not configured");
    const started = this.now();
    let status = 0;
    try {
      const response = await this.fetcher(
        `${this.env.CPA_BASE_URL || "http://cpa:8317"}/v0/management/${path}`,
        {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.env.CPA_MANAGEMENT_KEY}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(method === "GET" ? 3000 : 15000),
        },
      );
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw invalid();
      }
      const payload = await boundedPanelJson(response);
      if (method !== "GET") {
        const result = record(payload);
        if (Object.hasOwn(result, "error") || (result.status !== "ok" && result.ok !== true))
          throw invalid();
        if (
          result.failed !== undefined &&
          (!Array.isArray(result.failed) || result.failed.length !== 0)
        )
          throw invalid();
        if (method === "DELETE") {
          const names = (body as { names: string[] }).names;
          if (result.deleted !== undefined && result.deleted !== names.length) throw invalid();
        }
        return { ok: true };
      }
      return payload;
    } catch {
      throw new PanelError(
        502,
        method === "GET" ? "HBR_PANEL_UPSTREAM" : "HBR_PANEL_RESULT_UNKNOWN",
        method === "GET"
          ? "CPA read failed"
          : "Mutation result unknown; refresh state before another action",
      );
    } finally {
      if (actor)
        await this.audit(actor, operation, `/v0/management/${path}`, status, this.now() - started);
    }
  }
  async read(operation: PanelRead, actor?: PanelActor): Promise<unknown> {
    return projectPanelRead(
      operation,
      await this.call(actor, operation, paths[operation], "GET"),
      this.secrets,
    );
  }
  async execute(actor: PanelActor, id: string): Promise<unknown> {
    this.prune();
    const stored = this.approvals.get(id);
    if (!stored || this.binding(actor) !== this.binding(stored.actor))
      throw new PanelError(
        409,
        "HBR_PANEL_APPROVAL_INVALID",
        "Approval expired, consumed or invalid",
      );
    // Consume synchronously before the first await, including availability checks.
    this.approvals.delete(id);
    const proposal = stored.proposal;
    if (proposal.operation === "setAuthFileStatus" || proposal.operation === "deleteAuthFiles") {
      const data = (await this.read("listAuthFiles", actor)) as { files: { name: string }[] };
      const names =
        proposal.operation === "setAuthFileStatus" ? [proposal.args.name] : proposal.args.names;
      if (names.some((name) => !data.files.some((file) => file.name === name)))
        throw new PanelError(409, "HBR_PANEL_TARGET_MISSING", "Auth file no longer available");
    }
    switch (proposal.operation) {
      case "setAuthFileStatus":
        return this.call(actor, proposal.operation, "auth-files/status", "PATCH", proposal.args);
      case "deleteAuthFiles": {
        await this.call(actor, proposal.operation, "auth-files", "DELETE", proposal.args);
        return {
          status: "ok",
          deleted: proposal.args.names.length,
          files: proposal.args.names,
          failed: [],
        };
      }
      case "replaceModelAliases":
        return this.call(actor, proposal.operation, "oauth-model-alias", "PATCH", {
          channel: proposal.args.channel,
          aliases: proposal.args.aliases.map(({ force_mapping, ...rest }) => ({
            ...rest,
            ...(force_mapping !== undefined ? { "force-mapping": force_mapping } : {}),
          })),
        });
      case "replaceModelExclusions":
        return this.call(
          actor,
          proposal.operation,
          "oauth-excluded-models",
          "PATCH",
          proposal.args,
        );
    }
  }
}
