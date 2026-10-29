import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeStore } from "../../src/storage/index.ts";
import { DaemonApprovalQueue } from "../../src/daemon/approvals.ts";
import type { BackendApprovalRequest } from "../../src/contracts/backend.ts";
import type { Approval } from "../../src/contracts/index.ts";

const T0 = "2026-10-23T00:00:00.000Z";
const T_EXP = "2026-10-23T00:05:00.000Z";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "ws_00000000-0000-4000-8000-000000000002";
const SESSION_ID = "ses_00000000-0000-4000-8000-000000000003";
const RUN_ID = "run_00000000-0000-4000-8000-000000000004";

interface World {
  readonly store: BridgeStore;
  readonly queue: DaemonApprovalQueue;
  readonly approval: Approval;
}

function setup(): World {
  const store = BridgeStore.openMemory({ now: () => T0 });
  store.beginService({ at: T0 });
  store.beginServerInstance({ serviceEpoch: 1, at: T0 });
  store.createWorkspace({ workspaceId: WORKSPACE_ID as never, name: "main", canonicalRoot: "/tmp/oc04-approvals", profiles: ["review"], at: T0 });
  store.createSession({ sessionId: SESSION_ID as never, ownerId: PRINCIPAL_ID as never, workspaceId: WORKSPACE_ID as never, profile: "review", at: T0 });
  store.bindSessionBackend(SESSION_ID as never, "oc-backend-1", 1, T0);
  store.runs.insert({
    runId: RUN_ID as never,
    sessionId: SESSION_ID as never,
    ownerId: PRINCIPAL_ID as never,
    workspaceId: WORKSPACE_ID as never,
    requestId: "req-1",
    requestHash: "sha256:" + "0".repeat(64),
    requestTool: "agent_start",
    profile: "review",
    backendId: "opencode",
    state: "running",
    revision: 2,
    lastEventSeq: 2,
    selectedModel: "minimax/MiniMax-M3.1-Flash",
    deadlineAt: T_EXP,
    createdAt: T0,
    updatedAt: T0,
  });
  store.dispatches.insert({
    attemptId: "att_1",
    runId: RUN_ID as never,
    sessionId: SESSION_ID as never,
    backendSessionId: "oc-backend-1",
    serverEpoch: 1,
    at: T0,
  });
  store.runs.setBackendAttempt(RUN_ID as never, "att_1", T0);
  const approval = store.createApproval({
    runId: RUN_ID as never,
    attemptId: "att_1",
    serverEpoch: 1,
    requestKind: "tool_permission",
    toolName: "bash",
    toolCallId: "call_1",
    argumentsText: "sh ./work.sh",
    targetPaths: [],
    payloadHash: "sha256:" + "a".repeat(64),
    policyVersion: "oc04-controlled-v1",
    expiresAt: T_EXP,
    at: T0,
  });
  const queue = new DaemonApprovalQueue(store);
  return { store, queue, approval };
}

