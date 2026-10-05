// Logs page filter + pagination helpers: pure client-side behavior over the
// loaded page of 100 requests. No network involved.
import { test, expect } from "bun:test";
import {
  applyLogFilters,
  paginateLogs,
  visibleRows,
  LOG_PAGE_SIZE,
} from "../apps/web/src/pages/logs/filters";
import type { UsageLogRow } from "../apps/web/src/pages/logs/api";

function row(partial: Partial<UsageLogRow>): UsageLogRow {
  return {
    id: "r1",
    request_id: "req_1234567890abcdef",
    created_at: 1700000000000,
    public_model: "gpt-5",
    provider: "openai",
    status: "ok",
    failure: null,
    input_tokens: 10,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    charged_vnd: 500,
    latency_ms: 120,
    ttft_ms: null,
    key_prefix: "sk-a",
    ...partial,
  };
}

const rows = [
  row({ id: "1", request_id: "req_aaa", public_model: "gpt-5", status: "ok", key_prefix: "sk-a" }),
  row({
    id: "2",
    request_id: "req_bbb",
    public_model: "claude-4",
    status: "error",
    key_prefix: "sk-b",
  }),
  row({ id: "3", request_id: "req_ccc", public_model: "gpt-5", status: "ok", key_prefix: null }),
];

test("applyLogFilters: search matches request id", () => {
  expect(
    applyLogFilters(rows, { search: "bbb", model: "all", status: "all", key: "all" }),
  ).toHaveLength(1);
});

test("applyLogFilters: model filter", () => {
  expect(
    applyLogFilters(rows, { search: "", model: "gpt-5", status: "all", key: "all" }),
  ).toHaveLength(2);
});

test("applyLogFilters: status error excludes ok rows", () => {
  const out = applyLogFilters(rows, { search: "", model: "all", status: "error", key: "all" });
  expect(out).toHaveLength(1);
  expect(out[0]?.status).toBe("error");
});

test("applyLogFilters: key prefix filter, null prefix bucketed as —", () => {
  expect(applyLogFilters(rows, { search: "", model: "all", status: "all", key: "—" })).toHaveLength(
    1,
  );
  expect(
    applyLogFilters(rows, { search: "", model: "all", status: "all", key: "sk-b" }),
  ).toHaveLength(1);
});

test("applyLogFilters: combined filters intersect", () => {
  expect(
    applyLogFilters(rows, { search: "", model: "gpt-5", status: "error", key: "all" }),
  ).toHaveLength(0);
});

test("visibleRows: hides missing/whitespace model and zero/zero tokens, retains one-sided usage", () => {
  const candidates = [
    row({ id: "m1", public_model: "" }),
    row({ id: "m2", public_model: "   " }),
    row({ id: "z", input_tokens: 0, output_tokens: 0 }),
    row({ id: "in", input_tokens: 12, output_tokens: 0 }),
    row({ id: "out", input_tokens: 0, output_tokens: 30 }),
    row({ id: "err", status: "error", input_tokens: 5, output_tokens: 5 }),
  ];
  expect(visibleRows(candidates).map((r) => r.id)).toEqual(["in", "out", "err"]);
  expect(
    applyLogFilters(candidates, { search: "", model: "all", status: "all", key: "all" }),
  ).toHaveLength(3);
});

test("paginateLogs: page size and clamping", () => {
  const many = Array.from({ length: LOG_PAGE_SIZE + 5 }, (_, i) => row({ id: String(i) }));
  const p0 = paginateLogs(many, 0);
  expect(p0.slice).toHaveLength(LOG_PAGE_SIZE);
  expect(p0.pageCount).toBe(2);
  const p5 = paginateLogs(many, 5);
  expect(p5.page).toBe(1);
  expect(p5.slice).toHaveLength(5);
  expect(paginateLogs([], 0).pageCount).toBe(1);
});
