/**
 * OC-09-04：Qoder adapter 全链路（真实子进程边界 + fake SDK）。
 *
 * 与 CodeBuddy 测试独立维护（方言不同）：认证文件传递、--config-dir 隔离、
 * interrupt 回执（interrupt_ack）、modelUsage 观测、两轮原生 resume。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  BackendApprovalRequest,
  BackendEvent,
  BackendEventSink,
  TurnSpec,
} from "../../src/contracts/backend.ts";
import { QoderAdapter } from "../../src/backend/qoder/adapter.ts";
import { isProcessAlive, processIdentity } from "../../src/core/proc.ts";
import { verifyOwnership } from "../../src/daemon/ownership.ts";

const FAKE_SDK = fileURLToPath(new URL("../fixtures/qoder-fake-sdk.mjs", import.meta.url));

test("Qoder 浏览器登录：账号 daemon 与隔离会话配置分离，两轮可续接", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-browser-"));
  const stateRoot = join(root, "state");
  const adapter = new QoderAdapter({ executable: process.execPath, stateRoot, workspaceRoot: root, serverEpoch: 1,
    authFile: null, authMode: "cli-login", sdkModuleId: FAKE_SDK });
  try {
    const first = await adapter.execute(spec("SCENARIO:text"), denySink());
    assert.equal(first.kind, "completed");
    const log = JSON.parse(readFileSync(join(stateRoot, "fake-qoder-sdk.json"), "utf8")) as Record<string, unknown>;
    assert.equal(log["daemonRoute"], true);
    assert.equal(log["authPresent"], true);
    assert.equal(log["configDir"], join(stateRoot, "config"));
    const second = await adapter.execute(spec("SCENARIO:text", { runId: "run_00000000-0000-4000-8000-0000000000ee" as TurnSpec["runId"] }), denySink());
    assert.equal(second.kind, "completed");
    const next = JSON.parse(readFileSync(join(stateRoot, "fake-qoder-sdk.json"), "utf8")) as Record<string, unknown>;
    assert.equal(next["resume"], "qd-fake-session");
  } finally { await adapter.close(); rmSync(root, { recursive: true, force: true }); }
});

function makeAdapter(
  root: string,
  subdir = "state",
  hooks: {
    onWorkerSpawned?: (info: { pid: number; pgid: number; processIdentity: string | null }) => void;
    onWorkerExited?: (info: { pid: number; expected: boolean; remaining: number }) => void;
    deadlineGraceMs?: number;
  } = {},
): QoderAdapter {
  const authFile = join(root, subdir, "auth.json");
  // credential-file：测试专用私有认证文件（fake SDK 只验证存在性）。
  mkdirSync(join(root, subdir), { recursive: true, mode: 0o700 });
  writeFileSync(authFile, `${JSON.stringify({ accessToken: "oc09-fake-pat" })}\n`, { mode: 0o600 });
  return new QoderAdapter({
    executable: process.execPath,
    stateRoot: join(root, subdir),
    workspaceRoot: root,
    serverEpoch: 1,
    authFile,
    sdkModuleId: FAKE_SDK,
    ...(hooks.onWorkerSpawned === undefined ? {} : { onWorkerSpawned: hooks.onWorkerSpawned }),
    ...(hooks.onWorkerExited === undefined ? {} : { onWorkerExited: hooks.onWorkerExited }),
    ...(hooks.deadlineGraceMs === undefined ? {} : { deadlineGraceMs: hooks.deadlineGraceMs }),
  });
}

function spec(prompt: string, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    runId: "run_00000000-0000-4000-8000-0000000000qd" as TurnSpec["runId"],
    session: { backendSessionId: "qd-test-session", serverEpoch: 1, backendVersion: null },
    prompt,
    model: { backendId: "qoder", modelRef: "qoder-max", opencode: null },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    attemptId: "att_qd_test",
    ...overrides,
  };
}

function denySink(): BackendEventSink {
  return {
    emit(_event: BackendEvent) {},
    requestApproval(_request: BackendApprovalRequest) {
      return Promise.resolve({ decision: "deny", actor: "operator" } as const);
    },
    requestInput() {
      return Promise.resolve("unsupported" as const);
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("OC-09-04 Qoder：文本轮次经真实 worker 完成并回收；auth 经 credential-file", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root, "state2");
  try {
    const outcome = await adapter.execute(spec("SCENARIO:text"), denySink());
    assert.equal(outcome.kind, "completed", `终态应为 completed，收到 ${JSON.stringify(outcome.error)}`);
    assert.equal(outcome.agentReported, "QODER FAKE 结果");
    assert.equal(outcome.usage.source, "backend");
    assert.equal(outcome.usage.inputTokens, 3);

    const captured = JSON.parse(readFileSync(join(root, "state2", "fake-qoder-sdk.json"), "utf8")) as Record<string, unknown>;
    assert.equal(captured["model"], "qoder-max");
    assert.equal(captured["authPresent"], true, "credential-file 的 accessToken 应传入 SDK");
    assert.equal(captured["permissionMode"], "default");
    assert.match(String(captured["configDir"]), /state2\/config$/);
    assert.match(String(captured["pathToQoderCLIExecutable"]), /node$/);

    // close() 后 worker 与 fake CLI 后代全部退出。
    const workerPid = adapter.workerPid;
    const cliPid = captured["cliChildPid"] as number;
    assert.ok(workerPid !== null && isProcessAlive(workerPid), "执行期间 worker 存活");
    await adapter.close();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(isProcessAlive(workerPid), false, "close 后 worker 必须退出");
    if (typeof cliPid === "number") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(isProcessAlive(cliPid), false, "close 后 fake CLI 后代必须被回收");
    }
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-04 Qoder：error→failed；无结构终态→unknown；modelUsage 不冒充双模型", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root);
  const adapter2 = makeAdapter(root, "state-b");
  try {
    const failed = await adapter.execute(spec("SCENARIO:error"), denySink());
    assert.equal(failed.kind, "failed");
    assert.equal(failed.error?.code, "error_during_execution");
    assert.match(failed.error?.message ?? "", /qoder fake 执行错误/);

    const unknown = await adapter2.execute(
      spec("SCENARIO:no-result", {
        session: { backendSessionId: "qd-u1", serverEpoch: 1, backendVersion: null },
        runId: "run_00000000-0000-4000-8000-0000000000qe" as TurnSpec["runId"],
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

test("OC-09-04 Qoder：Write 硬拒绝不进审批；Read 走审批放行", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root);
  const adapter2 = makeAdapter(root, "state-b");
  try {
    const approvals: BackendApprovalRequest[] = [];
    const denied = {
      emit() {},
      requestApproval(request: BackendApprovalRequest) {
        approvals.push(request);
        return Promise.resolve({ decision: "deny", actor: "operator" } as const);
      },
      requestInput() {
        return Promise.resolve("unsupported" as const);
      },
    } satisfies BackendEventSink;
    await adapter.execute(spec("SCENARIO:hard-tool"), denied);
    const captured1 = JSON.parse(readFileSync(join(root, "state", "fake-qoder-sdk.json"), "utf8")) as {
      canUseToolCalls: Array<{ tool: string; decision: { behavior?: string } | null }>;
    };
    assert.equal(approvals.length, 0, "Write 硬拒绝不得进入审批队列");
    assert.equal(captured1.canUseToolCalls[0]?.tool, "Write");
    assert.equal(captured1.canUseToolCalls[0]?.decision?.behavior, "deny");

    const approvals2: BackendApprovalRequest[] = [];
    const allowed = {
      emit() {},
      requestApproval(request: BackendApprovalRequest) {
        approvals2.push(request);
        return Promise.resolve({ decision: "allow_once", actor: "operator" } as const);
      },
      requestInput() {
        return Promise.resolve("unsupported" as const);
      },
    } satisfies BackendEventSink;
    await adapter2.execute(spec("SCENARIO:ask-tool"), allowed);
    const captured2 = JSON.parse(readFileSync(join(root, "state-b", "fake-qoder-sdk.json"), "utf8")) as typeof captured1;
    assert.equal(approvals2.length, 1, "Read 应进审批队列");
    assert.equal(approvals2[0]?.toolName, "Read");
    assert.equal(captured2.canUseToolCalls[0]?.decision?.behavior, "allow", "allow_once 应放行");
  } finally {
    await adapter.close().catch(() => undefined);
    await adapter2.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09-04 Qoder：interrupt 带排队消息回执；两轮原生 resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root, "state-i");
  try {
    // hang 场景 + interrupt：确认回执与失败收敛。
    const outcomePromise = adapter.execute(spec("SCENARIO:hang"), denySink());
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "qd-h1", serverEpoch: 1, backendVersion: null },
      intent: "interrupt",
      graceMs: 8_000,
    });
    assert.equal(stop.confirmed, true, "interrupt 后 run 应静止");
    assert.match(stop.detail, /queued=qmsg_interrupt-1/, "interrupt_ack 的排队 UUID 应进停止证据");
    const outcome = await outcomePromise;
    assert.equal(outcome.kind, "failed");

    // 两轮：独立 adapter（hang 轮已建会话），首轮无 resume、第二轮续接。
    const resumeAdapter = makeAdapter(root, "state-r");
    try {
      const first = await resumeAdapter.execute(spec("SCENARIO:text", { runId: "run_00000000-0000-4000-8000-0000000000qa" as TurnSpec["runId"] }), denySink());
      assert.equal(first.kind, "completed");
      const turn1 = JSON.parse(readFileSync(join(root, "state-r", "fake-qoder-sdk.json"), "utf8")) as { resume: string | null };
      assert.equal(turn1.resume, null, "首轮不带 resume");

      const second = await resumeAdapter.execute(spec("第二轮", { runId: "run_00000000-0000-4000-8000-0000000000qb" as TurnSpec["runId"] }), denySink());
      assert.equal(second.kind, "completed");
      const turn2 = JSON.parse(readFileSync(join(root, "state-r", "fake-qoder-sdk.json"), "utf8")) as { resume: string | null };
      assert.equal(turn2.resume, "qd-fake-session", "第二轮必须带首轮后端会话 ID 续接");
    } finally {
      await resumeAdapter.close().catch(() => undefined);
    }
  } finally {
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：Qoder 正常取消必须确认后台 CLI 已静止", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root, "state-bg");
  try {
    const outcomePromise = adapter.execute(spec("SCENARIO:bg-writer"), denySink());
    const marker = join(root, "state-bg", "background-marker");
    await waitUntil(() => existsSync(marker), 5_000);
    const captured = JSON.parse(readFileSync(join(root, "state-bg", "fake-qoder-sdk.json"), "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    assert.ok(cliPid > 0, "fake CLI 已启动");

    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "qd-bg", serverEpoch: 1, backendVersion: null },
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

test("OC-09 复核 P1：Qoder worker 身份用 lstart、自成进程组", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const spawned: Array<{ pid: number; pgid: number; processIdentity: string | null }> = [];
  const adapter = makeAdapter(root, "state-id", { onWorkerSpawned: (info) => spawned.push(info) });
  try {
    const outcome = await adapter.execute(spec("SCENARIO:text"), denySink());
    assert.equal(outcome.kind, "completed");
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
    await adapter.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OC-09 复核 P1：Qoder 轮次超时后真实停止执行，取消不得假确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const adapter = makeAdapter(root, "state-timeout", { deadlineGraceMs: 150 });
  try {
    const attempt = adapter.execute(
      spec("SCENARIO:stuck", { deadlineAt: new Date(Date.now() + 50).toISOString() }),
      denySink(),
    );
    const error = await attempt.then(() => null, (cause: Error) => cause);
    assert.ok(error instanceof Error, "interrupt/abort 均无效的轮次必须由 adapter 超时收敛");
    assert.match(error.message, /超时/);

    const captured = JSON.parse(readFileSync(join(root, "state-timeout", "fake-qoder-sdk.json"), "utf8")) as { cliChildPid?: number };
    const cliPid = Number(captured.cliChildPid ?? 0);
    assert.ok(cliPid > 0, "fake CLI 已启动");

    const stop = await adapter.stop({
      runId: spec("").runId,
      session: { backendSessionId: "qd-timeout", serverEpoch: 1, backendVersion: null },
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

test("OC-09 复核 P2：Qoder 无结构终态异常保持 unknown；结构终态保留 subtype", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
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

test("OC-09 复核 P1：Qoder worker 异常退出后不得在 CLI 存活时假确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-qd-"));
  const exits: Array<{ pid: number; expected: boolean; remaining: number }> = [];
  const adapter = makeAdapter(root, "state-crash", { onWorkerExited: (info) => exits.push(info) });
  try {
    const attempt = adapter.execute(spec("SCENARIO:stuck"), denySink());
    const logPath = join(root, "state-crash", "fake-qoder-sdk.json");
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
      session: { backendSessionId: "qd-crash", serverEpoch: 1, backendVersion: null },
      intent: "cancel",
      graceMs: 300,
    });
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
