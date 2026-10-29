import assert from "node:assert/strict";
import { test } from "node:test";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import { admit, bootstrap, driveToDraining, T1, T2, T3 } from "../helpers/storage-fixture.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ZBridgeError && error.code === code);
}

test("事件从 1 开始，seq === revision，与 run 水位同步", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture);
    const page = store.readEvents(admitted.run.runId);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.seq, 1);
    assert.equal(page.events[0]?.revision, 1);
    assert.equal(page.events[0]?.type, "run.queued");
    assert.equal(page.snapshotRevision, 1);
    assert.equal(page.earliestSeq, 1);

    store.transitionRun(admitted.run.runId, "starting", { at: T1 });
    const after = store.readEvents(admitted.run.runId);
    assert.deepEqual(
      after.events.map((event) => [event.seq, event.revision, event.type]),
      [
        [1, 1, "run.queued"],
        [2, 2, "run.started"],
      ],
    );
    assert.equal(store.runs.require(admitted.run.runId).revision, 2);
  } finally {
    store.close();
  }
});

test("正常完成经过 draining，状态、事件和结果清单同事务落库", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture);
    driveToDraining(store, admitted.run.runId, T2);
    const completed = store.completeRunWithResult(
      admitted.run.runId,
      {
        agentReported: [{ text: "已阅读入口文件" }],
        observed: [{ text: "src/ 下存在 storage 目录" }],
      },
      { at: T3 },
    );
    assert.equal(completed.run.state, "completed");
    assert.equal(completed.run.revision, 5);
    assert.equal(completed.run.lastEventSeq, 5);
    assert.equal(completed.manifest.verified, false, "没有 verification 条目就不能声称已验证");

    const page = store.readEvents(admitted.run.runId);
    assert.deepEqual(
      page.events.map((event) => event.type),
      ["run.queued", "run.started", "run.state", "run.draining", "run.terminal"],
    );
    assert.ok(page.events.every((event) => event.seq === event.revision));
    assert.equal(page.events.at(-1)?.payload["resultManifestId"], completed.manifest.manifestId);

    const session = store.sessions.require(fixture.session.sessionId);
    assert.equal(session.state, "idle");
    assert.equal(store.getRunSnapshot(admitted.run.runId).resultReady, true);
  } finally {
    store.close();
  }
});

test("completed 不能跳过 draining；终态不可改写", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture);
    store.transitionRun(admitted.run.runId, "starting", { at: T1 });
    store.transitionRun(admitted.run.runId, "running", { at: T1 });

    const direct = store.transitionRun(admitted.run.runId, "completed", { at: T2 });
    assert.equal(direct.accepted, false);
    assert.equal(direct.reason, "illegal_transition");
    assert.equal(direct.run.state, "running");
    assert.equal(store.readEvents(admitted.run.runId).events.length, 3);

    expectCode(
      () => store.completeRunWithResult(admitted.run.runId, { agentReported: [{ text: "done" }] }, { at: T2 }),
      "INVALID_ARGUMENT",
    );

    store.transitionRun(admitted.run.runId, "draining", { at: T2 });
    store.completeRunWithResult(admitted.run.runId, {}, { at: T3 });
    const immutable = store.transitionRun(admitted.run.runId, "cancelled", { at: T3 });
    assert.equal(immutable.accepted, false);
    assert.equal(immutable.reason, "terminal_immutable");
    assert.equal(store.runs.require(admitted.run.runId).state, "completed");
  } finally {
    store.close();
  }
});

test("通用 transitionRun 不能绕过结果清单直接 completed", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture);
    driveToDraining(store, admitted.run.runId, T2);
    const beforeEvents = store.readEvents(admitted.run.runId).events.length;

    const bypass = store.transitionRun(admitted.run.runId, "completed", { at: T3 });
    assert.equal(bypass.accepted, false);
    assert.equal(bypass.reason, "illegal_transition");
    assert.equal(bypass.event, null);
    assert.equal(store.runs.require(admitted.run.runId).state, "draining");
    assert.equal(store.getRunSnapshot(admitted.run.runId).resultReady, false);
    assert.equal(store.readEvents(admitted.run.runId).events.length, beforeEvents);

    const completed = store.completeRunWithResult(admitted.run.runId, {}, { at: T3 });
    assert.equal(completed.run.state, "completed");
    assert.equal(store.getRunSnapshot(admitted.run.runId).resultReady, true);
  } finally {
    store.close();
  }
});

test("事件分页、earliestSeq 与过期游标", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture);
    store.transitionRun(admitted.run.runId, "starting", { at: T1 });
    store.transitionRun(admitted.run.runId, "running", { at: T1 });

    const firstPage = store.readEvents(admitted.run.runId, { afterSeq: 0, limit: 2 });
    assert.deepEqual(
      firstPage.events.map((event) => event.seq),
      [1, 2],
    );
    assert.equal(firstPage.nextSeq, 2);
    assert.equal(firstPage.hasMore, true);

    const secondPage = store.readEvents(admitted.run.runId, { afterSeq: firstPage.nextSeq, limit: 2 });
    assert.deepEqual(
      secondPage.events.map((event) => event.seq),
      [3],
    );
    assert.equal(secondPage.hasMore, false);

    expectCode(
      () => store.readEvents(admitted.run.runId, { afterSeq: 99 }),
      "REVISION_CONFLICT",
    );

    const deleted = store.pruneEvents(admitted.run.runId, 2);
    assert.equal(deleted, 2);
    expectCode(
      () => store.readEvents(admitted.run.runId, { afterSeq: 0 }),
      "CURSOR_EXPIRED",
    );
    const resumed = store.readEvents(admitted.run.runId, { afterSeq: 2 });
    assert.equal(resumed.earliestSeq, 3);
    assert.deepEqual(
      resumed.events.map((event) => event.seq),
      [3],
    );

    // 读取不产生后端派发、回执或新 run。
    assert.equal(store.dispatches.count(), 0);
    assert.equal(store.receipts.count(), 1);
    assert.equal(store.runs.countAll(), 1);
  } finally {
    store.close();
  }
});
