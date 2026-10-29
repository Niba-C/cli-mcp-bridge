/** 取消回执返回后立即关停 daemon，必须等 adapter 释放 active 并回收 worker。 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanupHarness, startDaemon } from "../helpers/oc04-harness.ts";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("OC-05 cancel 回执后立即停止 daemon 不遗留独占 worker", async (t) => {
  const harness = await startDaemon({ scenario: "deadline-stall", runTimeoutMs: 120_000 });
  let pids: number[] = [];
  t.after(async () => {
    await harness.shutdown();
    // 失败时也只清理这次夹具登记的进程。
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGTERM");
    cleanupHarness(harness);
  });
  const readWorkerPids = (): number[] => {
    const db = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT pid FROM worker_processes").all().map((row) => Number(row["pid"])); }
    finally { db.close(); }
  };
  const accepted = await harness.client<{ runId: string }>("run.start", {
    workspaceSlug: "main", prompt: "cancel cleanup fixture", clientRequestId: "oc05-cancel-cleanup",
  });
  pids = await harness.waitFor("worker 已登记", async () => {
    const found = readWorkerPids(); return found.length > 0 ? found : null;
  });
  // 等夹具的用户消息落地；无后续文本，revision 此后保持稳定。
  await new Promise((resolve) => setTimeout(resolve, 700));
  const before = await harness.client<{ revision: number }>("run.get", { runId: accepted.runId });
  const status = await harness.client<{ serviceEpoch: number }>("ping");
  const cancelled = await harness.client<{ confirmed: boolean; state: string }>("run.cancel", {
    runId: accepted.runId, clientRequestId: "oc05-cancel-cleanup-stop",
    expectedRevision: before.revision, serviceEpoch: status.serviceEpoch,
  });
  assert.equal(cancelled.confirmed, true);
  assert.equal(cancelled.state, "cancelled");
  harness.daemon.kill("SIGTERM");
  await harness.waitExit();
  assert.deepEqual(pids.filter(isAlive), [], "daemon 退出后 worker 仍存活");
});
