import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupHarness, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";
import { readRequests } from "../helpers/oc03-harness.ts";

let harness: DaemonHarness;
let startedAtMs = Date.now();

before(async () => {
  // 服务先死（2.5s 自杀）+ 逃逸子进程 8s 后写 marker；daemon 在窗口内被 SIGKILL。
  harness = await startDaemon({
    scenario: "daemon-crash-service-first",
    runTimeoutMs: 30_000,
  });
});

after(async () => {
  await harness.shutdown().catch(() => undefined);
  cleanupHarness(harness);
});

/** 只读打开业务库，轮询 worker 后代记录（daemon 持有写连接；WAL 允许并发读）。 */
async function waitForRecordedDescendant(minCount: number): Promise<readonly { pid: number; identity: string | null }[]> {
  const { BridgeStore } = await import("../../src/storage/index.ts");
  const deadline = Date.now() + 15_000;
  for (;;) {
    let rows: readonly { pid: number; identity: string | null }[] = [];
    try {
      const store = BridgeStore.open(join(harness.dataRoot, "data", "opencode-bridge.sqlite"));
      try {
        const active = store.listWorkersByStatus("active");
        rows = active[0]?.descendants ?? [];
      } finally {
        store.close();
      }
    } catch {
      // 读不到就继续等。
    }
    if (rows.length >= minCount) return rows;
    if (Date.now() > deadline) throw new Error(`后代身份未被周期落库（期望 ≥${minCount}）`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
}

test("服务先死+daemon 再死：周期落库的后代身份让重启后能逐个安全回收逃逸进程", async () => {
  startedAtMs = Date.now();
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "服务先死恢复验证",
    clientRequestId: "req-service-first-1",
  })) as { runId: string };

  // 等逃逸子进程被派生（服务尚存活，ppid 归属可见）。
  await harness.waitFor(
    "逃逸子进程被派生",
    async () => (readFileSync(harness.paths.backendLog, "utf8").includes("child_spawned") ? true : null),
    15_000,
  );
  // 等周期观测把它的身份落库（必须在服务 2.5s 自杀前完成）。
  await waitForRecordedDescendant(1);
  const copyRoot = join(harness.dataRoot, "workspaces", "main-g1");
  const marker = join(copyRoot, "oc04-escaped-marker.txt");

  // 让服务先走完自杀时刻（2.5s），再杀 daemon：覆盖「服务先死/daemon 再死」顺序。
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < 2_700) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_700 - elapsed));
  }
  harness.daemon.kill("SIGKILL");
  await harness.waitExit(10_000);
  assert.equal(existsSync(marker), false, "逃逸子进程尚未写 marker（8s 窗口）");

  const promptsBefore = readRequests(harness.paths.backendLog).filter(
    (entry) => typeof entry["route"] === "string" && (entry["route"] as string).includes("prompt_async"),
  ).length;
  assert.equal(promptsBefore, 1, "崩溃前恰有一次派发");

  // 重启 daemon（同 dataRoot；恢复后用 text-happy 验证 session 续接）。
  await harness.respawn(30_000, "text-happy");

  // 恢复报告：worker 已死，但记录的后代（逃逸子进程）身份核对一致 → 逐个回收并确认。
  const status = (await harness.status()) as {
    lastRecovery: { workers: Array<{ verdict: string; attempted: boolean; confirmedStopped: boolean; detail: string }> };
  };
  assert.equal(status.lastRecovery.workers.length >= 1, true, "必须有遗留 worker 记录");
  const worker = status.lastRecovery.workers[0];
  assert.ok(worker !== undefined);
  assert.equal(worker.attempted, true, `应对已记录后代补刀: ${JSON.stringify(worker)}`);
  assert.equal(worker.confirmedStopped, true, `记录在案的后代可安全回收: ${JSON.stringify(worker)}`);

  // 逃逸子进程已死：marker 永不出现。
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 8_500));
  assert.equal(existsSync(marker), false, "确认回收后不得再有迟到写入");

  // 原 run：unknown；不重发。
  const snap = (await harness.client("run.get", { runId: started.runId })) as { state: string; sessionId: string };
  assert.equal(snap.state, "unknown", "已派发但未收尾的 run 必须是 unknown");
  const promptsAfter = readRequests(harness.paths.backendLog).filter(
    (entry) => typeof entry["route"] === "string" && (entry["route"] as string).includes("prompt_async"),
  ).length;
  assert.equal(promptsAfter, 1, "重启后的日志只有新任务的派发；旧 run 若被重发会计数为 2");

  // 同一产品 session 重启后**加载**旧 backendSessionId 续接（不静默换空会话）。
  await harness.operator("session.release", { sessionId: snap.sessionId, note: "恢复核对完成" });
  const resumed = (await harness.client("run.start", {
    sessionId: snap.sessionId,
    prompt: "只回复 READY",
    clientRequestId: "req-service-first-2",
    waitMs: 15_000,
  })) as { runId: string; state: string };
  assert.equal(resumed.state, "completed");
  const newLogRequests = readRequests(harness.paths.backendLog);
  assert.equal(
    newLogRequests.some((entry) => entry["route"] === "POST /session"),
    false,
    "续接必须 load 旧后端会话，不得新建 POST /session",
  );
  assert.equal(
    newLogRequests.some((entry) => typeof entry["route"] === "string" && (entry["route"] as string).includes("GET /session/")),
    true,
    "应有 GET /session/{id} 的加载核对",
  );
});

