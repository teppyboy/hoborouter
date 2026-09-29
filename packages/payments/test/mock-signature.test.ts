import { describe, test, expect } from "bun:test";
import {
  canonicalJson,
  signMockPayload,
  verifyMockSignature,
  MockSignatureConfigError,
} from "../src/mock-signature";

describe("mock signature", () => {
  const key = crypto.getRandomValues(new Uint8Array(32)).toString();

  test("empty key rejected at config load", () => {
    expect(() => signMockPayload({ a: 1 }, "")).toThrow(MockSignatureConfigError);
    expect(() => verifyMockSignature('{"a":1}', "")).toThrow(MockSignatureConfigError);
  });

  test("valid signature verifies", async () => {
    const payload = { order: "O1", amount: 50000 };
    const sig = await signMockPayload(payload, key);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMockSignature(JSON.stringify({ ...payload, signature: sig }), key)).toBe(
      true,
    );
  });

  test("flipped byte fails", async () => {
    const payload = { order: "O1", amount: 50000 };
    const sig = await signMockPayload(payload, key);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifyMockSignature(JSON.stringify({ ...payload, signature: flipped }), key)).toBe(
      false,
    );
  });

  test("reordered JSON keys verify identically (canonicalization)", async () => {
    const sig = await signMockPayload({ amount: 50000, order: "O1", nested: { b: 2, a: 1 } }, key);
    const raw = JSON.stringify({
      nested: { a: 1, b: 2 },
      signature: sig,
      order: "O1",
      amount: 50000,
    });
    expect(await verifyMockSignature(raw, key)).toBe(true);
  });

  test("canonicalJson is sorted-key compact JSON", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("tampered payload fails", async () => {
    const sig = await signMockPayload({ amount: 50000 }, key);
    expect(await verifyMockSignature(JSON.stringify({ amount: 99000, signature: sig }), key)).toBe(
      false,
    );
  });
});
