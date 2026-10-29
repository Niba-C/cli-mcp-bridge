import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectIdKind,
  InvalidIdError,
  isId,
  newId,
  parseId,
  type RunId,
} from "../../src/contracts/ids.ts";

const FIXED = "123e4567-e89b-42d3-a456-426614174000";

test("按前缀生成与识别各类 ID", () => {
  const runId = newId("run", FIXED);
  assert.equal(runId, `run_${FIXED}`);
  assert.equal(isId("run", runId), true);
  assert.equal(isId("session", runId), false);
  assert.equal(detectIdKind(runId), "run");
});

test("拒绝拼错或非 uuid 的 ID", () => {
  assert.equal(isId("run", "run_123"), false);
  assert.equal(isId("run", `run_${FIXED}-extra`), false);
  assert.equal(isId("run", `ses_${FIXED}`), false);
  assert.equal(isId("run", 123), false);
  assert.equal(detectIdKind("hello"), null);
});

test("parseId 抛错但不回显原始值", () => {
  try {
    parseId("workspace", "/Users/example/private");
    assert.fail("应当抛错");
  } catch (error) {
    assert.ok(error instanceof InvalidIdError);
    assert.equal(error.message, "invalid workspace id");
    assert.equal(error.message.includes("example"), false);
  }
});

test("非法 uuid 不允许进入系统", () => {
  assert.throws(() => newId("run", "not-a-uuid"), TypeError);
  const id: RunId = newId("run", FIXED);
  assert.equal(typeof id, "string");
});
