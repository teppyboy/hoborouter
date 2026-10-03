// Task 4: provider-neutral PaymentProvider boundary + payOS provider.
// payOS facts per official docs https://payos.vn/docs/api/ and the official
// SDK source (github.com/payOSHQ/payos-lib-node, src/crypto/node-crypto.ts):
//   - payment request signature: HMAC_SHA256(checksumKey,
//       `amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..`)
//   - webhook signature: HMAC_SHA256(checksumKey, over `data` object with
//       keys sorted ascending, joined as `k=v&k=v`, no URI encoding,
//       null/undefined -> empty string, undefined keys dropped)
// Config comes from env only; never stored in source or logged.
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyMockSignature } from "./mock-signature";

export interface PaymentRequestArgs {
  paymentId: string;
  amountVnd: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Explicit orderCode (used by tests); generated when omitted. */
  orderCode?: number;
}

export interface CreatedPayment {
  checkoutUrl: string;
  /** Provider's unique order/reference string, stored on payments.provider_order_code. */
  providerRef: string;
}

export type PaymentStatus = "paid" | "cancelled";

export interface VerifiedPaymentEvent {
  providerRef: string;
  amountVnd: number;
  status: PaymentStatus;
  eventId: string;
  /** Order code as string, for lookup against payments.provider_order_code. */
  orderCode: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(args: PaymentRequestArgs): Promise<CreatedPayment>;
  verifyWebhook(
    rawBody: string,
    headers: Headers,
    key?: string,
  ): Promise<VerifiedPaymentEvent> | VerifiedPaymentEvent;
}

// ---------------- payOS ----------------

export class PayosWebhookError extends Error {}

export type PayosConfig =
  | { available: false; clientId: ""; apiKey: ""; checksumKey: "" }
  | { available: true; clientId: string; apiKey: string; checksumKey: string };

/** Read payOS credentials from env. Missing vars -> unavailable, never throws. */
export function payosConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): PayosConfig {
  const { PAYOS_CLIENT_ID: c, PAYOS_API_KEY: a, PAYOS_CHECKSUM_KEY: s } = env;
  if (c && a && s) return { available: true, clientId: c, apiKey: a, checksumKey: s };
  return { available: false, clientId: "", apiKey: "", checksumKey: "" };
}

