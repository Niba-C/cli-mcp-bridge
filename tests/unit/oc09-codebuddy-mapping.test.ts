/**
 * OC-09-03：CodeBuddy 消息映射纯函数测试。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  CODEBUDDY_REVIEW_DISALLOWED_TOOLS,
  isReviewHardDenied,
  mapCbOutcome,
  observedModelFromAssistant,
  toolSummary,
} from "../../src/backend/codebuddy/mapping.ts";

test("result subtype 映射：success→completed，错误类→failed，无终态→unknown", () => {
  assert.deepEqual(mapCbOutcome({ subtype: "success", isError: false, errors: [], resultObserved: true }), {
    kind: "completed",
    stopReason: "turn_complete",
    errorCode: null,
  });
  for (const subtype of ["error_during_execution", "error_max_turns", "error_max_budget_usd"]) {
    const mapped = mapCbOutcome({ subtype, isError: true, errors: ["x"], resultObserved: true });
    assert.equal(mapped.kind, "failed", subtype);
  }
  assert.equal(mapCbOutcome({ subtype: "error_max_turns", isError: true, errors: [], resultObserved: true }).stopReason, "output_limit");

  // OC-06 教训：exit 0 + error subtype 不成功；没有任何 result 消息同样不成功。
  assert.equal(mapCbOutcome({ subtype: null, isError: false, errors: [], resultObserved: false }).kind, "unknown");
  // 有 result 但 is_error=true 且 subtype=success 也按失败收敛（防御）。
  assert.equal(mapCbOutcome({ subtype: "success", isError: true, errors: ["e"], resultObserved: true }).kind, "failed");
});

test("observedModel 只认 assistant 消息里的字符串模型", () => {
  assert.equal(observedModelFromAssistant({ model: "glm-5.3" }), "glm-5.3");
  assert.equal(observedModelFromAssistant({ model: "" }), null);
  assert.equal(observedModelFromAssistant({ model: 42 }), null);
  assert.equal(observedModelFromAssistant(null), null);
});

test("assistantText 拼接 text 块并截断", () => {
  assert.equal(assistantText([{ type: "text", text: "a" }, { type: "tool_use", id: "t" }, { type: "text", text: "b" }]), "ab");
  assert.equal(assistantText([]), "");
  const huge = assistantText(Array.from({ length: 5_000 }, () => ({ type: "text", text: "x".repeat(100) })));
  assert.ok(huge.endsWith("[truncated]"));
});

test("review 硬拒绝清单覆盖 shell/写入/后台 Agent，operator 不可放开", () => {
  for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"]) {
    assert.equal(isReviewHardDenied(tool), true, tool);
  }
  assert.equal(isReviewHardDenied("Read"), false);
  assert.ok(CODEBUDDY_REVIEW_DISALLOWED_TOOLS.includes("Bash"));
});

test("toolSummary 有界且不展开超大参数", () => {
  const summary = toolSummary("Read", { file_path: "a".repeat(5_000) });
  assert.ok(summary.length <= 220);
  assert.ok(summary.startsWith("Read "));
});
