import assert from "node:assert/strict";
import { test } from "node:test";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import { newId } from "../../src/contracts/ids.ts";
import type { SessionRecord } from "../../src/storage/index.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import {
  OTHER_PRINCIPAL,
  PRINCIPAL,
  SESSION_B_ID,
  T1,
  T2,
  admit,
  bootstrap,
  makeTempDb,
  uuid,
} from "../helpers/storage-fixture.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ZBridgeError && error.code === code);
}

function addSession(
  store: BridgeStore,
  fixture: ReturnType<typeof bootstrap>,
  sessionId = SESSION_B_ID,
  ownerId = PRINCIPAL.principalId,
): SessionRecord {
  const created = store.createSession({
    sessionId,
    ownerId,
    workspaceId: fixture.workspaceId,
    profile: "review",
    at: T1,
  });
  return store.bindSessionBackend(created.sessionId, `oc-backend-${created.sessionId.slice(-6)}`, fixture.serverEpoch, T1);
}

test("同 key 同参数返回原 run，不再建 run 或事件", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "same-1" });
    const second = admit(store, fixture, { clientRequestId: "same-1" });
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.run.runId, first.run.runId);
    assert.equal(store.runs.countAll(), 1);
    assert.equal(store.receipts.count(), 1);
    assert.equal(store.readEvents(first.run.runId).events.length, 1);
    assert.equal(store.sessions.require(fixture.session.sessionId).state, "busy");
  } finally {
    store.close();
  }
});

test("同 key 不同参数报 IDEMPOTENCY_CONFLICT", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "conflict-1" });
    expectCode(
      () => admit(store, fixture, { clientRequestId: "conflict-1", prompt: "另一个任务" }),
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(store.runs.countAll(), 1);
    assert.equal(store.receipts.count(), 1);
    assert.equal(store.runs.require(first.run.runId).state, "queued");
  } finally {
    store.close();
  }
});

test("deadlineAt 参与参数哈希：同 key 改期限报冲突", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "deadline-1" });
    expectCode(
      () =>
        admit(store, fixture, {
          clientRequestId: "deadline-1",
          deadlineAt: "2026-01-01T00:30:00.000Z",
        }),
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(store.runs.countAll(), 1);
    assert.equal(store.runs.require(first.run.runId).deadlineAt, "2026-01-01T00:15:00.000Z");
  } finally {
    store.close();
  }
});

test("回执重试保留身份与 workspace 访问检查，但不重做 closed/busy", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "auth-retry-1" });
    // 会话关闭后，同 key 重试仍应返回原回执（幂等优先于占用/关闭检查）。
    store.sessions.setState(fixture.session.sessionId, "closed", T2);
    const retry = admit(store, fixture, { clientRequestId: "auth-retry-1" });
    assert.equal(retry.reused, true);
    assert.equal(retry.run.runId, first.run.runId);

    // 当前主体被撤销 workspace 权限时，不能因为命中回执就绕过资源检查。
    expectCode(
      () =>
        admit(store, fixture, {
          principal: { ...fixture.principal, allowedWorkspaces: [] },
          clientRequestId: "auth-retry-1",
        }),
      "NOT_FOUND",
    );
    assert.equal(store.runs.countAll(), 1);
  } finally {
    store.close();
  }
});

test("回执按主体和工具名分作用域", () => {
  const store = BridgeStore.openMemory();
  try {
    // 同一 workspace、两个主体，各有自己的 session。
    const otherFixture = bootstrap(store, { ownerId: OTHER_PRINCIPAL.principalId });
    const principalSession = addSession(store, otherFixture, newId("session", uuid(31)), PRINCIPAL.principalId);

    const otherRun = admit(store, otherFixture, {
      principal: OTHER_PRINCIPAL,
      sessionId: otherFixture.session.sessionId,
      clientRequestId: "scope-1",
    });
    const ownRun = admit(store, otherFixture, {
      principal: PRINCIPAL,
      sessionId: principalSession.sessionId,
      clientRequestId: "scope-1",
    });
    assert.notEqual(ownRun.run.runId, otherRun.run.runId);
    assert.equal(store.receipts.count(), 2);

    // 另一主体不能借用别人的 session。
    expectCode(
      () =>
        admit(store, otherFixture, {
          principal: PRINCIPAL,
          sessionId: otherFixture.session.sessionId,
          clientRequestId: "scope-2",
        }),
      "NOT_FOUND",
    );

    // 同主体、同 clientRequestId，不同工具 → 独立作用域。
    const otherTool = addSession(store, otherFixture, newId("session", uuid(32)), PRINCIPAL.principalId);
    const toolRun = admit(store, otherFixture, {
      principal: PRINCIPAL,
      sessionId: otherTool.sessionId,
      clientRequestId: "scope-1",
      toolName: "agent_continue",
    });
    assert.notEqual(toolRun.run.runId, ownRun.run.runId);
    assert.equal(store.receipts.count(), 3);
  } finally {
    store.close();
  }
});

test("旧 epoch 同 key 重试返回原回执；旧 epoch 新请求拒绝执行", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "epoch-1" });
    const newer = store.beginService({ at: T1 });
    assert.equal(newer.serviceEpoch, fixture.serviceEpoch + 1);

    const retry = admit(store, fixture, { clientRequestId: "epoch-1" });
    assert.equal(retry.reused, true);
    assert.equal(retry.run.runId, first.run.runId);
    assert.equal(store.runs.countAll(), 1);

    expectCode(
      () => admit(store, fixture, { clientRequestId: "epoch-new", serviceEpoch: fixture.serviceEpoch }),
      "EPOCH_MISMATCH",
    );
    assert.equal(store.runs.countAll(), 1);
  } finally {
    store.close();
  }
});