function hmacHex(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Sort keys ascending; join `k=v&k=v`; per payOS: no URI encoding, null/undefined -> "". */
export function payosDataString(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .filter((k) => data[k] !== undefined)
    .map((k) => {
      const v = data[k];
      return `${k}=${v === null || v === undefined ? "" : String(v)}`;
    })
    .join("&");
}

export function payosSignData(data: Record<string, unknown>, checksumKey: string): string {
  return hmacHex(payosDataString(data), checksumKey);
}

/** payOS payment request signature over the five documented fields, in order. */
export function payosRequestSignature(
  args: {
    amount: number;
    cancelUrl: string;
    description: string;
    orderCode: number;
    returnUrl: string;
  },
  checksumKey: string,
): string {
  const s = `amount=${args.amount}&cancelUrl=${args.cancelUrl}&description=${args.description}&orderCode=${args.orderCode}&returnUrl=${args.returnUrl}`;
  return hmacHex(s, checksumKey);
}

export interface PayosWebhookConfig {
  available: boolean;
  checksumKey: string;
}

export const PAYOS_API_BASE = "https://api-merchant.payos.vn";

/**
 * Random numeric orderCode within payOS integer bounds. The caller persists it
 * before the remote create; UNIQUE(provider, provider_order_code) at insert
 * catches the (astronomically unlikely) collision.
 */
export function payosNextOrderCode(): number {
  return 1_000_000_000 + Math.floor(Math.random() * 8_999_999_999);
}

export class PayOSProvider implements PaymentProvider {
  readonly name = "payos";
  constructor(
    private cfg: { clientId: string; apiKey: string; checksumKey: string },
    private fetchImpl: (
      input: string | URL,
      init?: RequestInit,
    ) => Promise<Response> = globalThis.fetch.bind(globalThis),
  ) {}

  private nextOrderCode(): number {
    return payosNextOrderCode();
  }

  async createPayment(args: PaymentRequestArgs): Promise<CreatedPayment> {
    const orderCode = args.orderCode !== undefined ? args.orderCode : this.nextOrderCode();
    const body = {
      orderCode,
      amount: args.amountVnd,
      description: args.description,
      returnUrl: args.returnUrl,
      cancelUrl: args.cancelUrl,
    };
    const signature = payosRequestSignature(body, this.cfg.checksumKey);
    const res = await this.fetchImpl(`${PAYOS_API_BASE}/v2/payment-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-id": this.cfg.clientId,
        "x-api-key": this.cfg.apiKey,
      },
      body: JSON.stringify({ ...body, signature }),
    });
    const payload = (await res.json().catch(() => null)) as {
      code?: string;
      data?: { checkoutUrl?: string; orderCode?: number };
    } | null;
    if (!payload || payload.code !== "00" || !payload.data?.checkoutUrl) {
      throw new Error(`payOS createPayment failed: code=${payload?.code} status=${res.status}`);
    }
    return {
      checkoutUrl: payload.data.checkoutUrl,
      providerRef: String(payload.data.orderCode ?? orderCode),
    };
  }

  /**
   * Verify a raw payOS webhook body. Throws PayosWebhookError on bad
   * signature/shape; returns the verified event otherwise.
   */
  verifyWebhook(rawBody: string, _headers?: Headers): VerifiedPaymentEvent {
    let parsed: {
      code?: unknown;
      success?: unknown;
      data?: unknown;
      signature?: unknown;
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new PayosWebhookError("malformed JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.signature !== "string" ||
      typeof parsed.data !== "object" ||
      parsed.data === null
    ) {
      throw new PayosWebhookError("invalid webhook shape");
    }
    const data = parsed.data as Record<string, unknown>;
    const expected = payosSignData(data, this.cfg.checksumKey);
    if (!timingSafeHexEqual(expected, parsed.signature)) {
      throw new PayosWebhookError("signature verification failed");
    }
    if (
      typeof data.orderCode !== "number" ||
      typeof data.amount !== "number" ||
      (typeof data.reference !== "string" && typeof data.paymentLinkId !== "string")
    ) {
      throw new PayosWebhookError("invalid webhook data");
    }
    // Only code '00'/success is a paid transaction; anything else is not a
    // credit event (cancellation or failure).
    const paid = parsed.code === "00" && parsed.success === true && data.code === "00";
    const ref = (data.reference ?? data.paymentLinkId) as string;
    return {
      providerRef: ref,
      amountVnd: data.amount,
      status: paid ? "paid" : "cancelled",
      eventId: ref,
      orderCode: String(data.orderCode),
    };
  }
}

// ---------------- Mock ----------------

export class MockProvider implements PaymentProvider {
  readonly name = "mock";

  async createPayment(args: PaymentRequestArgs): Promise<CreatedPayment> {
    const orderCode = `MOCK-${args.paymentId}`;
    return {
      checkoutUrl: `/webhooks/payments/mock?order=${orderCode}`,
      providerRef: orderCode,
    };
  }

  async verifyWebhook(
    rawBody: string,
    _headers: Headers,
    key: string,
  ): Promise<VerifiedPaymentEvent> {
    const ok = await verifyMockSignature(rawBody, key);
    if (!ok) throw new PayosWebhookError("signature verification failed");
    let ev: {
      provider_order_code?: unknown;
      provider_reference?: unknown;
      amount?: unknown;
      code?: unknown;
    };
    try {
      ev = JSON.parse(rawBody);
    } catch {
      throw new PayosWebhookError("malformed JSON");
    }
    if (
      typeof ev.provider_order_code !== "string" ||
      typeof ev.provider_reference !== "string" ||
      typeof ev.amount !== "number"
    ) {
      throw new PayosWebhookError("invalid webhook data");
    }
    return {
      providerRef: ev.provider_reference,
      amountVnd: ev.amount,
      status: ev.code === undefined || ev.code === "00" ? "paid" : "cancelled",
      eventId: ev.provider_reference,
      orderCode: ev.provider_order_code,
    };
  }
}
