// mockWebhookConfig unit tests: mock top-ups ON by default, signed webhook
// optional (enabled only when its key is set), startup never throws.
import { describe, test, expect } from "bun:test";
import { mockWebhookConfig } from "../src/mock-config";

describe("mockWebhookConfig", () => {
  test("enabled by default (no env at all), webhook optional", () => {
    expect(mockWebhookConfig({})).toEqual({
      enabled: true,
      webhookEnabled: false,
      webhookKey: "",
    });
  });

  test("webhook enabled only when its key is set", () => {
    expect(mockWebhookConfig({ HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "k" })).toEqual({
      enabled: true,
      webhookEnabled: true,
      webhookKey: "k",
    });
  });

  test("'off' disables creation and the webhook", () => {
    expect(
      mockWebhookConfig({ HBR_MOCK_PAYMENTS: "off", HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "k" }),
    ).toEqual({ enabled: false, webhookEnabled: false, webhookKey: "" });
  });
});