test("PID 复用（身份不符）：恢复绝不发信号；run 保持 unknown", async () => {
  // 先优雅停止当前 daemon（其 worker 记录会被标 stopped）。
  await harness.shutdown();
  cleanupHarness(harness);

  const base = await startDaemon({ scenario: "text-happy", runTimeoutMs: 30_000 });
  try {
    const { spawn } = await import("node:child_process");
    const { BridgeStore } = await import("../../src/storage/index.ts");
    const { processIdentity } = await import("../../src/daemon/lock.ts");

    const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    const sleeperPid = sleeper.pid ?? 0;
    assert.ok(sleeperPid > 0);
    try {
      await base.shutdown();

      const store = BridgeStore.open(join(base.dataRoot, "data", "opencode-bridge.sqlite"));
      // daemon 已停止：分配新的服务代际，再种一条「PID 活着但身份不符」的 worker 行。
      const service = store.beginService({ at: new Date().toISOString() });
      const server = store.beginServerInstance({ serviceEpoch: service.serviceEpoch, runDir: null });
      store.recordWorkerStart({
        serverEpoch: server.serverEpoch,
        serviceEpoch: service.serviceEpoch,
        pid: sleeperPid,
        pgid: sleeperPid,
        processIdentity: "WRONG-OLD-IDENTITY",
        executable: "/bin/sleep",
        runDir: "/nonexistent",
      });
      store.close();

      // 重启：恢复核对身份 → pid_reused → 不发信号。
      await base.respawn();
      const status = (await base.status()) as {
        lastRecovery: { workers: Array<{ verdict: string; attempted: boolean; confirmedStopped: boolean }> };
      };
      const seeded = status.lastRecovery.workers.find((entry) => entry.verdict !== undefined);
      assert.ok(seeded !== undefined, "种下的 worker 记录必须出现在恢复报告里");
      assert.equal(seeded.verdict, "pid_reused");
      assert.equal(seeded.attempted, false, "身份不符时不得发任何信号");
      assert.equal(seeded.confirmedStopped, false, "不能为「看起来像中断」而谎称已确认停止");

      // 复用该 PID 的无关进程必须毫发无损。
      assert.equal(processIdentity(sleeperPid) !== null, true, "PID 复用者不得被误杀");
    } finally {
      try {
        process.kill(sleeperPid, "SIGKILL");
      } catch {
        // 已退出。
      }
    }
  } finally {
    await base.shutdown().catch(() => undefined);
    cleanupHarness(base);
  }
});