test("忙碌、关闭、generation 变化与 profile 变化都拒绝受理", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    admit(store, fixture, { clientRequestId: "busy-1" });
    expectCode(() => admit(store, fixture, { clientRequestId: "busy-2" }), "SESSION_BUSY");

    store.sessions.setState(fixture.session.sessionId, "closed", T2);
    expectCode(() => admit(store, fixture, { clientRequestId: "closed-1" }), "SESSION_CLOSED");
  } finally {
    store.close();
  }

  const store2 = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store2);
    expectCode(
      () => admit(store2, fixture, { clientRequestId: "profile-1", profile: "edit" }),
      "PROFILE_NOT_ALLOWED",
    );
    store2.workspaces.updateGeneration(fixture.workspaceId, 2, T2);
    expectCode(() => admit(store2, fixture, { clientRequestId: "gen-1" }), "POLICY_REVOKED");
  } finally {
    store2.close();
  }
});

test("unknown 阻塞持久化：重开后仍拒绝新任务，直到本地核对解除", () => {
  const temp = makeTempDb();
  let store = BridgeStore.open(temp.path);
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "unknown-1" });
    const prepared = store.prepareDispatch({
      runId: admitted.run.runId,
      backendSessionId: "oc-backend-1",
      serverEpoch: fixture.serverEpoch,
      at: T1,
    });
    store.recordDispatchUnknown(prepared.intent.attemptId, {
      at: T2,
      detail: "HTTP 请求超时，无法判断是否已写入",
    });
    assert.equal(store.runs.require(admitted.run.runId).state, "unknown");
    const blocked = store.sessions.require(fixture.session.sessionId);
    assert.equal(blocked.blockedReason, "unknown_outcome");
    store.close();

    store = BridgeStore.open(temp.path);
    const afterReopen = store.sessions.require(fixture.session.sessionId);
    assert.equal(afterReopen.state, "unavailable");
    assert.equal(afterReopen.blockedReason, "unknown_outcome");
    assert.throws(
      () => admit(store, fixture, { clientRequestId: "unknown-2" }),
      (error: unknown) =>
        error instanceof ZBridgeError &&
        error.code === "SESSION_BUSY" &&
        error.details?.["reason"] === "unknown_outcome",
    );

    const released = store.releaseSessionBlock(fixture.session.sessionId, T2);
    assert.equal(released.blockedReason, null);
    assert.equal(released.recoveryVerification, "unverified", "解除阻塞不等于后端恢复已验证");
    const next = admit(store, fixture, { clientRequestId: "unknown-3" });
    assert.equal(next.run.state, "queued");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("serviceEpoch 与 serverEpoch 分开分配，重启不重复", () => {
  const temp = makeTempDb();
  let store = BridgeStore.open(temp.path);
  try {
    const firstService = store.beginService({ at: T1 });
    const server1 = store.beginServerInstance({ serviceEpoch: firstService.serviceEpoch, at: T1 });
    const server2 = store.beginServerInstance({ serviceEpoch: firstService.serviceEpoch, at: T1 });
    const secondService = store.beginService({ at: T1 });
    const server3 = store.beginServerInstance({ serviceEpoch: secondService.serviceEpoch, at: T1 });
    assert.deepEqual(
      [firstService.serviceEpoch, secondService.serviceEpoch],
      [1, 2],
    );
    assert.deepEqual(
      [server1.serverEpoch, server2.serverEpoch, server3.serverEpoch],
      [1, 2, 3],
    );
    store.close();

    store = BridgeStore.open(temp.path);
    const thirdService = store.beginService({ at: T1 });
    const server4 = store.beginServerInstance({ serviceEpoch: thirdService.serviceEpoch, at: T1 });
    assert.equal(thirdService.serviceEpoch, 3);
    assert.equal(server4.serverEpoch, 4);

    // 绑定必须成对、且 serverEpoch 属于当前活动产品服务。
    const workspace = store.createWorkspace({
      workspaceId: newId("workspace", uuid(41)),
      name: "epoch",
      canonicalRoot: "/tmp/oc02-epoch",
      profiles: ["review"],
      at: T1,
    });
    const session = store.createSession({
      sessionId: newId("session", uuid(42)),
      ownerId: PRINCIPAL.principalId,
      workspaceId: workspace.workspaceId,
      profile: "review",
      at: T1,
    });
    expectCode(() => store.bindSessionBackend(session.sessionId, "oc-x", null, T1), "INVALID_ARGUMENT");
    expectCode(() => store.bindSessionBackend(session.sessionId, null, 1, T1), "INVALID_ARGUMENT");
    expectCode(() => store.bindSessionBackend(session.sessionId, "oc-x", 999, T1), "NOT_FOUND");
    expectCode(
      () => store.bindSessionBackend(session.sessionId, "oc-x", server1.serverEpoch, T1),
      "EPOCH_MISMATCH",
    );
    const bound = store.bindSessionBackend(session.sessionId, "oc-x", server4.serverEpoch, T1);
    assert.equal(bound.serverEpoch, server4.serverEpoch);
  } finally {
    store.close();
    temp.cleanup();
  }
});
