/**
 * OC-09-03：CodeBuddy adapter 全链路（真实子进程边界 + fake SDK）。
 *
 * 链路：测试 → CodebuddyAdapter（daemon 侧）→ 独占 worker 进程（真实 spawn，
 * 运行 worker-main.ts）→ fake SDK 模块（--sdk-module 注入）→ fake CLI 子进程。
 * 断言聚焦协议与生命周期：结构终态、审批映射、observedModel、进程回收、
 * 无结构终态时的 unknown 收敛（CLI exit 0 不算成功）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ApprovalAnswer,
  BackendApprovalRequest,
  BackendEvent,
  BackendEventSink,
  TurnSpec,
} from "../../src/contracts/backend.ts";
import { CodebuddyAdapter } from "../../src/backend/codebuddy/adapter.ts";
import { isProcessAlive, processIdentity } from "../../src/core/proc.ts";
import { verifyOwnership } from "../../src/daemon/ownership.ts";

const FAKE_SDK = fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url));

function makeAdapter(root: string, subdir = "state"): CodebuddyAdapter {
  return new CodebuddyAdapter({
    executable: process.execPath,
    stateRoot: join(root, subdir),
    workspaceRoot: root,
    serverEpoch: 1,
    sdkModuleId: FAKE_SDK,
  });
}

function spec(prompt: string, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    runId: "run_00000000-0000-4000-8000-0000000000cb" as TurnSpec["runId"],
    session: { backendSessionId: "cb-test-session", serverEpoch: 1, backendVersion: null },
    prompt,
    model: { backendId: "codebuddy", modelRef: "glm-5.3", opencode: null },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    attemptId: "att_cb_test",
    ...overrides,
  };
}

function collectingSink(
  events: BackendEvent[],
  approvals: BackendApprovalRequest[],
  decide: (request: BackendApprovalRequest) => ApprovalAnswer,
): BackendEventSink {
  return {
    emit(event) {
      events.push(event);
    },
    requestApproval(request) {
      approvals.push(request);
      return Promise.resolve(decide(request));
    },
    requestInput() {
      return Promise.resolve("unsupported" as const);
    },
  };
}

const denySink = () => collectingSink([], [], () => ({ decision: "deny", actor: "operator" }));

function behaviorOf(call: { decision: unknown } | undefined): string {
  const decision = call?.decision;
  if (decision !== null && typeof decision === "object" && "behavior" in decision) {
    return String((decision as { behavior: unknown }).behavior);
  }
  return "missing";
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("OC-09-03 CodeBuddy：文本轮次经真实 worker 进程完成并回收", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root, "state2");
  try {
    const spawned: Array<{ pid: number; pgid: number; processIdentity: string | null }> = [];
    const recording = new CodebuddyAdapter({
      executable: process.execPath,
      stateRoot: join(root, "state3"),
      workspaceRoot: root,
      serverEpoch: 1,
      sdkModuleId: FAKE_SDK,
      onWorkerSpawned: (info) => spawned.push(info),
    });
    let outcome: Awaited<ReturnType<CodebuddyAdapter["execute"]>> | undefined;
    let events: BackendEvent[] = [];
    let accepted = false;
    let workerPidDuringRun: number | null = null;
    try {
      const sink = collectingSink(events, [], () => ({ decision: "deny", actor: "operator" }));
      outcome = await recording.execute(
        spec("SCENARIO:text", {
          onDispatch: {
            onAccepted: () => {
              accepted = true;
            },
          },
        }),
        sink,
      );
      workerPidDuringRun = recording.workerPid;
      assert.ok(workerPidDuringRun !== null && isProcessAlive(workerPidDuringRun), "执行期间 worker 存活");
      // P1：恢复身份必须是 ps lstart，而不是 pgid=...（后者与 verifyOwnership 永不相等）；
      // detached 启动让 pgid == pid，恢复时的组级回收才指向 worker 自己。
      assert.equal(spawned.length, 1, "worker 身份只上报一次");
      assert.equal(spawned[0]?.pgid, spawned[0]?.pid, "detached worker 自成进程组");
      assert.match(spawned[0]?.processIdentity ?? "", /^\w{3} \w{3} /, `身份格式应为 ps lstart，实际 ${String(spawned[0]?.processIdentity)}`);
      assert.equal(spawned[0]?.processIdentity, processIdentity(spawned[0]!.pid), "身份必须与恢复核对口径一致");
      assert.equal(
        verifyOwnership({ pid: spawned[0]!.pid, pgid: spawned[0]!.pgid, processIdentity: spawned[0]!.processIdentity }).kind,
        "confirmed",
        "恢复路径必须确认这个 worker，而不是判成 PID 复用",
      );
    } finally {
      await recording.close().catch(() => undefined);
    }

    assert.equal(outcome?.kind, "completed", `终态应为 completed，收到 ${JSON.stringify(outcome?.error)}`);
    assert.equal(outcome?.agentReported, "FAKE 结果");
    assert.equal(accepted, true, "dispatch 受理证据应回调");
    assert.equal(outcome?.usage.source, "backend");
    assert.equal(outcome?.usage.inputTokens, 3);
    assert.ok(spawned.length >= 1, "worker spawn 应被上报");
    assert.ok(events.some((event) => event.type === "message" && event.text.includes("FAKE 完成文本")));

    const captured = JSON.parse(readFileSync(join(root, "state3", "fake-sdk.json"), "utf8")) as Record<string, unknown>;
    assert.equal(captured["model"], "glm-5.3");
    assert.equal(captured["permissionMode"], "default");
    assert.match(String(captured["pathToCodebuddyCode"]), /codebuddy\.exe$/);
    assert.match(String(captured["envCodebuddyConfigDir"]), /state3\/config$/);

    // close() 后 worker 与 fake CLI 必须退出（owned 回收）。
    const cliPid = captured["cliChildPid"] as number;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(isProcessAlive(workerPidDuringRun), false, "close 后 worker 必须退出");
    if (typeof cliPid === "number") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(isProcessAlive(cliPid), false, "close 后 fake CLI 后代必须被回收");
    }
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-03 CodeBuddy：error subtype 映射为 failed；无结构终态收敛 unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root);
  const adapter2 = makeAdapter(root, "state-b");
  try {
    const failed = await adapter.execute(spec("SCENARIO:error"), denySink());
    assert.equal(failed.kind, "failed");
    assert.equal(failed.error?.code, "error_during_execution");
    assert.match(failed.error?.message ?? "", /fake 执行错误/);

    const unknown = await adapter2.execute(
      spec("SCENARIO:no-result", {
        session: { backendSessionId: "cb-u1", serverEpoch: 1, backendVersion: null },
        runId: "run_00000000-0000-4000-8000-0000000000cc" as TurnSpec["runId"],
      }),
      denySink(),
    );
    assert.equal(unknown.kind, "unknown", "无结构终态绝不能算成功");
  } finally {
    await adapter.close().catch(() => undefined);
    await adapter2.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-03 CodeBuddy：Write 硬拒绝不进审批；Read 走审批且 allow_once 放行", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root);
  const adapter2 = makeAdapter(root, "state-b");
  try {
    // 硬拒绝工具：sink.requestApproval 不应被调用；fake SDK 收到 deny。
    const approvals: BackendApprovalRequest[] = [];
    const denied = collectingSink([], approvals, () => ({ decision: "deny", actor: "operator" }));
    await adapter.execute(spec("SCENARIO:hard-tool"), denied);
    const captured1 = JSON.parse(readFileSync(join(root, "state", "fake-sdk.json"), "utf8")) as {
      canUseToolCalls: Array<{ tool: string; decision: unknown }>;
    };
    assert.equal(approvals.length, 0, "Write 硬拒绝不得进入审批队列");
    assert.equal(captured1.canUseToolCalls[0]?.tool, "Write");
    assert.equal(behaviorOf(captured1.canUseToolCalls[0]), "deny");

    const approvals2: BackendApprovalRequest[] = [];
    const allowed = collectingSink([], approvals2, () => ({ decision: "allow_once", actor: "operator" }));
    await adapter2.execute(spec("SCENARIO:ask-tool"), allowed);
    const captured2 = JSON.parse(readFileSync(join(root, "state-b", "fake-sdk.json"), "utf8")) as typeof captured1;
    assert.equal(approvals2.length, 1, "Read 应进审批队列");
    assert.equal(approvals2[0]?.toolName, "Read");
    assert.equal(behaviorOf(captured2.canUseToolCalls[0]), "allow", "allow_once 应放行");
  } finally {
    await adapter.close().catch(() => undefined);
    await adapter2.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-03 CodeBuddy：interrupt 经协议路径确认停止", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root);
  try {
    const outcomePromise = adapter.execute(spec("SCENARIO:hang"), denySink());
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "cb-h1", serverEpoch: 1, backendVersion: null },
      intent: "interrupt",
      graceMs: 8_000,
    });
    assert.equal(stop.confirmed, true, "interrupt 后 run 应静止");
    const outcome = await outcomePromise;
    assert.equal(outcome.kind, "failed", "interrupt 的结构终态按失败收敛");
    const captured = JSON.parse(readFileSync(join(root, "state", "fake-sdk.json"), "utf8")) as { interruptCount: number };
    assert.ok(captured.interruptCount >= 1, "SDK interrupt 应被调用");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：正常取消必须确认后台 CLI 已静止", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root, "state-bg");
  try {
    const outcomePromise = adapter.execute(spec("SCENARIO:bg-writer"), denySink());
    const marker = join(root, "state-bg", "background-marker");
    await waitUntil(() => existsSync(marker), 5_000);
    const captured = JSON.parse(readFileSync(join(root, "state-bg", "fake-sdk.json"), "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    assert.ok(cliPid > 0, "fake CLI 已启动");

    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "cb-bg", serverEpoch: 1, backendVersion: null },
      intent: "cancel",
      graceMs: 3_000,
    });
    assert.equal(stop.confirmed, true, `取消必须得到静止证据：${stop.detail}`);
    assert.notEqual(stop.method, "none", stop.detail);
    const bytesAtStop = readFileSync(marker).length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(readFileSync(marker).length, bytesAtStop, "确认停止后后台 CLI 不得继续写入");
    assert.equal(isProcessAlive(cliPid), false, "确认停止后 fake CLI 必须已退出");

    const outcome = await outcomePromise;
    assert.notEqual(outcome.kind, "completed", "被取消的轮次不得记为完成");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-03 CodeBuddy：同 adapter 第二轮带原生 resume 续接", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root);
  try {
    const first = await adapter.execute(spec("SCENARIO:text"), denySink());
    assert.equal(first.kind, "completed");
    const turn1 = JSON.parse(readFileSync(join(root, "state", "fake-sdk.json"), "utf8")) as { resume: string | null; sessionId: string | null };
    assert.equal(turn1.resume, null, "首轮不带 resume");
    assert.equal(turn1.sessionId, "cb-test-session", "首轮带自定义 sessionId");

    const second = await adapter.execute(
      spec("第二轮", { runId: "run_00000000-0000-4000-8000-0000000000cd" as TurnSpec["runId"] }),
      denySink(),
    );
    assert.equal(second.kind, "completed");
    const turn2 = JSON.parse(readFileSync(join(root, "state", "fake-sdk.json"), "utf8")) as { resume: string | null };
    assert.equal(turn2.resume, "cb-fake-session", "第二轮必须带首轮后端会话 ID 续接，不建空会话");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：轮次超时后真实停止执行，取消不得假确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = new CodebuddyAdapter({
    executable: process.execPath,
    stateRoot: join(root, "state-timeout"),
    workspaceRoot: root,
    serverEpoch: 1,
    sdkModuleId: FAKE_SDK,
    deadlineGraceMs: 150,
  });
  try {
    const attempt = adapter.execute(
      spec("SCENARIO:stuck", { deadlineAt: new Date(Date.now() + 50).toISOString() }),
      denySink(),
    );
    const error = await attempt.then(() => null, (cause: Error) => cause);
    assert.ok(error instanceof Error, "interrupt/abort 均无效的轮次必须由 adapter 超时收敛");
    assert.match(error.message, /超时/);

    const captured = JSON.parse(readFileSync(join(root, "state-timeout", "fake-sdk.json"), "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    assert.ok(cliPid > 0, "fake CLI 已启动");

    // 超时已把 pending 清空，但 worker 仍在执行：取消不能因此宣告 protocol/confirmed。
    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "cb-timeout", serverEpoch: 1, backendVersion: null },
      intent: "cancel",
      graceMs: 250,
    });
    assert.notEqual(stop.method, "protocol", `后台仍在执行时不得按协议确认：${stop.detail}`);
    if (stop.confirmed) assert.deepEqual(adapter.ownedProcessIds(), [], "confirmed 时不得还有归属进程存活");

    await waitUntil(() => !adapter.isWorkerAlive && !isProcessAlive(cliPid), 5_000);
    assert.equal(adapter.isWorkerAlive, false, "超时升级后 worker 必须退出");
    assert.equal(isProcessAlive(cliPid), false, "超时升级后 fake CLI 不得残留");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P2：无结构终态异常保持 unknown；结构终态保留 subtype", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = makeAdapter(root);
  try {
    const unknown = await adapter.execute(spec("SCENARIO:iterate-throw"), denySink());
    assert.equal(unknown.kind, "unknown", `无结构终态不得提升为 failed，收到 ${JSON.stringify(unknown)}`);
    assert.equal(unknown.error?.code, "no_structured_result");
    assert.match(unknown.error?.message ?? "", /fake 迭代异常/);
    assert.equal(unknown.stopReason, null);

    const cases = [
      { scenario: "SCENARIO:iterate-max-turns", code: "error_max_turns", stopReason: "output_limit" },
      { scenario: "SCENARIO:iterate-budget", code: "error_max_budget_usd", stopReason: "backend_error" },
      { scenario: "SCENARIO:iterate-exec-error", code: "error_during_execution", stopReason: "backend_error" },
    ] as const;
    for (const item of cases) {
      const failed = await adapter.execute(spec(item.scenario), denySink());
      assert.equal(failed.kind, "failed", `${item.scenario} 必须 failed：${JSON.stringify(failed)}`);
      assert.equal(failed.error?.code, item.code, `${item.scenario} 必须保留 SDK subtype`);
      assert.equal(failed.stopReason, item.stopReason, `${item.scenario} stopReason 映射不符`);
    }
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：worker 异常退出后不得在 CLI 存活时假确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const exits: Array<{ pid: number; expected: boolean; remaining: number }> = [];
  const adapter = new CodebuddyAdapter({
    executable: process.execPath,
    stateRoot: join(root, "state-crash"),
    workspaceRoot: root,
    serverEpoch: 1,
    sdkModuleId: FAKE_SDK,
    onWorkerExited: (info) => exits.push(info),
  });
  try {
    const attempt = adapter.execute(spec("SCENARIO:stuck"), denySink());
    const logPath = join(root, "state-crash", "fake-sdk.json");
    await waitUntil(() => {
      try {
        return typeof (JSON.parse(readFileSync(logPath, "utf8")) as { cliChildPid?: unknown }).cliChildPid === "number";
      } catch {
        return false;
      }
    }, 5_000);
    const captured = JSON.parse(readFileSync(logPath, "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    const workerPid = adapter.workerPid;
    assert.ok(workerPid !== null && cliPid > 0, "worker 与 fake CLI 已启动");
    assert.equal(isProcessAlive(cliPid), true);

    process.kill(workerPid, "SIGKILL");
    await assert.rejects(attempt, /worker 进程提前退出/);

    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "cb-crash", serverEpoch: 1, backendVersion: null },
      intent: "cancel",
      graceMs: 300,
    });
    // 核心不变量：确认停止时不得还有归属进程在跑。
    if (stop.confirmed) {
      assert.equal(isProcessAlive(cliPid), false, `confirmed 时 CLI 必须已停止：${stop.detail}`);
    }
    await waitUntil(() => !isProcessAlive(cliPid), 5_000);
    assert.equal(isProcessAlive(cliPid), false, "worker 异常退出后 CLI 不得残留");
    assert.equal(exits.length, 1, "worker 退出应回调一次");
    assert.equal(exits[0]?.expected, false, "SIGKILL 不是预期的 shutdown");
    assert.equal(exits[0]?.remaining, 0, "退出回收后不应有残留归属进程");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：超时后 worker 连 shutdown 都卡死时，仍由进程树回收收口", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-cb-"));
  const adapter = new CodebuddyAdapter({
    executable: process.execPath,
    stateRoot: join(root, "state-deadlock"),
    workspaceRoot: root,
    serverEpoch: 1,
    sdkModuleId: FAKE_SDK,
    deadlineGraceMs: 150,
  });
  try {
    const attempt = adapter.execute(
      spec("SCENARIO:stuck", { deadlineAt: new Date(Date.now() + 50).toISOString() }),
      denySink(),
    );
    const error = await attempt.then(() => null, (cause: Error) => cause);
    assert.ok(error instanceof Error, "stuck 轮次必须超时");

    const logPath = join(root, "state-deadlock", "fake-sdk.json");
    const captured = JSON.parse(readFileSync(logPath, "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    assert.ok(cliPid > 0, "fake CLI 已启动");

    // 不调用 stop：abortTimedOutRun 的 cancel → shutdown 都被 fake 忽略，
    // 必须在第三级组回收后退出，否则 CLI 会一直留在后台。
    await waitUntil(() => !adapter.isWorkerAlive && !isProcessAlive(cliPid), 8_000);
    assert.equal(adapter.isWorkerAlive, false, "shutdown 卡死时 worker 也必须退出");
    assert.equal(isProcessAlive(cliPid), false, "shutdown 卡死时 CLI 也不得残留");
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
