import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BridgeStore } from "../../src/storage/index.ts";
import {
  SESSION_ID,
  T0,
  T1,
  T2,
  T3,
  admit,
  bootstrap,
  makeTempDb,
} from "../helpers/storage-fixture.ts";

const childFixture = fileURLToPath(new URL("../fixtures/oc02-crash-child.ts", import.meta.url));

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待文件超时: ${path}`);
    await delay(25);
  }
}

test("真实子进程强退后：恢复为 unknown、阻塞 session、不重发", async () => {
  const temp = makeTempDb("oc02-crash-");
  const readyPath = join(temp.dir, "ready");
  const sentPath = join(temp.dir, "sent.log");
  let stderr = "";
  const child = spawn(process.execPath, [childFixture, temp.path, readyPath, sentPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let store: BridgeStore | null = null;
  try {
    await waitForFile(readyPath, 15_000).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}\n子进程 stderr:\n${stderr}`);
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(child.signalCode, "SIGKILL");

    const before = readFileSync(sentPath, "utf8").trim();
    assert.equal(before.split("\n").length, 1, "只发生一次外部写出");

    store = BridgeStore.open(temp.path);
    const active = store.runs.listNonTerminal();
    assert.equal(active.length, 1);
    const run = active[0];
    assert.ok(run !== undefined);
    const intent = store.dispatches.findByRun(run.runId);
    assert.equal(intent?.phase, "possibly_sent", "崩溃前只落库了“可能已发出”");
    const sessionBefore = store.sessions.require(SESSION_ID);
    assert.equal(sessionBefore.state, "busy");
    assert.equal(sessionBefore.recoveryVerification, "unverified");

    const report = store.recoverPendingRuns(T3);
    assert.equal(report.descendantsConfirmedStopped, false);
    assert.equal(report.runs.length, 1);
    const recovered = report.runs[0];
    assert.ok(recovered !== undefined);
    assert.equal(recovered.disposition, "possibly_executed");
    assert.equal(recovered.stateAfter, "unknown");
    assert.equal(recovered.blocked, true);
    assert.equal(recovered.serverEpoch, intent?.serverEpoch);
    assert.equal(recovered.backendSessionId, "oc-backend-1");

    const runAfter = store.runs.require(run.runId);
    assert.equal(runAfter.state, "unknown");
    const sessionAfter = store.sessions.require(SESSION_ID);
    assert.equal(sessionAfter.blockedReason, "unknown_outcome");
    assert.equal(sessionAfter.recoveryVerification, "unverified", "数据库恢复不等于后端恢复验证");
    assert.equal(store.dispatches.count(), 1, "恢复不新建发送意图");
    assert.equal(readFileSync(sentPath, "utf8").trim(), before, "恢复不重发外部请求");

    store.close();
    store = BridgeStore.open(temp.path);
    const reopened = store.sessions.require(SESSION_ID);
    assert.equal(reopened.blockedReason, "unknown_outcome");
    assert.equal(store.runs.require(run.runId).state, "unknown");
  } finally {
    store?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    temp.cleanup();
  }
});

test("已确认消息但未收尾：恢复仍是 unknown，不能报成功", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "confirmed-1" });
    const prepared = store.prepareDispatch({
      runId: admitted.run.runId,
      backendSessionId: "oc-backend-1",
      serverEpoch: fixture.serverEpoch,
      at: T1,
    });
    store.markDispatchSent(prepared.intent.attemptId, { at: T2, backendMessageId: "msg-1" });
    store.markDispatchConfirmed(prepared.intent.attemptId, { at: T2, backendMessageId: "msg-1" });

    const report = store.recoverPendingRuns(T3);
    const recovered = report.runs[0];
    assert.ok(recovered !== undefined);
    assert.equal(recovered.disposition, "confirmed_but_unsettled");
    assert.equal(recovered.stateAfter, "unknown");
    assert.equal(recovered.backendMessageId, "msg-1");
    assert.equal(recovered.blocked, true);
    assert.ok(recovered.notes.some((note) => note.includes("不能凭消息存在报成功")));
    assert.equal(store.runs.require(admitted.run.runId).state, "unknown");
    assert.equal(store.dispatches.require(prepared.intent.attemptId).phase, "confirmed");
  } finally {
    store.close();
  }
});

