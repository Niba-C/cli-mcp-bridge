import assert from "node:assert/strict";
import { test } from "node:test";
import { mapOpencodeTurn, TURN_RESULTS } from "../../src/core/backend-result.ts";
import { applyTurnOutcome } from "../../src/core/apply-outcome.ts";

/** 全部证据齐备的正常完成输入。 */
const completedInfo = {
  finish: "stop",
  messageConfirmed: true,
  messageCompleted: true,
  toolsPending: false,
} as const;

test("普通未完成更新保持非终态，不把「尚未结束」当成终态 unknown", () => {
  const mapped = mapOpencodeTurn({ finish: null, messageConfirmed: true });
  assert.equal(mapped.terminal, false);
  assert.equal(mapped.result, "in_progress");
  assert.equal(mapped.kind, null);
});

test("无法归属的消息优先保持非终态，即使带中止错误", () => {
  const mapped = mapOpencodeTurn({ finish: null, errorName: "MessageAbortedError", messageConfirmed: false });
  assert.equal(mapped.terminal, false);
  assert.equal(mapped.result, "unattributed");
  assert.equal(mapped.kind, null);

  // 缺省 messageConfirmed 同样按「没有归属证据」处理，不能默认成功。
  const defaulted = mapOpencodeTurn({ finish: "stop" });
  assert.equal(defaulted.terminal, false);
  assert.equal(defaulted.result, "unattributed");
});

test("停止请求之后工具仍在运行：保持非终态，不把停止意图当成已取消", () => {
  const mapped = mapOpencodeTurn({
    finish: "tool-calls",
    stopping: true,
    toolsPending: true,
    messageConfirmed: true,
  });
  assert.equal(mapped.terminal, false);
  assert.equal(mapped.result, "tool_calls_pending");
  assert.equal(mapped.kind, null);
});

test("错误或取消也不能绕过「仍有工具运行」的检查", () => {
  for (const info of [
    { finish: null, errorName: "ProviderError", messageConfirmed: true, messageCompleted: true, toolsPending: true },
    {
      finish: null,
      errorName: "MessageAbortedError",
      messageConfirmed: true,
      messageCompleted: true,
      toolsPending: true,
    },
    { finish: "stop", stopping: true, messageConfirmed: true, messageCompleted: true, toolsPending: true },
  ] as const) {
    const mapped = mapOpencodeTurn(info);
    assert.equal(mapped.terminal, false);
    assert.equal(mapped.result, "tool_calls_pending");
  }
});

test("正常完成需要归属、消息完成与工具结束三项证据", () => {
  const mapped = mapOpencodeTurn(completedInfo);
  assert.equal(mapped.result, "completed");
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.kind, "completed");
  assert.equal(mapped.stopReason, "turn_complete");
  assert.equal(mapped.rawFinish, "stop");

  // 缺少完成证据：非终态。
  const noCompletion = mapOpencodeTurn({ finish: "stop", messageConfirmed: true, toolsPending: false });
  assert.equal(noCompletion.terminal, false);

  // 缺省工具状态：不能证明工具已结束，不能完成。
  const toolsUnknown = mapOpencodeTurn({ finish: "stop", messageConfirmed: true, messageCompleted: true });
  assert.equal(toolsUnknown.terminal, false);
  assert.equal(toolsUnknown.kind, null);
});

test("观察结束但缺少工具证据时只能是终态 unknown", () => {
  const mapped = mapOpencodeTurn({
    finish: "stop",
    messageConfirmed: true,
    messageCompleted: true,
    observationEnded: true,
  });
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.kind, "unknown");
});

test("消息完成但 finish 未知：终态 unknown，保留原始值供审计", () => {
  const mapped = mapOpencodeTurn({ ...completedInfo, finish: "brand-new-finish" });
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.result, "unknown");
  assert.equal(mapped.kind, "unknown");
  assert.equal(mapped.stopReason, "unknown:brand-new-finish");
  assert.equal(mapped.rawFinish, "brand-new-finish");
});

test("tool-calls 不是最终完成：即使消息结束也不是终态", () => {
  const mapped = mapOpencodeTurn({ ...completedInfo, finish: "tool-calls" });
  assert.equal(mapped.result, "tool_calls_pending");
  assert.equal(mapped.terminal, false);
  assert.equal(mapped.kind, null);

  const stillRunning = mapOpencodeTurn({ ...completedInfo, toolsPending: true });
  assert.equal(stillRunning.result, "tool_calls_pending");
  assert.equal(stillRunning.terminal, false);
});