test("decide 携带正确上下文且等待者存在：成功落库并唤醒（阳性对照）", async () => {
  const world = setup();
  try {
    // 与 coordinator 相同的接线顺序：审批落库后先登记映射，再挂起等待。
    world.queue.approvalRecorded(world.approval, makeRequest(world.approval));
    const waiting = world.queue.waitForDecision(makeRequest(world.approval));
    const decided = world.queue.decide({
      approvalId: world.approval.approvalId,
      decision: "allow_once",
      payloadHash: world.approval.summary.payloadHash,
      serverEpoch: 1,
      attemptId: "att_1",
    });
    assert.equal(decided.state, "approved");
    const answer = await waiting;
    assert.deepEqual(answer, { decision: "allow_once", actor: "operator" });
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

test("改参（payloadHash 不符）拒绝并作废；旧许可不能复用", async () => {
  const world = setup();
  try {
    const waiting = world.queue.waitForDecision(makeRequest(world.approval));
    assert.throws(
      () =>
        world.queue.decide({
          approvalId: world.approval.approvalId,
          decision: "allow_once",
          payloadHash: "sha256:" + "b".repeat(64),
          serverEpoch: 1,
          attemptId: "att_1",
        }),
      (error: unknown) => error instanceof Error && error.message.includes("payloadHash"),
    );
    const answer = await waiting;
    // 落库失败路径：等待者拿到 channel_lost，而不是 allow_once。
    assert.deepEqual(answer, { decision: "channel_lost", actor: "channel_lost" });
    assert.equal(world.store.approvals.get(world.approval.approvalId)?.state, "expired");
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

test("换代（serverEpoch 不一致）拒绝；attempt 不一致拒绝（各自独立审批，首次失败即作废）", () => {
  // 首次校验失败就会把审批作废：两个拒绝场景各用一份新 setup，避免互相污染。
  {
    const world = setup();
    try {
      assert.throws(
        () =>
          world.queue.decide({
            approvalId: world.approval.approvalId,
            decision: "allow_once",
            payloadHash: world.approval.summary.payloadHash,
            serverEpoch: 2,
            attemptId: "att_1",
          }),
        /serverEpoch/u,
      );
      assert.equal(world.store.approvals.get(world.approval.approvalId)?.state, "expired");
      world.store.close();
    } catch (error) {
      world.store.close();
      throw error;
    }
  }
  {
    const world = setup();
    try {
      assert.throws(
        () =>
          world.queue.decide({
            approvalId: world.approval.approvalId,
            decision: "allow_once",
            payloadHash: world.approval.summary.payloadHash,
            serverEpoch: 1,
            attemptId: "att_2",
          }),
        /attemptId/u,
      );
      assert.equal(world.store.approvals.get(world.approval.approvalId)?.state, "expired");
      world.store.close();
    } catch (error) {
      world.store.close();
      throw error;
    }
  }
});

test("worker 代际已停止：多后端活动实例不会误伤，只有自身失效才拒绝", () => {
  const world = setup();
  try {
    // 另一后端/工作区可以有自己的活动 serverEpoch；决定只看审批绑定的实例。
    const other = world.store.beginServerInstance({ serviceEpoch: 1, backendId: "codebuddy", runDir: null, at: T0 });
    assert.notEqual(other.serverEpoch, 1);
    world.queue.approvalRecorded(world.approval, makeRequest(world.approval));
    const waiting = world.queue.waitForDecision(makeRequest(world.approval));
    world.queue.decide({
      approvalId: world.approval.approvalId,
      decision: "allow_once",
      payloadHash: world.approval.summary.payloadHash,
      serverEpoch: 1,
      attemptId: "att_1",
    });
    void waiting;
    world.store.stopServer(1, T0);
    assert.equal(world.store.approvals.get(world.approval.approvalId)?.state, "approved");

    const stoppedWorld = setup();
    try {
      stoppedWorld.store.stopServer(1, T0);
      stoppedWorld.queue.approvalRecorded(stoppedWorld.approval, makeRequest(stoppedWorld.approval));
      const stoppedWaiting = stoppedWorld.queue.waitForDecision(makeRequest(stoppedWorld.approval));
      assert.throws(
        () =>
          stoppedWorld.queue.decide({
            approvalId: stoppedWorld.approval.approvalId,
            decision: "allow_once",
            payloadHash: stoppedWorld.approval.summary.payloadHash,
            serverEpoch: 1,
            attemptId: "att_1",
          }),
        /代际已失效/u,
      );
      void stoppedWaiting;
      assert.equal(stoppedWorld.store.approvals.get(stoppedWorld.approval.approvalId)?.state, "expired");
    } finally {
      stoppedWorld.store.close();
    }
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

test("run 已终结：旧审批不能复活", () => {
  const world = setup();
  try {
    // running → stopping → cancelled（合法链）。
    world.store.transitionRun(RUN_ID as never, "stopping", { at: T0 });
    world.store.transitionRun(RUN_ID as never, "cancelled", { at: T0 });
    assert.throws(
      () =>
        world.queue.decide({
          approvalId: world.approval.approvalId,
          decision: "allow_once",
          payloadHash: world.approval.summary.payloadHash,
          serverEpoch: 1,
          attemptId: "att_1",
        }),
      /复活|终结/u,
    );
    assert.equal(world.store.approvals.get(world.approval.approvalId)?.state, "expired");
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

test("workspace generation 变化：POLICY_REVOKED 且审批作废", () => {
  const world = setup();
  try {
    world.store.workspaces.updateRegistration(WORKSPACE_ID as never, { generation: 2 }, T0);
    assert.throws(
      () =>
        world.queue.decide({
          approvalId: world.approval.approvalId,
          decision: "allow_once",
          payloadHash: world.approval.summary.payloadHash,
          serverEpoch: 1,
          attemptId: "att_1",
        }),
      /generation/u,
    );
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

test("同一审批二次决定：第二次报不可复用", async () => {
  const world = setup();
  try {
    world.queue.approvalRecorded(world.approval, makeRequest(world.approval));
    const waiting = world.queue.waitForDecision(makeRequest(world.approval));
    world.queue.decide({
      approvalId: world.approval.approvalId,
      decision: "deny",
      payloadHash: world.approval.summary.payloadHash,
      serverEpoch: 1,
      attemptId: "att_1",
    });
    await waiting;
    assert.throws(
      () =>
        world.queue.decide({
          approvalId: world.approval.approvalId,
          decision: "allow_once",
          payloadHash: world.approval.summary.payloadHash,
          serverEpoch: 1,
          attemptId: "att_1",
        }),
      /pending|复用/u,
    );
    world.store.close();
  } catch (error) {
    world.store.close();
    throw error;
  }
});

function makeRequest(approval: Approval): BackendApprovalRequest {
  return {
    requestKind: "tool_permission",
    toolName: approval.summary.toolName,
    toolCallId: approval.summary.toolCallId,
    attemptId: approval.summary.attemptId,
    serverEpoch: approval.summary.serverEpoch,
    backendRequestId: "per_test0001",
    argumentsText: approval.summary.argumentsText,
    targetPaths: approval.summary.targetPaths,
    expiresAt: approval.summary.expiresAt,
  };
}
