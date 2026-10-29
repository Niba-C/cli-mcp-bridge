/**
 * OC-06 故障：MCP 完整链路在强退后的恢复。
 *
 * 链路是真实的：SDK Client → stdio gateway 子进程 → 真实 daemon Unix IPC →
 * 既有 fake adapter/coordinator → SQLite。唯一被替换的是 `opencode serve`
 * 子进程（`--test-backend-cmd`），因此不启动真实 OpenCode 服务、不调用模型。
 *
 * 只补 OC-06 还缺的两条标准，不重复 oc04/oc05 已覆盖的夹具：
 * 1) 运行中 cancel 的持久回执在 daemon **SIGKILL** 重启后仍然重放，run 不复活；
 * 2) 派发后 daemon **SIGKILL**：重启收敛 unknown、回收 worker、不重发旧 prompt、
 *    阻塞同 session，且只有 operator 本地核对解除后才允许同会话续接。
 *
 * 所有等待有界；自建的 gateway/daemon/worker 都在 t.after 里按自己的记录清理。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readRequests } from "../helpers/oc03-harness.ts";
import { cleanupHarness, CLI_MAIN, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";

interface McpCallResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface GatewaySession {
  readonly client: Client;
  close(): Promise<void>;
}

async function connectGateway(harness: DaemonHarness): Promise<GatewaySession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot],
    stderr: "pipe",
  });
  const client = new Client({ name: "oc06-fault-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function callTool(session: GatewaySession, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return (await session.client.callTool({ name, arguments: args })) as McpCallResult;
}

function errorCode(result: McpCallResult): string | undefined {
  return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
}

async function serviceEpoch(session: GatewaySession): Promise<number> {
  const caps = await callTool(session, "agent_capabilities", {});
  assert.notEqual(caps.isError, true, JSON.stringify(caps));
  return Number((caps.structuredContent as Record<string, unknown>)["serviceEpoch"]);
}

async function mainWorkspaceId(session: GatewaySession): Promise<string> {
  const list = await callTool(session, "workspace_list", {});
  const workspaces = (list.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces;
  const main = workspaces.find((workspace) => workspace["name"] === "main") ?? workspaces[0];
  assert.ok(main !== undefined, "夹具必须登记可用 workspace");
  return String(main["workspaceId"]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(description: string, probe: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) assert.fail(`等待超时: ${description}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

/** 只读打开业务库读 worker 记录（daemon 持写连接；WAL 允许并发读）。 */
function activeWorkerPids(harness: DaemonHarness): number[] {
  const db = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT pid FROM worker_processes WHERE status = 'active'")
      .all()
      .map((row) => Number(row["pid"]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } finally {
    db.close();
  }
}

/**
 * 每个模拟服务启动时会清空自己的请求日志，因此「重启后是否重放」不能只看计数：
 * 权威证据是数据库里的 dispatch_intents（run_id UNIQUE，恢复只收敛 run 状态、
 * 不新增也不改写派发证据），日志只用来核对**新 worker** 实际收到的 prompt 文本。
 */
function promptTexts(harness: DaemonHarness): string[] {
  return readRequests(harness.paths.backendLog)
    .filter((entry) => typeof entry["route"] === "string" && (entry["route"] as string).endsWith("/prompt_async"))
    .map((entry) => {
      const body = entry["body"] as { parts?: Array<{ text?: unknown }> } | undefined;
      return String(body?.parts?.[0]?.text ?? "");
    });
}

interface DispatchRow {
  readonly attemptId: string;
  readonly phase: string;
  readonly serverEpoch: number;
}

function dispatchRows(harness: DaemonHarness, runId: string): DispatchRow[] {
  const db = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT attempt_id, phase, server_epoch FROM dispatch_intents WHERE run_id = ?")
      .all(runId)
      .map((row) => ({
        attemptId: String(row["attempt_id"]),
        phase: String(row["phase"]),
        serverEpoch: Number(row["server_epoch"]),
      }));
  } finally {
    db.close();
  }
}

interface RunSnapshot {
  readonly runId: string;
  readonly sessionId: string;
  readonly state: string;
  readonly revision: number;
}

