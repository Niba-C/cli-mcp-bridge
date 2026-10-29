import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWatermark,
  EVENT_PAYLOAD_MAX_CHARS,
  truncatePayload,
  type RunEvent,
} from "../../src/contracts/events.ts";
import { nextActionFor, normalizeStopReason } from "../../src/contracts/run.ts";

const baseEvent: RunEvent = {
  runId: "run_00000000-0000-4000-8000-000000000010",
  seq: 1,
  revision: 1,
  type: "run.started",
  at: "2026-10-21T00:00:00.000Z",
  payload: {},
};

test("v1 水位：seq 必须等于 revision 且从 1 开始", () => {
  assert.doesNotThrow(() => assertWatermark(baseEvent));
  assert.throws(() => assertWatermark({ ...baseEvent, revision: 2 }), /必须等于/);
  assert.throws(() => assertWatermark({ ...baseEvent, seq: 0, revision: 0 }), /必须/);
  assert.throws(() => assertWatermark({ ...baseEvent, seq: 1.5, revision: 1.5 }), /整数/);
});

test("事件载荷超长时带截断标记，不静默丢字", () => {
  const long = "x".repeat(EVENT_PAYLOAD_MAX_CHARS + 100);
  const truncated = truncatePayload(long);
  assert.equal(truncated.length > EVENT_PAYLOAD_MAX_CHARS, true);
  assert.match(truncated, /\[truncated 100 chars\]$/);
  assert.equal(truncatePayload("short"), "short");
});

test("stopReason 的未知取值被显式标记，不猜成成功", () => {
  assert.equal(normalizeStopReason("turn_complete"), "turn_complete");
  assert.equal(normalizeStopReason("aborted"), "aborted");
  assert.equal(normalizeStopReason("brand_new_reason"), "unknown:brand_new_reason");
  // OpenCode 的 finish 原值不是产品原因，必须经映射后才能进入这里。
  assert.equal(normalizeStopReason("end_turn"), "unknown:end_turn");
  assert.equal(normalizeStopReason(null), null);
  assert.equal(normalizeStopReason(""), null);
});

test("nextAction 只给建议，不改变状态", () => {
  assert.equal(nextActionFor("running", false), "wait");
  assert.equal(nextActionFor("waiting_approval", false), "wait_approval");
  assert.equal(nextActionFor("waiting_input", false), "wait_input");
  assert.equal(nextActionFor("completed", true), "read_result");
  assert.equal(nextActionFor("completed", false), "none");
  assert.equal(nextActionFor("cancelled", false), "none");
});
