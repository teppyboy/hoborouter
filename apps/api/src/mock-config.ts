// Task 9: mock payments feature-flag config. Enabled ONLY when
// HBR_MOCK_PAYMENTS=on AND NODE_ENV !== 'production'. Webhook key must be
// nonempty when enabled; it is read from env only, never stored in source.
export interface MockWebhookConfig {
  enabled: boolean;
  webhookKey: string;
}

export function mockWebhookConfig(
  env: {
    HBR_MOCK_PAYMENTS?: string;
    HBR_MOCK_PAYMENTS_WEBHOOK_KEY?: string;
    NODE_ENV?: string;
  } = process.env,
): MockWebhookConfig {
  const enabled = env.HBR_MOCK_PAYMENTS === "on" && env.NODE_ENV !== "production";
  const key = env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
  if (enabled && !key) {
    // Fail fast at app build: a per-request 500 would be too late.
    throw new Error("HBR_MOCK_PAYMENTS_WEBHOOK_KEY must be set when mock payments are enabled");
  }
  return { enabled, webhookKey: enabled && key ? key : "" };
}