test("后端错误映射为 failed，不改报成功", () => {
  for (const info of [
    { ...completedInfo, finish: null, errorName: "ProviderError" },
    { ...completedInfo, finish: "error" },
  ] as const) {
    const mapped = mapOpencodeTurn(info);
    assert.equal(mapped.result, "backend_error");
    assert.equal(mapped.terminal, true);
    assert.equal(mapped.kind, "failed");
    assert.equal(mapped.stopReason, "backend_error");
  }
});

test("已确认取消：中止错误 + 消息完成 + 工具结束才是 aborted", () => {
  const mapped = mapOpencodeTurn({
    finish: null,
    errorName: "MessageAbortedError",
    messageConfirmed: true,
    messageCompleted: true,
    toolsPending: false,
  });
  assert.equal(mapped.result, "aborted");
  assert.equal(mapped.terminal, true);
  assert.equal(mapped.kind, "cancelled");
  assert.equal(mapped.stopReason, "aborted");

  const kind = mapped.kind;
  assert.equal(kind, "cancelled");
  assert.ok(kind !== null);
  const applied = applyTurnOutcome({ kind, terminalObservedAfterStop: true }, { stopIntent: "cancel" });
  assert.equal(applied.state, "cancelled");
  assert.deepEqual(applied.path, ["stopping", "cancelled"]);
});

test("停止请求之后到达的 stop 未被确认时保持非终态，确认后也只能是 cancelled", () => {
  const intentOnly = mapOpencodeTurn({
    ...completedInfo,
    stopping: true,
    messageCompleted: false,
  });
  assert.equal(intentOnly.terminal, false);
  assert.equal(intentOnly.result, "stopping");

  const late = mapOpencodeTurn({ ...completedInfo, stopping: true });
  assert.equal(late.result, "aborted");
  assert.equal(late.terminal, true);
  assert.equal(late.kind, "cancelled");
  assert.notEqual(late.kind, "completed");

  const kind = late.kind;
  assert.equal(kind, "cancelled");
  assert.ok(kind !== null);
  const applied = applyTurnOutcome({ kind, terminalObservedAfterStop: true }, { stopIntent: "cancel" });
  assert.equal(applied.state, "cancelled");
  assert.deepEqual(applied.path, ["stopping", "cancelled"]);
});

test("输出上限与内容过滤是失败或拒绝，不是完成", () => {
  const length = mapOpencodeTurn({ ...completedInfo, finish: "length" });
  assert.equal(length.kind, "failed");
  assert.equal(length.stopReason, "output_limit");

  const filtered = mapOpencodeTurn({ ...completedInfo, finish: "content-filter" });
  assert.equal(filtered.kind, "failed");
  assert.equal(filtered.stopReason, "refusal");
});

test("观察已结束但消息未完成：终态 unknown；仍在观察时保持非终态", () => {
  const ended = mapOpencodeTurn({ finish: null, messageConfirmed: true, observationEnded: true });
  assert.equal(ended.terminal, true);
  assert.equal(ended.kind, "unknown");

  const running = mapOpencodeTurn({ finish: null, messageConfirmed: true });
  assert.equal(running.terminal, false);
});

test("映射结果与状态机衔接：completed 必须经过 draining", () => {
  const mapped = mapOpencodeTurn(completedInfo);
  assert.ok(mapped.kind !== null);
  const applied = applyTurnOutcome({ ...mapped, kind: mapped.kind, terminalObservedAfterStop: false });
  assert.deepEqual(applied.path, ["draining", "completed"]);
  assert.equal(applied.state, "completed");
});

test("映射只输出产品词汇，不把 OpenCode finish 原值当 stopReason", () => {
  for (const finish of ["stop", "tool-calls", "length", "content-filter", "error", "weird"]) {
    const mapped = mapOpencodeTurn({ ...completedInfo, finish });
    assert.notEqual(mapped.stopReason, finish, `finish=${finish} 不应直接成为 stopReason`);
    assert.ok((TURN_RESULTS as readonly string[]).includes(mapped.result));
  }
});
