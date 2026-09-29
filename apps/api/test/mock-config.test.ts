// Task 9 hardening: mockWebhookConfig fail-fast + gating unit tests.
import { describe, test, expect } from "bun:test";
import { mockWebhookConfig } from "../src/mock-config";

describe("mockWebhookConfig", () => {
  test("enabled with key", () => {
    expect(
      mockWebhookConfig({
        HBR_MOCK_PAYMENTS: "on",
        HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "k",
        NODE_ENV: "development",
      }),
    ).toEqual({ enabled: true, webhookKey: "k" });
  });

  test("enabled with EMPTY key throws at build time (fail-fast)", () => {
    expect(() => mockWebhookConfig({ HBR_MOCK_PAYMENTS: "on", NODE_ENV: "development" })).toThrow(
      /HBR_MOCK_PAYMENTS_WEBHOOK_KEY/,
    );
  });

  test("flag values other than 'on' -> disabled", () => {
    for (const v of ["off", "1", "", "ON", "true"]) {
      expect(mockWebhookConfig({ HBR_MOCK_PAYMENTS: v, NODE_ENV: "development" }).enabled).toBe(
        false,
      );
    }
  });

  test("production disables even with flag on (no throw despite empty key)", () => {
    expect(mockWebhookConfig({ HBR_MOCK_PAYMENTS: "on", NODE_ENV: "production" }).enabled).toBe(
      false,
    );
  });

  test("disabled returns empty key", () => {
    expect(
      mockWebhookConfig({ HBR_MOCK_PAYMENTS: "off", HBR_MOCK_PAYMENTS_WEBHOOK_KEY: "k" }),
    ).toEqual({ enabled: false, webhookKey: "" });
  });
});