test("从未派发的活跃 run：恢复为 cancelled/interrupted，不产生 unknown 阻塞", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "never-1" });
    const report = store.recoverPendingRuns(T3);
    const recovered = report.runs[0];
    assert.ok(recovered !== undefined);
    assert.equal(recovered.disposition, "never_dispatched");
    assert.equal(recovered.stateAfter, "cancelled");
    assert.equal(recovered.blocked, false);
    assert.equal(store.runs.require(admitted.run.runId).state, "cancelled");
    assert.equal(store.sessions.require(SESSION_ID).state, "idle");
    assert.equal(store.dispatches.count(), 0);
    assert.equal(report.pendingVerifications.length, 0);

    // 未派发被清理后，同一会话可以受理新任务。
    const next = admit(store, fixture, { clientRequestId: "never-2" });
    assert.equal(next.run.state, "queued");
  } finally {
    store.close();
  }
});

test("恢复基于当前状态：并发完成的 run 不会被旧快照改写", () => {
  const temp = makeTempDb("oc02-recover-race-");
  let a: BridgeStore | null = null;
  let b: BridgeStore | null = null;
  try {
    a = BridgeStore.open(temp.path, { now: () => T0 });
    const fixture = bootstrap(a);
    const run = admit(a, fixture, { clientRequestId: "race-1" }).run;
    a.transitionRun(run.runId, "starting", { at: T1 });
    a.transitionRun(run.runId, "running", { at: T1 });
    a.transitionRun(run.runId, "draining", { at: T1 });

    b = BridgeStore.open(temp.path, { now: () => T2 });
    const original = a.runs.listNonTerminal.bind(a.runs);
    let injected = false;
    a.runs.listNonTerminal = () => {
      const list = original();
      if (!injected) {
        injected = true;
        b?.completeRunWithResult(run.runId, { agentReported: [{ text: "done" }] }, { at: T2 });
        b?.pruneEvents(run.runId, 5);
      }
      return list;
    };

    const report = a.recoverPendingRuns(T3);
    a.runs.listNonTerminal = original;
    assert.equal(a.runs.require(run.runId).state, "completed");
    assert.equal(a.getResultManifest(run.runId).agentReported[0], "done");
    assert.equal(report.runs.length, 0, "已完成的 run 不再出现在恢复报告里");
  } finally {
    b?.close();
    a?.close();
    temp.cleanup();
  }
});

test("readEvents 的事件、revision 与 state 来自同一读快照", () => {
  const temp = makeTempDb("oc02-page-snapshot-");
  let a: BridgeStore | null = null;
  let b: BridgeStore | null = null;
  try {
    a = BridgeStore.open(temp.path, { now: () => T0 });
    const fixture = bootstrap(a);
    const run = admit(a, fixture, { clientRequestId: "page-1" }).run;
    b = BridgeStore.open(temp.path, { now: () => T0 });

    const original = a.runs.require.bind(a.runs);
    let injected = false;
    a.runs.require = (runId) => {
      const loaded = original(runId);
      if (!injected) {
        injected = true;
        b?.transitionRun(runId, "starting", { at: T1 });
      }
      return loaded;
    };

    const page = a.readEvents(run.runId);
    a.runs.require = original;
    assert.equal(page.snapshotRevision, 1);
    assert.equal(page.runState, "queued");
    assert.deepEqual(
      page.events.map((event) => event.seq),
      [1],
      "同一页不能混入读取期间新提交的事件",
    );

    const fresh = a.readEvents(run.runId);
    assert.equal(fresh.snapshotRevision, 2);
    assert.equal(fresh.runState, "starting");
    assert.deepEqual(
      fresh.events.map((event) => event.seq),
      [1, 2],
    );
  } finally {
    b?.close();
    a?.close();
    temp.cleanup();
  }
});
