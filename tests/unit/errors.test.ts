import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERROR_CODES,
  RETRYABLE_BY_DEFAULT,
  sanitizeDetails,
  toMcpToolError,
  toWireError,
  ZBridgeError,
} from "../../src/contracts/errors.ts";

test("每个错误码都有明确的 retryable 默认值", () => {
  for (const code of ERROR_CODES) {
    assert.equal(typeof RETRYABLE_BY_DEFAULT[code], "boolean", `${code} 缺少默认值`);
  }
  // 只有传输类错误允许用同一幂等 key 重试。
  assert.equal(RETRYABLE_BY_DEFAULT.BACKEND_UNAVAILABLE, true);
  assert.equal(RETRYABLE_BY_DEFAULT.SESSION_BUSY, false);
  assert.equal(RETRYABLE_BY_DEFAULT.STOP_UNCONFIRMED, false);
});

test("details 里的敏感键被剥离，超长字符串被截断", () => {
  const safe = sanitizeDetails({
    apiKey: "sk-live-should-not-leak",
    token: "abc",
    providerKey: "deepseek",
    nested: { authorization: "Bearer x", reason: "ok" },
    long: "x".repeat(600),
  });
  assert.deepEqual(safe, {
    providerKey: "deepseek",
    nested: { reason: "ok" },
    long: `${"x".repeat(512)}…`,
  });
});

test("对外错误体不含堆栈与 cause", () => {
  const cause = new Error("内部细节：/Users/example/secret");
  const error = new ZBridgeError("BACKEND_UNAVAILABLE", "后端不可用", { cause, details: { token: "t" } });
  const wire = error.toWire();
  assert.deepEqual(wire, { code: "BACKEND_UNAVAILABLE", message: "后端不可用", retryable: true });
  assert.equal(JSON.stringify(wire).includes("secret"), false);
});

test("未知异常收敛为 INVALID_ARGUMENT，不泄露原始 message", () => {
  const wire = toWireError(new Error("ENOENT /Users/example/x"));
  assert.equal(wire.code, "INVALID_ARGUMENT");
  assert.equal(wire.message.includes("example"), false);
});

test("MCP 工具错误带 isError 与 machine-readable code", () => {
  const response = toMcpToolError(new ZBridgeError("SESSION_BUSY", "会话忙"));
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, "SESSION_BUSY");
  assert.equal(response.content[0]?.type, "text");
});
