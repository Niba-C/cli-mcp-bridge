import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeResponse, parseRequestFrame, validatePayload } from "../../src/daemon/protocol.ts";
import { ZBridgeError } from "../../src/contracts/errors.ts";

const RUN = "run_00000000-0000-4000-8000-000000000002";

test("合法请求帧解析；空 payload 视为 {}", () => {
  const frame = parseRequestFrame(JSON.stringify({ v: 1, id: "req1", kind: "ping", payload: {} }));
  assert.equal(frame.id, "req1");
  assert.equal(frame.kind, "ping");
  const noPayload = parseRequestFrame(JSON.stringify({ v: 1, id: "req2", kind: "ping" }));
  assert.deepEqual(noPayload.payload, {});
});

test("外层信封 strict：principal/env 等多余字段直接拒绝", () => {
  for (const extra of ["principal", "principalId", "env", "backendUrl", "apiKey", "path"]) {
    assert.throws(
      () => parseRequestFrame(JSON.stringify({ v: 1, id: "x", kind: "ping", payload: {}, [extra]: "inject" })),
      (error: unknown) => error instanceof ZBridgeError && error.code === "INVALID_ARGUMENT",
      `字段 ${extra} 应被拒绝`,
    );
  }
});

test("payload strict：run.start 不接受任意路径/env/凭据/主体字段", () => {
  const base = { prompt: "hi", clientRequestId: "req-1", workspaceSlug: "main" };
  for (const [key, value] of Object.entries({
    principalId: "prn_fake",
    env: { FOO: "bar" },
    cwd: "/etc",
    backendUrl: "http://127.0.0.1:9",
    apiKey: "sk-inject",
    executablePath: "/bin/sh",
    modelID: "deepseek-chat",
  })) {
    assert.throws(
      () => validatePayload("run.start", { ...base, [key]: value }),
      (error: unknown) => error instanceof ZBridgeError && error.code === "INVALID_ARGUMENT",
      `run.start 字段 ${key} 应被拒绝`,
    );
  }
});

test("run.start 需要有界 prompt 与合法 ID 形状", () => {
  assert.throws(() => validatePayload("run.start", { prompt: "x".repeat(64 * 1024 + 1), clientRequestId: "r", workspaceSlug: "main" }), ZBridgeError);
  assert.throws(() => validatePayload("run.start", { prompt: "hi", clientRequestId: "bad id!", workspaceSlug: "main" }), ZBridgeError);
  assert.throws(
    () => validatePayload("run.start", { prompt: "hi", clientRequestId: "r", sessionId: "ses_wrong-shape" }),
    ZBridgeError,
  );
  // 合法输入通过并填充默认。
  const ok = validatePayload("run.start", { prompt: "hi", clientRequestId: "r-1", workspaceSlug: "main" });
  assert.equal(ok["workspaceSlug"], "main");
});

test("未知 kind 校验直接拒绝", () => {
  assert.throws(() => validatePayload("exec.arbitrary", {}), (error: unknown) => error instanceof ZBridgeError);
});

test("run.get 需要 runId 或 clientRequestId 之一", () => {
  assert.throws(() => validatePayload("run.get", {}), ZBridgeError);
  assert.ok(validatePayload("run.get", { runId: RUN }) !== null);
});

test("approval.decide 需要完整上下文（payloadHash/epoch/attempt）", () => {
  const base = { approvalId: "apr_00000000-0000-4000-8000-000000000003", decision: "allow_once" };
  assert.throws(() => validatePayload("approval.decide", base), ZBridgeError, "缺少上下文应拒绝");
  const ok = validatePayload("approval.decide", {
    ...base,
    payloadHash: "sha256:abcdef0123456789",
    serverEpoch: 3,
    attemptId: "att_1",
  });
  assert.equal(ok["serverEpoch"], 3);
});

test("响应编码是单行 NDJSON", () => {
  const line = encodeResponse({ v: 1, id: "x", ok: true, result: { prompt: "含\n换行" } });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.indexOf("\n"), line.length - 1, "除结尾外不得有换行（JSON 字符串内转义）");
});
