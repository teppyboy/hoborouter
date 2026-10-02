// Compatibility config for the LEGACY signed mock webhook only. New top-ups
// are provider='manual' (admin-approved, no env gate) and never use this
// webhook. 'enabled' keeps gating the legacy /webhooks/payments/mock route;
// the signed webhook is enabled only when HBR_MOCK_PAYMENTS_WEBHOOK_KEY is
// set — startup never crashes without it (unsigned completion goes through
// the admin complete endpoint).
export interface MockWebhookConfig {
  /** Legacy mock webhook route enabled (default true; 'off' disables). */
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
