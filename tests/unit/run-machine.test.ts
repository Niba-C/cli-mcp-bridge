import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReach,
  canTransition,
  reduceRunPath,
  reduceRunState,
  RUN_TRANSITIONS,
  terminalStateForStop,
} from "../../src/core/run-machine.ts";
import { RUN_STATES, isTerminalRunState } from "../../src/contracts/run.ts";

test("只有终态没有出边", () => {
  for (const state of RUN_STATES) {
    if (isTerminalRunState(state)) assert.deepEqual(RUN_TRANSITIONS[state], [], `${state} 不应有出边`);
    else assert.ok(RUN_TRANSITIONS[state].length > 0, `${state} 应有出边`);
  }
});

test("典型合法迁移", () => {
  assert.equal(canTransition("queued", "starting"), true);
  assert.equal(canTransition("running", "waiting_approval"), true);
  assert.equal(canTransition("waiting_approval", "running"), true);
  assert.equal(canTransition("stopping", "cancelled"), true);
  assert.equal(canTransition("queued", "completed"), false);
});

test("单跳归约不允许跳过 draining：running → completed 被拒", () => {
  assert.equal(canTransition("running", "completed"), false);
  const direct = reduceRunState("running", "completed");
  assert.equal(direct.accepted, false);
  assert.equal(direct.reason, "illegal_transition");

  const queued = reduceRunState("queued", "completed");
  assert.equal(queued.accepted, false, "queued → completed 也不能跳");

  const path = reduceRunPath("running", ["draining", "completed"]);
  assert.equal(path.accepted, true);
  assert.equal(path.state, "completed");
  assert.deepEqual(path.applied, ["draining", "completed"]);
});

test("路径归约在第一个非法跳处停下，不继续应用后面的跳", () => {
  const result = reduceRunPath("running", ["completed", "cancelled"]);
  assert.equal(result.accepted, false);
  assert.equal(result.state, "running");
  assert.equal(result.rejectedAt, "completed");
  assert.deepEqual(result.applied, []);
});

test("stopping 之后到达 completed 被拒绝（A05）", () => {
  const result = reduceRunState("stopping", "completed");
  assert.equal(result.accepted, false);
  assert.equal(result.state, "stopping");
  assert.equal(result.reason, "illegal_transition");
});

test("canReach 只用于诊断，不代表归约允许跳过", () => {
  assert.equal(canReach("running", "completed"), true);
  assert.equal(reduceRunState("running", "completed").accepted, false);
});

test("终态不可改写：已确认的 completed 不被 cancel 覆盖", () => {
  const cancel = reduceRunState("completed", "cancelled");
  assert.equal(cancel.accepted, false);
  assert.equal(cancel.reason, "terminal_immutable");
  assert.equal(cancel.state, "completed");

  const again = reduceRunState("unknown", "completed");
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "terminal_immutable");
});

test("相同状态的重复上报是幂等 no-op", () => {
  const result = reduceRunState("running", "running");
  assert.deepEqual(result, { state: "running", accepted: true, reason: null });
});

test("stopReason 与停止意图的映射（产品中立原因）", () => {
  assert.equal(terminalStateForStop("cancel", "aborted"), "cancelled");
  assert.equal(terminalStateForStop("interrupt", "aborted"), "interrupted");
  assert.equal(terminalStateForStop("deadline", "aborted"), "timed_out");
  assert.equal(terminalStateForStop("cancel", "output_limit"), "failed");
  assert.equal(terminalStateForStop("cancel", "backend_error"), "failed");
  // 已请求停止却收到正常结束：证据矛盾，取 unknown，不猜成功。
  assert.equal(terminalStateForStop("cancel", "turn_complete"), "unknown");
  assert.equal(terminalStateForStop("cancel", "tool_calls_pending"), "unknown");
  assert.equal(terminalStateForStop("cancel", "something-new"), "unknown");
  assert.equal(terminalStateForStop("cancel", null), "unknown");
});
