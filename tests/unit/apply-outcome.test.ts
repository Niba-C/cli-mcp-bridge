import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTurnOutcome } from "../../src/core/apply-outcome.ts";

test("正常完成必须经过 draining", () => {
  const result = applyTurnOutcome({ kind: "completed", terminalObservedAfterStop: false });
  assert.equal(result.state, "completed");
  assert.deepEqual(result.path, ["draining", "completed"]);
  assert.equal(result.accepted, true);
  assert.equal(result.rejectedTerminal, null);
});

test("停止请求之后到达的 completed 被拒，最终按 cancel 意图收敛为 cancelled（A05）", () => {
  const result = applyTurnOutcome({ kind: "completed", terminalObservedAfterStop: true });
  assert.equal(result.state, "cancelled");
  assert.equal(result.rejectedTerminal, "completed");
  assert.equal(result.rejected, "terminal_immutable");
  assert.deepEqual(result.path, ["stopping", "cancelled"]);
});

test("interrupt 意图下晚到终态收敛为 interrupted", () => {
  const result = applyTurnOutcome(
    { kind: "completed", terminalObservedAfterStop: true },
    { stopIntent: "interrupt" },
  );
  assert.equal(result.state, "interrupted");
});

test("deadline 意图下收敛为 timed_out", () => {
  const result = applyTurnOutcome(
    { kind: "completed", terminalObservedAfterStop: true },
    { stopIntent: "deadline" },
  );
  assert.equal(result.state, "timed_out");
});

test("cancelled / interrupted / timed_out 都经过 stopping", () => {
  for (const [kind, expected] of [
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
    ["timed_out", "timed_out"],
  ] as const) {
    const result = applyTurnOutcome({ kind, terminalObservedAfterStop: false });
    assert.equal(result.state, expected);
    assert.deepEqual(result.path, ["stopping", expected]);
  }
});

test("failed 在 running 下必须先 draining，在 starting 下可直接 failed", () => {
  const fromRunning = applyTurnOutcome({ kind: "failed", terminalObservedAfterStop: false });
  assert.deepEqual(fromRunning.path, ["draining", "failed"]);
  assert.equal(fromRunning.state, "failed");

  const fromStarting = applyTurnOutcome(
    { kind: "failed", terminalObservedAfterStop: false },
    { from: "starting" },
  );
  assert.deepEqual(fromStarting.path, ["failed"]);
});

test("unknown 直接收敛，不猜成功也不猜失败", () => {
  const result = applyTurnOutcome({ kind: "unknown", terminalObservedAfterStop: false });
  assert.equal(result.state, "unknown");
  assert.deepEqual(result.path, ["unknown"]);
});

test("起点已经是 stopping 时不重复加停跳", () => {
  const result = applyTurnOutcome(
    { kind: "completed", terminalObservedAfterStop: true },
    { from: "stopping" },
  );
  assert.equal(result.state, "cancelled");
  assert.deepEqual(result.path, ["cancelled"]);
});

test("已处于终态时任何后端终态都不能改写", () => {
  const result = applyTurnOutcome(
    { kind: "completed", terminalObservedAfterStop: false },
    { from: "cancelled" },
  );
  assert.equal(result.state, "cancelled");
  assert.equal(result.accepted, false);
  assert.equal(result.rejected, "terminal_immutable");
});