/** 等 run 真正进入 running（受理已完成、worker 已起），返回最后一次快照。 */
async function waitRunning(session: GatewaySession, runId: string, timeoutMs = 25_000): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot: RunSnapshot | null = null;
  for (;;) {
    const get = await callTool(session, "agent_get", { runId });
    assert.notEqual(get.isError, true, JSON.stringify(get));
    const payload = get.structuredContent as Record<string, unknown>;
    snapshot = {
      runId: String(payload["runId"]),
      sessionId: String(payload["sessionId"]),
      state: String(payload["state"]),
      revision: Number(payload["revision"]),
    };
    if (snapshot.state === "running") return snapshot;
    if (["completed", "failed", "cancelled", "interrupted", "timed_out", "unknown"].includes(snapshot.state)) {
      assert.fail(`run 在等待 running 时已终结: ${snapshot.state}`);
    }
    if (Date.now() > deadline) assert.fail(`run 未在 ${timeoutMs}ms 内进入 running（最后 ${snapshot.state}）`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

/**
 * 取当前 revision 后 cancel。修订可能被晚到事件推进，因此在 REVISION_CONFLICT 时
 * 刷新 revision 重试（有界 3 次），模拟客户端真实做法而不是放宽 daemon 校验。
 */
async function cancelRunningRun(
  session: GatewaySession,
  input: { readonly runId: string; readonly clientRequestId: string; readonly serviceEpoch: number },
): Promise<{ readonly result: McpCallResult; readonly args: Record<string, unknown> }> {
  let lastError: McpCallResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const get = await callTool(session, "agent_get", { runId: input.runId });
    const revision = Number((get.structuredContent as Record<string, unknown>)["revision"]);
    const args = {
      runId: input.runId,
      clientRequestId: input.clientRequestId,
      expectedRevision: revision,
      serviceEpoch: input.serviceEpoch,
    };
    const result = await callTool(session, "agent_cancel", args);
    if (result.isError !== true) return { result, args };
    lastError = result;
    assert.equal(errorCode(result), "REVISION_CONFLICT", `cancel 失败原因不应是 ${JSON.stringify(result.structuredContent)}`);
  }
  assert.fail(`cancel 连续冲突: ${JSON.stringify(lastError?.structuredContent)}`);
}

test("OC-06 MCP 运行中 cancel：daemon 强退重启后回执重放，run 不复活也不重放", async (t) => {
  const harness = await startDaemon({ scenario: "text-stall", runTimeoutMs: 120_000 });
  const ownedWorkerPids: number[] = [];
  t.after(async () => {
    await harness.shutdown();
    // 失败路径也只清理本夹具登记过的进程。
    for (const pid of ownedWorkerPids) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已退出。
        }
      }
    }
    cleanupHarness(harness);
  });

  const gateway = await connectGateway(harness);
  t.after(async () => {
    await gateway.close();
  });

  const epoch = await serviceEpoch(gateway);
  const workspaceId = await mainWorkspaceId(gateway);
  const requestId = `oc06-cancel-${Date.now()}`;
  const prompt = "长时间任务：等待运行中取消";

  const start = await callTool(gateway, "agent_start", {
    workspaceId,
    prompt,
    clientRequestId: requestId,
    serviceEpoch: epoch,
  });
  assert.notEqual(start.isError, true, JSON.stringify(start));
  const runId = String((start.structuredContent as Record<string, unknown>)["runId"]);

  const running = await waitRunning(gateway, runId);
  const pid = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const pids = activeWorkerPids(harness);
      if (pids.length > 0) return pids[0] as number;
      if (Date.now() > deadline) assert.fail("worker 身份未被落库");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  })();
  ownedWorkerPids.push(pid);
  const beforeDispatch = dispatchRows(harness, runId);
  assert.equal(beforeDispatch.length, 1, "取消前恰有一次派发意图");
  assert.notEqual(beforeDispatch[0]?.phase, "not_sent");
  assert.deepEqual(promptTexts(harness), [prompt]);

  const cancelled = await cancelRunningRun(gateway, {
    runId,
    clientRequestId: `${requestId}-cancel`,
    serviceEpoch: epoch,
  });
  const cancelPayload = cancelled.result.structuredContent as Record<string, unknown>;
  assert.equal(cancelPayload["confirmed"], true, JSON.stringify(cancelPayload));
  assert.equal(cancelPayload["state"], "cancelled", JSON.stringify(cancelPayload));
  assert.equal(cancelPayload["intent"], "cancel");

  // 强退：daemon 被 SIGKILL 后 worker（独占进程组）仍然存活，恢复必须负责回收。
  harness.daemon.kill("SIGKILL");
  await harness.waitExit(10_000);
  assert.equal(isAlive(pid), true, "daemon 强退后 worker 仍在运行（这正是恢复要处理的孤儿）");
  assert.deepEqual(promptTexts(harness), [prompt], "强退本身不得触发重发");

  await harness.respawn();
  await waitUntil("恢复后回收遗留 worker", () => !isAlive(pid), 10_000);

  const status = (await harness.status()) as {
    lastRecovery: {
      workers: Array<{ pid: number; attempted: boolean; confirmedStopped: boolean }>;
      runsConverged: number;
    };
  };
  const reclaimed = status.lastRecovery.workers.find((worker) => worker.pid === pid);
  assert.ok(reclaimed !== undefined, `恢复报告必须包含 pid=${pid}: ${JSON.stringify(status.lastRecovery)}`);
  assert.equal(reclaimed.attempted, true, JSON.stringify(reclaimed));
  assert.equal(reclaimed.confirmedStopped, true, JSON.stringify(reclaimed));

  // 回执跨代际重放：同 key + 原参数（旧 serviceEpoch、原 revision）返回逐字段相同响应。
  const replay = await callTool(gateway, "agent_cancel", cancelled.args);
  assert.notEqual(replay.isError, true, JSON.stringify(replay));
  assert.deepEqual(replay.structuredContent, cancelled.result.structuredContent);

  const after = await callTool(gateway, "agent_get", { runId });
  const afterPayload = after.structuredContent as Record<string, unknown>;
  assert.equal(afterPayload["state"], "cancelled", "重启不得把已确认取消的 run 改成未知或重新执行");
  assert.equal(String(afterPayload["sessionId"]), running.sessionId);

  // 取消是终态：同 session 不应被 unknown 阻塞。
  const sessions = await callTool(gateway, "agent_sessions", {});
  const sessionRow = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions.find(
    (row) => row["sessionId"] === running.sessionId,
  );
  assert.ok(sessionRow !== undefined, "会话必须仍在列表中");
  assert.equal(sessionRow["blockedReason"], null);
  assert.notEqual(sessionRow["state"], "unavailable");

  // 重启没有新增派发意图，也没有第二次 prompt。
  const afterDispatch = dispatchRows(harness, runId);
  assert.equal(afterDispatch.length, 1);
  assert.equal(afterDispatch[0]?.attemptId, beforeDispatch[0]?.attemptId, "重启不得生成新 attempt");
  assert.deepEqual(promptTexts(harness), [prompt], "整个取消流程只有一次派发");
});

