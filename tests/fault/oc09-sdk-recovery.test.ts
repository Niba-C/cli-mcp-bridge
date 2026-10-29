/**
 * OC-09-07 / B13：SDK 后端派发后 daemon 强退的离线恢复。
 *
 * 链路：client IPC → daemon → 注册表 → CodeBuddy adapter → 独占 worker 子进程
 *       → fake SDK（真实子进程边界）。daemon 被 SIGKILL 后：
 * - run 收敛 unknown，dispatch 证据不新增／不改写；
 * - 自建 worker 与 fake CLI 后代退出；
 * - 同会话保持阻塞，operator release 后才允许续接；
 * - 旧 prompt 不被重放。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupHarness, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";

const CB_FAKE = fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url));
const NODE = process.execPath;
const harnesses: DaemonHarness[] = [];

after(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness === undefined) continue;
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

function sessionDir(harness: DaemonHarness): string | null {
  const dir = join(harness.dataRoot, "backends", "codebuddy");
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((entry) => entry.startsWith("ses-"));
  return name === undefined ? null : join(dir, name);
}

function fakeLog(harness: DaemonHarness): Record<string, unknown> | null {
  const dir = sessionDir(harness);
  if (dir === null) return null;
  const file = join(dir, "fake-sdk.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("B13：CodeBuddy 派发后 daemon 强退→unknown、回收 worker、禁重放并阻塞会话", async () => {
  const harness = await startDaemon({
    scenario: "text-happy",
    sdkBackends: { codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE } },
  });
  harnesses.push(harness);

  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:hang",
    clientRequestId: "oc09-b13-crash",
    backend: "codebuddy",
    waitMs: 1,
  })) as Record<string, unknown>;
  const runId = started["runId"] as string;
  assert.match(runId, /^run_/);
  const sessionId = ((await harness.client("run.get", { runId })) as Record<string, unknown>)["sessionId"] as string;
  assert.match(sessionId, /^ses_/);

  await harness.waitFor("fake SDK 已收到 hang 轮次", async () =>
    fakeLog(harness) === null ? null : true,
    15_000,
  );

  const db = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
  let workerPids: number[];
  try {
    workerPids = db
      .prepare("SELECT pid FROM worker_processes WHERE status = 'active'")
      .all()
      .map((row) => Number(row["pid"]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } finally {
    db.close();
  }
  assert.ok(workerPids.length >= 1, "派发后应有 active worker 记录");
  const cliPid = Number(fakeLog(harness)?.["cliChildPid"] ?? 0);
  assert.ok(cliPid > 0, "fake CLI 子进程应已启动");

  harness.daemon.kill("SIGKILL");
  await harness.waitExit(15_000);

  // daemon 已死，worker 必须凭 stdin EOF 自尽；fake CLI 由 worker 退出前回收。
  await harness.waitFor("worker 进程退出", async () => (workerPids.some(isAlive) ? null : true), 10_000);
  await harness.waitFor("fake CLI 子进程退出", async () => (isAlive(cliPid) ? null : true), 10_000);

  await harness.respawn(30_000);

  const recovered = (await harness.client("run.get", { runId })) as Record<string, unknown>;
  assert.equal(recovered["state"], "unknown", JSON.stringify(recovered));
  assert.equal(recovered["backendId"], "codebuddy");
  assert.equal(
    ((await harness.client("run.get", { clientRequestId: "oc09-b13-crash" })) as Record<string, unknown>)["runId"],
    runId,
    "同 key 必须找回原 run",
  );

  // 同会话仍阻塞，且指向原 run；不能静默新开一轮。
  await assert.rejects(
    harness.client("run.start", {
      sessionId,
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-b13-after-crash",
      backend: "codebuddy",
    }),
    (error: unknown) => {
      const value = error as { code?: string; details?: { blockedRunId?: string } };
      return value.code === "SESSION_BUSY" && value.details?.blockedRunId === runId;
    },
  );

  // operator 本地核对后解除阻塞；同会话可继续，但不得重放旧 prompt。
  await harness.operator("session.release", { sessionId, note: "oc09-b13 离线恢复测试" });
  const followup = (await harness.client("run.start", {
    sessionId,
    prompt: "SCENARIO:text 恢复后",
    clientRequestId: "oc09-b13-followup",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(followup["state"], "completed", JSON.stringify(followup));
  assert.equal(followup["backendId"], "codebuddy");
  assert.notEqual(followup["runId"], runId);

  const captured = fakeLog(harness);
  assert.equal(captured?.["prompt"], "SCENARIO:text 恢复后", "重启后不得重放旧 hang prompt");

  const dispatch = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
  try {
    const row = dispatch.prepare("SELECT COUNT(*) AS n FROM dispatch_intents WHERE run_id = ?").get(runId) as Record<string, unknown>;
    assert.equal(Number(row["n"]), 1, "原 run 的派发证据不新增");
  } finally {
    dispatch.close();
  }
});

test("P1：超时回收期间不得派发下一轮（生产入口不重叠）", async () => {
  const harness = await startDaemon({
    scenario: "text-happy",
    runTimeoutMs: 10_000,
    sdkDeadlineGraceMs: 300,
    sdkBackends: { codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE } },
  });
  harnesses.push(harness);

  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:stuck-writer",
    clientRequestId: "oc09-timeout-overlap-old",
    backend: "codebuddy",
    waitMs: 1,
  })) as Record<string, unknown>;
  const firstRunId = first["runId"] as string;
  const dir = await harness.waitFor("旧轮会话目录出现", async () => sessionDir(harness), 15_000);
  const marker = join(dir, "background-marker");
  await harness.waitFor("旧轮 fake CLI 开始写入", async () => (existsSync(marker) ? true : null), 15_000);
  const cliPid = Number(fakeLog(harness)?.["cliChildPid"] ?? 0);
  assert.ok(cliPid > 0, "旧轮 fake CLI 应已启动");

  // 另一会话在旧轮执行期间提交：必须排队到旧执行静止后才允许派发。
  const second = (await harness.client(
    "run.start",
    {
      workspaceSlug: "main",
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-timeout-overlap-new",
      backend: "codebuddy",
      waitMs: 25_000,
    },
    30_000,
  )) as Record<string, unknown>;
  const old = (await harness.client("run.get", { runId: firstRunId })) as Record<string, unknown>;

  const bytesAtNextTerminal = readFileSync(marker).length;
  const cliAliveWhenNextFinished = isAlive(cliPid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bytesAfter300ms = readFileSync(marker).length;

  assert.equal(old["state"], "unknown", `超时的旧轮必须 unknown：${JSON.stringify(old)}`);
  assert.equal(second["state"], "completed", `下一轮应正常完成：${JSON.stringify(second)}`);
  assert.equal(cliAliveWhenNextFinished, false, "下一轮完成时旧 fake CLI 必须已停止（不得重叠执行）");
  assert.equal(bytesAfter300ms, bytesAtNextTerminal, "下一轮进入终态后旧轮不得继续执行");
});

test("P2：SDK worker 异常退出后 worker_processes 不得保持 active，run 收敛 unknown", async () => {
  const harness = await startDaemon({
    scenario: "text-happy",
    sdkBackends: { codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE } },
  });
  harnesses.push(harness);

  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:stuck",
    clientRequestId: "oc09-p2-worker-crash",
    backend: "codebuddy",
    waitMs: 1,
  })) as Record<string, unknown>;
  const runId = started["runId"] as string;
  const dbPath = join(harness.dataRoot, "data", "opencode-bridge.sqlite");

  const readWorker = (): { pid: number; status: string } | null => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT pid, status FROM worker_processes WHERE backend_id = 'codebuddy' ORDER BY server_epoch DESC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      return row === undefined ? null : { pid: Number(row["pid"]), status: String(row["status"]) };
    } finally {
      db.close();
    }
  };

  const active = await harness.waitFor(
    "SDK worker 记录为 active",
    async () => {
      const worker = readWorker();
      return worker !== null && worker.status === "active" ? worker : null;
    },
    15_000,
  );
  process.kill(active.pid, "SIGKILL");

  const settledStatus = await harness.waitFor(
    "worker 状态离开 active",
    async () => {
      const worker = readWorker();
      return worker !== null && worker.status !== "active" ? worker.status : null;
    },
    10_000,
  );
  assert.notEqual(settledStatus, "active", "异常退出的 worker 不得长期保持 active");

  const terminal = await harness.waitFor(
    "run 收敛为终态",
    async () => {
      const run = (await harness.client("run.get", { runId })) as Record<string, unknown>;
      const state = String(run["state"]);
      return ["completed", "failed", "cancelled", "interrupted", "unknown"].includes(state) ? state : null;
    },
    10_000,
  );
  assert.equal(terminal, "unknown", "worker 异常退出后 run 必须是 unknown，不能报成功");
});
