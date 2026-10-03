// Model rename UI contract: slug preview rule, server-error-to-field mapping,
// and the exact breakage warning shown before a rename is confirmed.
import { test, expect } from "bun:test";
import {
  RENAME_WARNING,
  PUBLIC_ID_RE,
  slugFromPublicId,
  renameFieldError,
  schema,
  detailsDefaults,
} from "../apps/web/src/pages/admin/models";
import type { AdminModel } from "../apps/web/src/pages/admin/shared";

test("padded public_id is trimmed before validation; slug drops provider prefix", () => {
  const v = schema.parse({
    public_id: " openai/gpt-x ",
    display_name: "GPT-X",
    provider: "openai",
    enabled: true,
    published: false,
    prompt_caching: "inherit",
  });
  expect(v.public_id).toBe("openai/gpt-x");
  expect(slugFromPublicId(v.public_id)).toBe("gpt-x");
});

test("slug preview uses the last path segment, same rule as create", () => {
  expect(slugFromPublicId("hoborouter/auto")).toBe("auto");
  expect(slugFromPublicId("gpt-5")).toBe("gpt-5");
});

test("PUBLIC_ID_RE matches the create-form rule (bare slug or provider/name)", () => {
  expect(PUBLIC_ID_RE.test("hoborouter/auto")).toBe(true);
  expect(PUBLIC_ID_RE.test("gpt-5")).toBe(true);
  expect(PUBLIC_ID_RE.test("GPT-5")).toBe(false);
  expect(PUBLIC_ID_RE.test("a/b/c")).toBe(false);
});

test("DUPLICATE maps to a field error with the fixed copy", () => {
  expect(renameFieldError("DUPLICATE", "public_id already exists")).toEqual({
    field: "public_id",
    message: "Another model already uses this ID",
  });
});

test("INVALID maps to the server's format message on the ID field", () => {
  expect(renameFieldError("INVALID", "public_id must be a lowercase slug or '<provider>/<name>'")).toEqual({
    field: "public_id",
    message: "public_id must be a lowercase slug or '<provider>/<name>'",
  });
});

test("other codes are not field errors (root error shows them)", () => {
  expect(renameFieldError("FORBIDDEN", "nope")).toBeNull();
});

test("rename warning names the old ID and what breaks / what is kept", () => {
  const w = RENAME_WARNING("old-model");
  expect(w).toContain("old-model");
  expect(w).toContain("will stop working");
  expect(w).toContain("usage history keeps the old name");
});

const baseModel = {
  id: "m1",
  public_id: "fake/test-model",
  slug: "test-model",
  display_name: "Fake Test",
  provider: "fake",
  description: null,
  capabilities: '["chat"]',
  context_window: 4096,
  prompt_caching: "inherit",
  has_price: true,
  has_mapping: true,
  created_at: 1,
  updated_at: 1,
} as AdminModel;

// Regression: the Details form once defaulted enabled/published with `=== 1`,
// so saving (e.g. a rename) silently disabled and unpublished the model.
test("details defaults keep a listed model enabled+published (real API booleans)", () => {
  const d = detailsDefaults({ ...baseModel, enabled: true, published: true });
  expect(d.enabled).toBe(true);
  expect(d.published).toBe(true);
  expect(d.public_id).toBe("fake/test-model");
  expect(d.capabilities).toBe("chat");
});

test("details defaults coerce legacy 1/0 rows truthily, and false stays false", () => {
  const legacy = detailsDefaults({
    ...baseModel,
    enabled: 1 as unknown as boolean,
    published: 0 as unknown as boolean,
  });
  expect(legacy.enabled).toBe(true);
  expect(legacy.published).toBe(false);
  const off = detailsDefaults({ ...baseModel, enabled: false, published: false });
  expect(off.enabled).toBe(false);
  expect(off.published).toBe(false);
});
