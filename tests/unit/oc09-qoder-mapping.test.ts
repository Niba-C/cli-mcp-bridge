/**
 * OC-09-04：Qoder 消息映射纯函数测试（与 CodeBuddy 清单独立）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  isReviewHardDenied,
  mapQdOutcome,
  observedModelFromAssistant,
  observedModelFromUsageKeys,
  QODER_REVIEW_DISALLOWED_TOOLS,
  toolSummary,
} from "../../src/backend/qoder/mapping.ts";

test("result subtype 映射：success→completed，错误类→failed，无终态→unknown", () => {
  assert.deepEqual(mapQdOutcome({ subtype: "success", isError: false, errors: [], resultObserved: true }), {
    kind: "completed",
    stopReason: "turn_complete",
    errorCode: null,
  });
  assert.equal(mapQdOutcome({ subtype: "error_max_turns", isError: true, errors: [], resultObserved: true }).stopReason, "output_limit");
  assert.equal(mapQdOutcome({ subtype: "error_max_budget_usd", isError: true, errors: [], resultObserved: true }).kind, "failed");
  assert.equal(mapQdOutcome({ subtype: null, isError: false, errors: [], resultObserved: false }).kind, "unknown");
  assert.equal(mapQdOutcome({ subtype: "success", isError: true, errors: ["e"], resultObserved: true }).kind, "failed");
});

test("observedModel：assistant 优先；modelUsage 单键可信、多键不猜", () => {
  assert.equal(observedModelFromAssistant({ model: "qoder-max" }), "qoder-max");
  assert.equal(observedModelFromAssistant({ model: "" }), null);
  assert.equal(observedModelFromAssistant(null), null);
  assert.equal(observedModelFromUsageKeys(["qoder-max"]), "qoder-max");
  assert.equal(observedModelFromUsageKeys([]), null);
  assert.equal(observedModelFromUsageKeys(["qoder-max", "qoder-flash"]), null, "一轮多模型无法唯一定位，保持无证据");
});

test("review 硬拒绝清单（Qoder 工具名）", () => {
  for (const tool of ["Bash", "Write", "Edit", "Agent", "Task"]) {
    assert.equal(isReviewHardDenied(tool), true, tool);
  }
  assert.equal(isReviewHardDenied("Read"), false);
  assert.ok(QODER_REVIEW_DISALLOWED_TOOLS.includes("Bash"));
});

test("assistantText 与 toolSummary 有界", () => {
  assert.equal(assistantText([{ type: "text", text: "a" }, { type: "other" }]), "a");
  assert.ok(toolSummary("Read", { file_path: "x".repeat(4_000) }).length <= 220);
});
