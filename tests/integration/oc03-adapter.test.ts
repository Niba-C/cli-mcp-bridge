/**
 * OC-03 集成测试：真实 adapter 对着模拟 OpenCode 服务子进程。
 *
 * 全部离线：只 spawn `node tests/fixtures/oc03-fake-opencode.ts`，不启动
 * `/opt/homebrew/bin/opencode`、不读取用户配置、不调用任何模型 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { newId, type RunId } from "../../src/contracts/ids.ts";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import type { BackendSessionRef } from "../../src/contracts/backend.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import {
  createAdapterHarness,
  createStoreHarness,
  recordingSink,
  type AdapterHarness,
  type StoreHarness,
} from "../helpers/oc03-harness.ts";

const RUN_ID = newId("run", "00000000-0000-4000-8000-0000000000a1");

function sessionOf(harness: AdapterHarness): BackendSessionRef {
  const session = harness.session;
  assert.ok(session !== null, "harness 应当已建立后端会话");
  return session;
}

function deadline(ms = 4_000): string {
  return new Date(Date.now() + ms).toISOString();
}

test("正常文本：本 run 归属 + finish=stop 才完成，推理文本不进正文", async () => {
  const harness = await createAdapterHarness({ scenario: "text-happy" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "只回复 READY", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline() },
      harness.sink,
    );
    assert.equal(result.outcome.kind, "completed");
    assert.equal(result.outcome.stopReason, "turn_complete");
    assert.equal(result.outcome.agentReported, "READY");
    assert.equal(result.dispatch.requestOutcome, "accepted");
    assert.equal(result.dispatch.messageConfirmed, true);
    assert.match(result.dispatch.backendMessageId, /^msg/);
    assert.equal(result.observations.reportedProviderID, "minimax");
    assert.equal(result.observations.reportedModelID, "MiniMax-M3.1-Flash");
    assert.equal(result.outcome.terminalObservedAfterStop, false);
    assert.equal(result.outcome.error, null);

    const progress = harness.sink.events.filter((event) => event.type === "progress");
    const text = progress.map((event) => (event.type === "progress" ? event.text : "")).join("");
    assert.equal(text, "READY");
    assert.equal(text.includes("内部推理"), false, "推理文本不能进入进度或正文");
    assert.ok(result.observations.firstTextMs !== null);

    // 只发一次 prompt_async，且显式带 model 与 messageID。
    const prompts = harness.requests().filter((entry) => entry.route === "POST /session/ses_fake0000000000000000000001/prompt_async");
    assert.equal(prompts.length, 1, "写请求必须只发一次");
    const body = prompts[0]?.body as { messageID?: string; model?: { providerID?: string; modelID?: string } } | undefined;
    assert.equal(body?.messageID, result.dispatch.backendMessageId);
    assert.deepEqual(body?.model, { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" });
    // 认证头必须存在（请求被接受说明 Basic 认证通过）。
    assert.ok(harness.requests().every((entry) => entry["authenticated"] !== false));
  } finally {
    await harness.close();
  }
});

test("多段 assistant 工具轮：tool-calls 不是终态，末段 finish=stop 才完成", async () => {
  const harness = await createAdapterHarness({ scenario: "tool-round", pollIntervalMs: 5 });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "执行并总结", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline() },
      harness.sink,
    );
    assert.equal(result.outcome.kind, "completed");
    assert.equal(result.observations.assistantMessages, 2);
    assert.equal(result.outcome.agentReported, "DONE");
    assert.equal(result.observations.toolCalls.length, 1);
    assert.equal(result.observations.toolCalls[0]?.state, "completed");
    assert.deepEqual(harness.sink.tools, ["bash:requested", "bash:started", "bash:completed"]);
  } finally {
    await harness.close();
  }
});

test("错归属：parentID 不是本 run 的 assistant 不能让它完成", async () => {
  const harness = await createAdapterHarness({ scenario: "wrong-parent" });
  try {
    const started = Date.now();
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(1_500) },
      harness.sink,
    );
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.outcome.agentReported, null, "不属于本 run 的文本不能成为自述");
    assert.equal(result.observations.assistantMessages, 0);
    assert.ok(Date.now() - started < 6_000, "必须有界收敛");
  } finally {
    await harness.close();
  }
});

test("tool-calls 与 idle 都不是完成：观察结束只能是 unknown", async () => {
  for (const scenario of ["tool-calls-only", "idle-only"]) {
    const harness = await createAdapterHarness({ scenario });
    try {
      const result = await harness.adapter.executeTurn(
        { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(1_200) },
        harness.sink,
      );
      assert.notEqual(result.outcome.kind, "completed", scenario);
      assert.equal(result.outcome.kind, "unknown", scenario);
      assert.notEqual(result.outcome.stopReason, "turn_complete", scenario);
      assert.ok(result.outcome.error !== null, `${scenario}: unknown 必须带原因`);
    } finally {
      await harness.close();
    }
  }
});

test("SSE 中途断开：只用快照收敛，不凭 SSE 结束报完成", async () => {
  const harness = await createAdapterHarness({ scenario: "sse-close" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(1_200) },
      harness.sink,
    );
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.observations.sse.closed, true);
    assert.ok(result.observations.warnings.some((warning) => warning.includes("SSE")));
  } finally {
    await harness.close();
  }
});

test("后端错误：failed，不改报成功，也不当作取消", async () => {
  const harness = await createAdapterHarness({ scenario: "backend-error" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline() },
      harness.sink,
    );
    assert.equal(result.outcome.kind, "failed");
    assert.equal(result.outcome.stopReason, "backend_error");
    assert.equal(result.mapped.errorName, "ProviderAuthError");
    assert.equal(result.mapped.rawFinish, "error");
  } finally {
    await harness.close();
  }
});

test("SSE 故障注入：UTF-8 分片/CRLF/多 data 行/重复/未知事件都不破坏正文", async () => {
  const harness = await createAdapterHarness({ scenario: "sse-faults" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(4_000) },
      harness.sink,
    );
    assert.equal(result.outcome.kind, "completed");
    assert.equal(result.outcome.agentReported, "你好，世界🌍");
    const progress = harness.sink.events.filter((event) => event.type === "progress");
    const text = progress.map((event) => (event.type === "progress" ? event.text : "")).join("");
    assert.equal(text, "你好，世界🌍", "重复增量不能重复拼接");
    assert.equal(text.includes("内部推理"), false);
    assert.ok(result.observations.sse.duplicateEvents > 0, "应当观察到重复 frame 并被去重");
    assert.ok(result.observations.sse.unknownEvents > 0, "应当观察到未知事件并计数");
    assert.ok(result.observations.sse.frames > 0);
  } finally {
    await harness.close();
  }
});

test("后端返回其它供应商：立即中止，不继续真实调用", async () => {
  const harness = await createAdapterHarness({ scenario: "provider-mismatch" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(3_000) },
      harness.sink,
    );
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.outcome.kind, "failed");
    assert.equal(result.outcome.error?.code, "BACKEND_PROTOCOL_MISMATCH");
    // 中止后不能再有新的 prompt_async。
    const prompts = harness.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async"));
    assert.equal(prompts.length, 1);
    // 身份不匹配必须停掉本 worker：下一次调用只能靠新 serverEpoch 重启。
    assert.equal(harness.adapter.isWorkerAlive, false);
  } finally {
    await harness.close();
  }
});

test("早先一段 assistant 用了外国供应商：即使末段正常也不能 completed", async () => {
  const harness = await createAdapterHarness({ scenario: "provider-mismatch-early" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(3_000) },
      harness.sink,
    );
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.outcome.kind, "failed");
    assert.equal(result.outcome.error?.code, "BACKEND_PROTOCOL_MISMATCH");
    assert.equal(harness.adapter.isWorkerAlive, false);
    assert.equal(harness.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length, 1);
  } finally {
    await harness.close();
  }
});

test("OC-08 同供应商模型 ID 不符：身份校验按本轮选定值拒绝", async () => {
  const harness = await createAdapterHarness({ scenario: "model-mismatch" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(3_000) },
      harness.sink,
    );
    assert.equal(result.outcome.kind, "failed");
    assert.equal(result.outcome.error?.code, "BACKEND_PROTOCOL_MISMATCH");
    assert.equal(harness.adapter.isWorkerAlive, false, "身份不符必须立即回收 worker");
  } finally {
    await harness.close();
  }
});

test("工具状态无法识别：finish=stop 也不能算完成", async () => {
  const harness = await createAdapterHarness({ scenario: "unknown-tool-state" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(1_200) },
      harness.sink,
    );
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.outcome.kind, "unknown");
    assert.equal(result.observations.toolCalls[0]?.state, "unknown");
    assert.equal(result.observations.toolCalls.length, 1, "坏工具条目不能被丢掉");
  } finally {
    await harness.close();
  }
});

test("启动即拒绝：其它已连接供应商、缺少目标模型、非 loopback 地址", async () => {
  const foreign = await createAdapterHarness({ scenario: "provider-foreign", skipSession: true });
  try {
    await assert.rejects(
      () => foreign.adapter.createSession(specFor(foreign.dirs)),
      (error: unknown) => error instanceof ZBridgeError && error.code === "BACKEND_PROTOCOL_MISMATCH",
    );
    assert.equal(foreign.adapter.isWorkerAlive, false, "启动校验失败后必须清理 worker");
  } finally {
    await foreign.close();
  }

  const missing = await createAdapterHarness({ scenario: "provider-missing-model", skipSession: true });
  try {
    await assert.rejects(
      () => missing.adapter.createSession(specFor(missing.dirs)),
      (error: unknown) => error instanceof ZBridgeError && error.code === "BACKEND_PROTOCOL_MISMATCH",
    );
  } finally {
    await missing.close();
  }

  const lan = await createAdapterHarness({ scenario: "text-happy", announceHost: "0.0.0.0", skipSession: true });
  try {
    await assert.rejects(
      () => lan.adapter.createSession(specFor(lan.dirs)),
      (error: unknown) =>
        error instanceof ZBridgeError &&
        (error.code === "BACKEND_PROTOCOL_MISMATCH" || error.code === "BACKEND_UNAVAILABLE"),
    );
  } finally {
    await lan.close();
  }

  // 不在允许列表的模型在**启动 worker 之前**就被拒绝：没有任何请求发出（OC-08）。
  const profile = await createAdapterHarness({ scenario: "text-happy", skipSession: true });
  try {
    await assert.rejects(
      () =>
        profile.adapter.createSession({
          ...specFor(profile.dirs),
          model: { providerID: "deepseek", modelID: "deepseek-chat" },
        }),
      (error: unknown) => error instanceof ZBridgeError && error.code === "PROFILE_NOT_ALLOWED",
    );
    assert.equal(profile.requests().length, 0, "不允许的模型不能进入任何发送路径");
    assert.equal(profile.adapter.isWorkerAlive, false);
  } finally {
    await profile.close();
  }
});

test("HTTP 层三态：4xx 明确拒绝、响应丢失结果不明、204 仍需历史确认", async () => {
  const rejected = await createAdapterHarness({ scenario: "prompt-reject" });
  try {
    const result = await rejected.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(rejected), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(2_000) },
      rejected.sink,
    );
    assert.equal(result.dispatch.requestOutcome, "rejected");
    assert.equal(result.dispatch.messageConfirmed, false);
    assert.equal(result.outcome.kind, "failed");
    assert.equal(rejected.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length, 1);
  } finally {
    await rejected.close();
  }

  const unknown = await createAdapterHarness({ scenario: "prompt-unknown" });
  try {
    const result = await unknown.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(unknown), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(2_000) },
      unknown.sink,
    );
    assert.equal(result.dispatch.requestOutcome, "unknown");
    assert.equal(result.dispatch.messageConfirmed, false);
    assert.equal(result.outcome.kind, "unknown");
    // 结果不明时绝不重发。
    assert.equal(unknown.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length, 1);
  } finally {
    await unknown.close();
  }

  const noHistory = await createAdapterHarness({ scenario: "prompt-accepted-no-history" });
  try {
    const result = await noHistory.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(noHistory), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(2_000) },
      noHistory.sink,
    );
    assert.equal(result.dispatch.requestOutcome, "accepted", "HTTP 204 表示受理");
    assert.equal(result.dispatch.messageConfirmed, false, "但历史没有消息就不能算已发送确认");
    assert.equal(result.outcome.kind, "unknown");
  } finally {
    await noHistory.close();
  }
});

test("审批放行与拒绝：回复内容为 once/reject，拒绝不被报成取消", async () => {
  const allowSink = recordingSink(() => ({ decision: "allow_once", actor: "operator" }));
  const allow = await createAdapterHarness({ scenario: "permission-deny", sink: allowSink, policyProfile: "edit" });
  try {
    const result = await allow.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(allow), prompt: "写文件", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(5_000) },
      allowSink,
    );
    assert.equal(allowSink.approvals.length, 1);
    const request = allowSink.approvals[0];
    assert.ok(request !== undefined && request.type === "approval_requested");
    if (request !== undefined && request.type === "approval_requested") {
      assert.equal(request.request.requestKind, "tool_permission");
      assert.equal(request.request.toolName, "bash");
      assert.equal(request.request.toolCallId, "call_1");
      assert.equal(request.request.attemptId, "att_unassigned");
      assert.match(request.request.backendRequestId ?? "", /^per_/);
      assert.match(request.request.argumentsText, /sh \.\/work\.sh/);
    }
    assert.equal(result.outcome.kind, "completed");
    const replies = allow.requests().filter((entry) => String(entry.route ?? "").includes("/permission/"));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.reply, "once");
  } finally {
    await allow.close();
  }

  const denySink = recordingSink(() => ({ decision: "deny", actor: "operator" }));
  const deny = await createAdapterHarness({ scenario: "permission-deny", sink: denySink, policyProfile: "edit" });
  try {
    const result = await deny.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(deny), prompt: "写文件", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(5_000) },
      denySink,
    );
    const replies = deny.requests().filter((entry) => String(entry.route ?? "").includes("/permission/"));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.reply, "reject");
    assert.notEqual(result.outcome.kind, "cancelled", "工具被拒绝不等于用户取消");
    assert.equal(result.outcome.stopReason, "turn_complete");
    assert.equal(result.observations.toolCalls[0]?.state, "error");
  } finally {
    await deny.close();
  }
});

test("审批严格归属：跨会话与缺 tool.messageID 的请求一律不回复", async () => {
  const sink = recordingSink(() => ({ decision: "allow_once", actor: "operator" }));
  const harness = await createAdapterHarness({ scenario: "permission-foreign", sink, policyProfile: "edit" });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "跑自己的命令", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(5_000) },
      sink,
    );
    assert.equal(sink.approvals.length, 1, "只有本 run 的请求才需要操作者决定");
    const replies = harness.requests().filter((entry) => String(entry.route ?? "").includes("/permission/"));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.["requestId"], "per_own00000001", "绝不能回复 foreign/anonymous 请求");
    assert.equal(replies[0]?.reply, "once");
    assert.equal(result.outcome.kind, "completed");
    assert.ok(
      sink.events.some((event) => event.type === "warning" && event.code === "APPROVAL_UNATTRIBUTED"),
      "归属不明的请求必须留下警告",
    );
  } finally {
    await harness.close();
  }
});

test("审批超时：按产品期限收敛为 timed_out，不伪造用户拒绝", async () => {
  const sink = recordingSink(() => ({ decision: "timeout", actor: "product_expiry" }));
  const harness = await createAdapterHarness({ scenario: "permission-deny", sink, policyProfile: "edit", approvalTimeoutMs: 200 });
  try {
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "写文件", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(5_000) },
      sink,
    );
    assert.equal(result.stopCause, "approval_timeout");
    assert.equal(result.outcome.kind, "timed_out");
    assert.equal(result.outcome.error?.code, "APPROVAL_EXPIRED");
    // 超时不应该发出 once/reject（那是伪造决策）。
    assert.equal(harness.requests().filter((entry) => String(entry.route ?? "").includes("/permission/")).length, 0);
  } finally {
    await harness.close();
  }
});

test("deadline 有界：stall 场景在期限内收敛为 timed_out", async () => {
  const harness = await createAdapterHarness({ scenario: "deadline-stall" });
  try {
    const started = Date.now();
    const result = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(900) },
      harness.sink,
    );
    const elapsed = Date.now() - started;
    assert.equal(result.stopCause, "deadline");
    assert.equal(result.outcome.kind, "timed_out");
    assert.ok(elapsed < 6_000, `期限收敛太慢：${elapsed}ms`);
    assert.equal(result.outcome.stopReason, "aborted");
  } finally {
    await harness.close();
  }
});

test("abort + 匹配终态：stop 以 protocol 方式确认，晚到终态不改写", async () => {
  const harness = await createAdapterHarness({ scenario: "abort-settle" });
  try {
    const executing = harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "sleep", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(6_000) },
      harness.sink,
    );
    // 等到工具真的开始运行再 abort（否则 abort 会打在一个还没有工具的消息上）。
    await waitForTool(harness.sink, "bash:started");
    const outcome = await harness.adapter.stop({
      runId: RUN_ID,
      session: sessionOf(harness),
      intent: "cancel",
      graceMs: 2_000,
    });
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.method, "protocol");
    assert.match(outcome.detail, /没有存活后代/);
    const result = await executing;
    assert.equal(result.outcome.kind, "cancelled");
    assert.equal(result.outcome.stopReason, "aborted");
    assert.equal(result.outcome.terminalObservedAfterStop, true);
    assert.equal(result.observations.toolCalls[0]?.state, "completed");
  } finally {
    await harness.close();
  }
});

test("close 只在进程树确认退出后才成功", async () => {
  const harness = await createAdapterHarness({ scenario: "text-happy" });
  await harness.adapter.probe();
  assert.equal(harness.adapter.isWorkerAlive, true);
  await harness.adapter.close();
  assert.equal(harness.adapter.isWorkerAlive, false);
  harness.dirs.cleanup();
});

test("store 接线：受理 → possibly_sent → confirmed → draining → completed + 结果清单", async () => {
  const harness = await createStoreHarness({ scenario: "text-happy" });
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-1",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: harness.prompt,
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: harness.prompt,
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.equal(result.state, "completed");
    assert.equal(result.requestOutcome, "accepted");
    assert.equal(result.messageConfirmed, true);
    assert.equal(result.resultReady, true);

    const intent = harness.store.dispatches.findByRun(admitted.run.runId);
    assert.equal(intent?.phase, "confirmed");
    assert.match(intent?.backendMessageId ?? "", /^msg/);

    const manifest = harness.store.getResultManifest(admitted.run.runId);
    assert.equal(manifest.agentReported.length, 1);
    assert.equal(manifest.agentReported[0]?.includes("READY"), true);
    assert.ok(manifest.observed.some((claim) => claim.startsWith("assistantMessages=1")));
    assert.ok(manifest.observed.some((claim) => claim.startsWith("requestedModel=minimax/MiniMax-M3.1-Flash")));
    assert.equal(manifest.verification.length, 0);
    assert.equal(manifest.verified, false, "没有独立验证就不能 verified");

    const events = harness.store.readEvents(admitted.run.runId, { limit: 200 });
    assert.ok(events.events.some((event) => event.type === "run.progress"));
    assert.ok(events.events.some((event) => event.type === "run.draining"));
    assert.ok(events.events.some((event) => event.type === "run.terminal"));
    assert.equal(events.snapshotRevision, events.events.at(-1)?.seq ?? 0);
    for (const event of events.events) assert.equal(event.seq, event.revision);
    assert.equal(harness.store.runs.require(admitted.run.runId).state, "completed");
  } finally {
    await harness.close();
  }
});

test("store 接线：HTTP 结果不明 → unknown + session 阻塞 + 不重发", async () => {
  const harness = await createStoreHarness({ scenario: "prompt-unknown", deadlineMs: 3_000 });
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-unknown",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: harness.prompt,
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: harness.prompt,
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.equal(result.state, "unknown");
    assert.equal(result.resultReady, false);
    assert.equal(harness.store.dispatches.findByRun(admitted.run.runId)?.phase, "unknown");
    assert.equal(harness.store.dispatches.count(), 1);
    const session = harness.store.sessions.require(harness.fixture.session.sessionId);
    assert.equal(session.blockedReason, "unknown_outcome");
    assert.equal(session.recoveryVerification, "unverified");
    assert.equal(harness.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length, 1);
  } finally {
    await harness.close();
  }
});

test("store 接线：拒绝（4xx）记 not_sent 且 run failed，不阻塞会话", async () => {
  const harness = await createStoreHarness({ scenario: "prompt-reject" });
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-reject",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: harness.prompt,
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: harness.prompt,
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.equal(result.state, "failed");
    assert.equal(harness.store.dispatches.findByRun(admitted.run.runId)?.phase, "not_sent");
    const session = harness.store.sessions.require(harness.fixture.session.sessionId);
    assert.equal(session.blockedReason, null);
    assert.equal(session.state, "idle");
  } finally {
    await harness.close();
  }
});

test("store 接线：审批拒绝 → 记录本地审批但不冒充取消", async () => {
  const harness = await createStoreHarness({
    scenario: "permission-deny",
    policyProfile: "edit",
    onApproval: () => ({ decision: "deny", actor: "operator" }),
  });
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-deny",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: "写文件",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: "写文件",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.notEqual(result.state, "cancelled");
    assert.equal(result.state, "completed");
    const approvals = harness.store.listPendingApprovals(admitted.run.runId);
    assert.equal(approvals.length, 0, "决策后不再 pending");
    const events = harness.store.readEvents(admitted.run.runId, { limit: 200 }).events;
    assert.ok(events.some((event) => event.type === "run.approval_required"));
    assert.ok(events.some((event) => event.type === "run.approval_decided"));
  } finally {
    await harness.close();
  }
});

test("store 接线：等待审批期间状态是 waiting_approval，决策后回到 running", async () => {
  let storeRef: StoreHarness["store"] | null = null;
  let runRef: RunId | null = null;
  const observed: string[] = [];
  const harness = await createStoreHarness({
    scenario: "permission-deny",
    policyProfile: "edit",
    onApproval: async () => {
      // 决策之前必须先能观察到 waiting_approval：这正是「审批暂停执行」的证据。
      const started = Date.now();
      while (storeRef !== null && runRef !== null && storeRef.runs.require(runRef).state !== "waiting_approval") {
        if (Date.now() - started > 5_000) break;
        await delay(10);
      }
      observed.push(storeRef !== null && runRef !== null ? storeRef.runs.require(runRef).state : "missing");
      return { decision: "allow_once", actor: "operator" };
    },
  });
  storeRef = harness.store;
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-waiting",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: "写文件",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    runRef = admitted.run.runId;
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: "写文件",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.deepEqual(observed, ["waiting_approval"], "审批决策前状态必须是 waiting_approval");
    assert.equal(result.state, "completed");
    const events = harness.store.readEvents(admitted.run.runId, { limit: 200 }).events;
    const states = events.map((event) => event.state).filter((state) => state !== undefined);
    assert.ok(states.includes("waiting_approval"));
    assert.equal(states.includes("running"), true);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- 实时持久化与边界

test("实时落库：任务还挂在审批时，另一个连接已能读到 confirmed 消息 ID", async () => {
  let storeRef: StoreHarness["store"] | null = null;
  let runRef: RunId | null = null;
  const observed: {
    phase: string | null;
    messageId: string | null;
    state: string;
  }[] = [];
  const harness = await createStoreHarness({
    scenario: "permission-deny",
    policyProfile: "edit",
    useFileDb: true,
    onApproval: async () => {
      // 决策前用**另一个连接**读：这正是「任务挂起时崩溃」会看到的数据。
      const other = BridgeStore.open(harnessDbPath(), { migrate: false });
      try {
        const intent = runRef === null ? null : other.dispatches.findByRun(runRef);
        observed.push({
          phase: intent?.phase ?? null,
          messageId: intent?.backendMessageId ?? null,
          state: runRef === null ? "missing" : other.runs.require(runRef).state,
        });
      } finally {
        other.close();
      }
      return { decision: "allow_once", actor: "operator" };
    },
  });
  storeRef = harness.store;
  const harnessDbPath = () => {
    assert.ok(harness.dbPath !== null, "该用例需要文件库");
    return harness.dbPath;
  };
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-live-dispatch",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: "写文件",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: harness.deadlineAt,
    });
    runRef = admitted.run.runId;
    const result = await harness.coordinator.run({
      runId: admitted.run.runId,
      prompt: "写文件",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: harness.deadlineAt,
    });
    assert.equal(result.state, "completed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.phase, "confirmed", "审批挂起时就应当已经是 confirmed");
    assert.match(observed[0]?.messageId ?? "", /^msg/);
    assert.equal(observed[0]?.state, "waiting_approval");
    assert.ok(storeRef !== null);
    // 收尾后仍然是同一份证据。
    assert.equal(harness.store.dispatches.findByRun(admitted.run.runId)?.phase, "confirmed");
  } finally {
    await harness.close();
  }
});

test("发送前已过期：不派发、不写 possibly_sent、不发 HTTP", async () => {
  const harness = await createStoreHarness({ scenario: "text-happy" });
  try {
    const admitted = harness.store.admitRun({
      principal: harness.principal,
      sessionId: harness.fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc03-store-expired",
      serviceEpoch: harness.fixture.serviceEpoch,
      prompt: harness.prompt,
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await assert.rejects(
      () =>
        harness.coordinator.run({
          runId: admitted.run.runId,
          prompt: harness.prompt,
          model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      (error: unknown) => error instanceof ZBridgeError && error.code === "REQUEST_EXPIRED",
    );
    assert.equal(harness.store.dispatches.count(), 0, "过期任务不能留下发送意图");
    assert.equal(harness.store.runs.require(admitted.run.runId).state, "queued");
    assert.equal(harness.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length, 0);
  } finally {
    await harness.close();
  }
});

test("stop 关联校验：run／session／epoch 任一不符都拒绝，不发 abort", async () => {
  const harness = await createAdapterHarness({ scenario: "abort-settle" });
  try {
    const executing = harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "sleep", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(6_000) },
      harness.sink,
    );
    await waitForTool(harness.sink, "bash:started");
    const abortCount = () => harness.requests().filter((entry) => String(entry.route ?? "").includes("/abort")).length;
    const before = abortCount();

    const wrongRun = await harness.adapter.stop({
      runId: newId("run", "00000000-0000-4000-8000-0000000000b2"),
      session: sessionOf(harness),
      intent: "cancel",
      graceMs: 500,
    });
    assert.equal(wrongRun.confirmed, false);
    assert.match(wrongRun.detail, /runId/);

    const wrongSession = await harness.adapter.stop({
      runId: RUN_ID,
      session: { ...sessionOf(harness), backendSessionId: "ses_other0000000000000000000002" },
      intent: "cancel",
      graceMs: 500,
    });
    assert.equal(wrongSession.confirmed, false);
    assert.match(wrongSession.detail, /backendSessionId/);

    const wrongEpoch = await harness.adapter.stop({
      runId: RUN_ID,
      session: { ...sessionOf(harness), serverEpoch: sessionOf(harness).serverEpoch + 1 },
      intent: "cancel",
      graceMs: 500,
    });
    assert.equal(wrongEpoch.confirmed, false);
    assert.match(wrongEpoch.detail, /serverEpoch/);
    assert.equal(abortCount(), before, "校验失败时不能发 abort");

    // 正确的调用仍然有效。
    const ok = await harness.adapter.stop({ runId: RUN_ID, session: sessionOf(harness), intent: "cancel", graceMs: 2_000 });
    assert.equal(ok.confirmed, true);
    await executing;
  } finally {
    await harness.close();
  }
});

test("进程表不可读时不能确认停止；没有 worker 时也不能说「可读」", async () => {
  let unreadable = false;
  const harness = await createAdapterHarness({
    scenario: "abort-settle",
    stopGraceMs: 500,
    testProcessTable: () =>
      unreadable
        ? { ok: false, reason: "injected ps failure" }
        : { ok: true, rows: [] },
  });
  try {
    const executing = harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "sleep", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(8_000) },
      harness.sink,
    ).catch(() => null);
    await waitForTool(harness.sink, "bash:started");
    assert.equal(harness.adapter.processTableReadable(), true);

    unreadable = true;
    assert.equal(harness.adapter.processTableReadable(), false, "读不到进程表时不能声称可读");
    const outcome = await harness.adapter.stop({
      runId: RUN_ID,
      session: sessionOf(harness),
      intent: "cancel",
      graceMs: 500,
    });
    assert.equal(outcome.confirmed, false, "进程表未知不能算停止确认");
    assert.equal(outcome.method, "none");
    assert.match(outcome.detail, /进程表不可读|无法确认/);
    await executing;
  } finally {
    unreadable = false;
    await harness.close();
  }

  // 没有 worker 时也不能说进程表可读（否则「空」会被误当成「没有后代」）。
  const idle = await createAdapterHarness({ scenario: "text-happy", skipSession: true });
  try {
    assert.equal(idle.adapter.isWorkerAlive, false);
    assert.equal(idle.adapter.processTableReadable(), false);
  } finally {
    await idle.close();
  }
});

test("准备阶段耗时把期限耗尽：发送前再次核对并拒绝，不发 prompt_async", async () => {
  const harness = await createAdapterHarness({ scenario: "text-happy" });
  try {
    const started = Date.now();
    let hookCalled = false;
    await assert.rejects(
      () =>
        harness.adapter.executeTurn(
          {
            runId: RUN_ID,
            session: sessionOf(harness),
            prompt: "hi",
            model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
            deadlineAt: new Date(Date.now() + 250).toISOString(),
            onDispatch: {
              onMessageId: async () => {
                hookCalled = true;
                await delay(400);
              },
            },
          },
          harness.sink,
        ),
      (error: unknown) =>
        error instanceof ZBridgeError &&
        error.code === "REQUEST_EXPIRED" &&
        error.details?.["phase"] === "pre_send",
    );
    assert.equal(hookCalled, true, "用例应当真的在落库回调里耗时");
    assert.equal(
      harness.requests().filter((entry) => String(entry.route ?? "").includes("prompt_async")).length,
      0,
      "过期后不能调用模型",
    );
    assert.ok(Date.now() - started < 5_000);
    // 失败后 adapter 仍可复用（没有卡在 active 状态）。
    const ok = await harness.adapter.executeTurn(
      { runId: RUN_ID, session: sessionOf(harness), prompt: "hi", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: deadline(4_000) },
      harness.sink,
    );
    assert.equal(ok.outcome.kind, "completed");
  } finally {
    await harness.close();
  }
});

test("probe 只把 health 记为已验证，不把执行/取消伪装成已验证", async () => {
  const harness = await createAdapterHarness({ scenario: "text-happy" });
  try {
    const capabilities = await harness.adapter.probe();
    assert.equal(capabilities.adapterId, "opencode-http");
    assert.equal(capabilities.methods.health.support, "supported");
    assert.notEqual(capabilities.methods.health.verifiedAt, null);
    assert.match(capabilities.methods.health.evidenceRef ?? "", /global\/health/);
    assert.equal(capabilities.versions.backendServer.version, "1.18.32");
    assert.notEqual(capabilities.versions.backendServer.verifiedAt, null);

    for (const method of ["createSession", "loadSession", "execute", "stop", "close", "events", "resolvePermission"] as const) {
      assert.equal(capabilities.methods[method].support, "supported", `${method}: 实现声明`);
      assert.equal(capabilities.methods[method].verifiedAt, null, `${method}: 本次没有逐项验证`);
      assert.equal(capabilities.methods[method].evidenceRef, null, `${method}: 不能借用健康检查证据`);
    }
    assert.equal(capabilities.versions.adapter.verifiedAt, null);
    assert.equal(capabilities.versions.apiSchema.verifiedAt, null);
    assert.equal(capabilities.internalRetry.verifiedAt, null);
    assert.equal(capabilities.reviewWriteBlocked.support, "unknown");
    assert.equal(capabilities.methods.stop.support, "supported");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- 小工具

function specFor(dirs: { workspace: string; runDir: string }) {
  return {
    workspaceRoot: dirs.workspace,
    profile: "review" as const,
    policyProfile: "review" as const,
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: dirs.runDir,
  };
}

/** 等到 sink 里出现某个工具阶段（避免在工具还没开始时 abort）。 */
async function waitForTool(sink: { readonly tools: readonly string[] }, phase: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (sink.tools.includes(phase)) return;
    if (Date.now() - started > 8_000) throw new Error(`等待工具阶段 ${phase} 超时：${sink.tools.join(",")}`);
    await delay(10);
  }
}

