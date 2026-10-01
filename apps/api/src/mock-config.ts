// Mock payments are the DEFAULT top-up provider (payOS stays implemented but
// optional, only used when all PAYOS_* env vars are set). Creation of mock
// top-ups is on unless HBR_MOCK_PAYMENTS='off'. The signed mock webhook is
// OPTIONAL: enabled only when HBR_MOCK_PAYMENTS_WEBHOOK_KEY is set — startup
// never crashes without it (unsigned completion goes through the admin
// complete endpoint instead; /api/dev/... only outside production).
export interface MockWebhookConfig {
  /** Mock top-up creation enabled (default true; 'off' disables). */
  enabled: boolean;
  /** Signed webhook enabled ONLY when its key is set. */
  webhookEnabled: boolean;
  webhookKey: string;
}

export function mockWebhookConfig(
  env: {
    HBR_MOCK_PAYMENTS?: string;
    HBR_MOCK_PAYMENTS_WEBHOOK_KEY?: string;
    [k: string]: string | undefined;
  } = process.env,
): MockWebhookConfig {
  const enabled = env.HBR_MOCK_PAYMENTS !== "off";
  const key = env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
  const webhookEnabled = enabled && !!key;
  return { enabled, webhookEnabled, webhookKey: webhookEnabled ? (key as string) : "" };
}