test("OC-06 MCP 派发后 daemon 强退：unknown、回收 worker、禁止重放并阻塞同会话", async (t) => {
  const harness = await startDaemon({ scenario: "text-stall", runTimeoutMs: 120_000 });
  const ownedWorkerPids: number[] = [];
  t.after(async () => {
    await harness.shutdown();
    for (const pid of ownedWorkerPids) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已退出。
        }
      }
    }
    cleanupHarness(harness);
  });

  const gateway = await connectGateway(harness);
  t.after(async () => {
    await gateway.close();
  });

  const epoch = await serviceEpoch(gateway);
  const workspaceId = await mainWorkspaceId(gateway);
  const requestId = `oc06-crash-${Date.now()}`;
  const prompt = "派发后 daemon 强退恢复验证";

  const start = await callTool(gateway, "agent_start", {
    workspaceId,
    prompt,
    clientRequestId: requestId,
    serviceEpoch: epoch,
  });
  assert.notEqual(start.isError, true, JSON.stringify(start));
  const runId = String((start.structuredContent as Record<string, unknown>)["runId"]);

  const running = await waitRunning(gateway, runId);
  const pid = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const pids = activeWorkerPids(harness);
      if (pids.length > 0) return pids[0] as number;
      if (Date.now() > deadline) assert.fail("worker 身份未被落库");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  })();
  ownedWorkerPids.push(pid);
  const beforeDispatch = dispatchRows(harness, runId);
  assert.equal(beforeDispatch.length, 1, "崩溃前恰有一次派发意图");
  assert.notEqual(beforeDispatch[0]?.phase, "not_sent");
  assert.deepEqual(promptTexts(harness), [prompt]);

  // 派发后强退：没有任何终态证据，产品必须按 unknown 处理。
  harness.daemon.kill("SIGKILL");
  await harness.waitExit(10_000);
  assert.equal(isAlive(pid), true, "daemon 强退后 worker 仍存活（恢复必须核对身份后回收）");

  // 恢复用另一种场景：同会话续接时能正常完成，便于区分「恢复」与「新执行」。
  await harness.respawn(30_000, "text-happy");
  await waitUntil("恢复后回收遗留 worker", () => !isAlive(pid), 10_000);

  const get = await callTool(gateway, "agent_get", { runId });
  const snapshot = get.structuredContent as Record<string, unknown>;
  assert.equal(snapshot["state"], "unknown", `已派发未收尾的 run 必须是 unknown: ${JSON.stringify(snapshot)}`);
  assert.equal(snapshot["resultReady"], false);
  assert.equal(String(snapshot["sessionId"]), running.sessionId);

  const status = (await harness.status()) as {
    lastRecovery: {
      workers: Array<{ pid: number; attempted: boolean; confirmedStopped: boolean }>;
      runsConverged: number;
      blockedSessions: number;
    };
  };
  const reclaimed = status.lastRecovery.workers.find((worker) => worker.pid === pid);
  assert.ok(reclaimed !== undefined, JSON.stringify(status.lastRecovery));
  assert.equal(reclaimed.attempted, true, JSON.stringify(reclaimed));
  assert.equal(reclaimed.confirmedStopped, true, JSON.stringify(reclaimed));
  assert.equal(status.lastRecovery.runsConverged >= 1, true);
  assert.equal(status.lastRecovery.blockedSessions >= 1, true, "unknown 必须阻塞会话");

  // 同 session 新任务被阻塞：不能带着未核对的结果继续。
  const newEpoch = await serviceEpoch(gateway);
  const blocked = await callTool(gateway, "agent_start", {
    workspaceId,
    prompt: "崩溃后继续",
    clientRequestId: `${requestId}-blocked`,
    sessionId: running.sessionId,
    serviceEpoch: newEpoch,
  });
  assert.equal(blocked.isError, true, "被 unknown 阻塞的会话不得受理新任务");
  assert.equal(errorCode(blocked), "SESSION_BUSY", JSON.stringify(blocked.structuredContent));
  const details = (blocked.structuredContent as { error?: { details?: Record<string, unknown> } }).error?.details;
  assert.equal(String(details?.["blockedRunId"]), runId, "阻塞原因必须指向原 run");

  // 权威证据：旧 run 只有一条派发意图，attemptId 与阶段不被恢复改写
  // （confirmed 只说明消息存在，**结果**仍必须是 unknown）；旧 prompt 也没有
  // 出现在新 worker 的请求日志里。
  const afterCrashDispatch = dispatchRows(harness, runId);
  assert.deepEqual(afterCrashDispatch, beforeDispatch, "恢复不得新增或改写旧 run 的派发证据");
  assert.equal(afterCrashDispatch.length, 1, "重启不得为旧 run 新增派发意图");
  assert.deepEqual(promptTexts(harness), [prompt], "重启后不得重发旧 prompt");

  // operator 本地核对后解除阻塞——不是 MCP 工具，不能被 worker 自批。
  await harness.operator("session.release", { sessionId: running.sessionId, note: "OC-06 离线故障核对" });

  const resumed = await callTool(gateway, "agent_start", {
    workspaceId,
    prompt: "只回复 READY",
    clientRequestId: `${requestId}-resumed`,
    sessionId: running.sessionId,
    serviceEpoch: newEpoch,
  });
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
  const resumedRunId = String((resumed.structuredContent as Record<string, unknown>)["runId"]);
  const waited = await callTool(gateway, "agent_wait", {
    runs: [{ runId: resumedRunId }],
    returnWhen: "any_terminal",
    timeoutMs: 25_000,
  });
  const waitedRuns = (waited.structuredContent as { runs: Array<{ state: string }> }).runs;
  assert.equal(waitedRuns[0]?.state, "completed", JSON.stringify(waited.structuredContent));

  // 续接是一次全新派发：新 worker 只收到新 prompt，旧 prompt 不在日志里；
  // 旧 run 仍只有原 attempt。
  assert.deepEqual(promptTexts(harness), ["只回复 READY"], "续接只派发新 prompt，旧 prompt 没有被重放");
  assert.equal(dispatchRows(harness, runId).length, 1);
  assert.equal(dispatchRows(harness, resumedRunId).length, 1);

  const requests = readRequests(harness.paths.backendLog);
  assert.equal(
    requests.some((entry) => entry["route"] === "POST /session"),
    false,
    "续接必须加载旧后端会话，不得新建 POST /session",
  );
  assert.equal(
    requests.some((entry) => typeof entry["route"] === "string" && (entry["route"] as string).startsWith("GET /session/")),
    true,
    "应有 GET /session/{id} 的加载核对",
  );
});
