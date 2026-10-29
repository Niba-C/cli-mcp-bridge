import assert from "node:assert/strict";
import { test } from "node:test";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import { newId } from "../../src/contracts/ids.ts";
import { payloadHash } from "../../src/contracts/json.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import {
  OTHER_PRINCIPAL,
  PRINCIPAL,
  SESSION_B_ID,
  T1,
  T2,
  T3,
  T4,
  T5,
  admit,
  bootstrap,
  driveToDraining,
  fixedIds,
  uuid,
} from "../helpers/storage-fixture.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ZBridgeError && error.code === code);
}

test("审批只做本地持久化：创建、查询、决策与过期", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "approval-1" });
    const prepared = store.prepareDispatch({
      runId: admitted.run.runId,
      backendSessionId: "oc-backend-1",
      serverEpoch: fixture.serverEpoch,
      at: T1,
    });
    const base = {
      runId: admitted.run.runId,
      attemptId: prepared.intent.attemptId,
      serverEpoch: fixture.serverEpoch,
      requestKind: "tool_permission" as const,
      toolName: "bash",
      argumentsText: "sed -n '1,20p' README.md",
      targetPaths: ["/tmp/oc02-fixture/README.md"],
      payloadHash: payloadHash({ tool: "bash", args: "sed -n '1,20p' README.md" }),
      policyVersion: "oc02-test",
      expiresAt: T5,
      at: T2,
    };
    const approval = store.createApproval({
      ...base,
      approvalId: newId("approval", uuid(51)),
      toolCallId: "call-1",
      repeatCount: 1,
    });
    assert.equal(approval.state, "pending");
    assert.equal(approval.summary.attemptId, prepared.intent.attemptId);
    assert.equal(approval.summary.serverEpoch, fixture.serverEpoch);
    assert.deepEqual(store.listPendingApprovals(admitted.run.runId).map((item) => item.approvalId), [
      approval.approvalId,
    ]);

    expectCode(
      () =>
        store.createApproval({
          ...base,
          toolCallId: "call-epoch",
          serverEpoch: fixture.serverEpoch + 10,
        }),
      "EPOCH_MISMATCH",
    );

    const decided = store.recordLocalApprovalDecision(approval.approvalId, "allow_once", T3);
    assert.equal(decided.state, "approved");
    assert.equal(decided.decisionActor, "operator");
    expectCode(
      () => store.recordLocalApprovalDecision(approval.approvalId, "deny", T3),
      "APPROVAL_DENIED",
    );

    const expiring = store.createApproval({
      ...base,
      approvalId: newId("approval", uuid(52)),
      toolCallId: "call-2",
      expiresAt: T2,
    });
    expectCode(
      () => store.recordLocalApprovalDecision(expiring.approvalId, "allow_once", T4),
      "APPROVAL_EXPIRED",
    );
    const expired = store.approvals.require(expiring.approvalId);
    assert.equal(expired.state, "expired");
    assert.equal(expired.decisionActor, "product_expiry");
  } finally {
    store.close();
  }
});

test("工件元数据持久化并校验 owner，对外 meta 不含内部路径", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "artifact-1" });
    const artifact = store.addArtifact({
      ownerId: PRINCIPAL.principalId,
      runId: admitted.run.runId,
      mediaType: "text/plain",
      sha256: "a".repeat(64),
      bytes: 42,
      internalPath: "/tmp/oc02-fixture/private/result.txt",
      provenance: "verification",
      at: T2,
    });
    assert.equal(store.getArtifact(artifact.artifactId, PRINCIPAL).bytes, 42);
    expectCode(() => store.getArtifact(artifact.artifactId, OTHER_PRINCIPAL), "NOT_FOUND");
    const meta = store.getArtifactMeta(artifact.artifactId, PRINCIPAL);
    assert.equal(meta.sha256, "a".repeat(64));
    assert.equal("internalPath" in meta, false);

    expectCode(
      () =>
        store.addArtifact({
          ownerId: PRINCIPAL.principalId,
          runId: admitted.run.runId,
          mediaType: "text/plain",
          sha256: "not-a-hash",
          bytes: 1,
          internalPath: "/tmp/x",
          provenance: "verification",
          at: T2,
        }),
      "INVALID_ARGUMENT",
    );
  } finally {
    store.close();
  }
});

test("结果清单区分 agentReported/observed/verification，验证必须有证据", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "result-1" });
    driveToDraining(store, admitted.run.runId, T2);
    const artifact = store.addArtifact({
      ownerId: PRINCIPAL.principalId,
      runId: admitted.run.runId,
      mediaType: "text/plain",
      sha256: "b".repeat(64),
      bytes: 12,
      internalPath: "/tmp/oc02-fixture/test.log",
      provenance: "verification",
      at: T2,
    });

    const completed = store.completeRunWithResult(
      admitted.run.runId,
      {
        agentReported: [{ text: "模型声称已修复" }],
        observed: [{ text: "diff 显示修改了 1 个文件" }],
        verification: [{ text: "npm test 退出 0", evidenceRef: artifact.artifactId }],
      },
      { at: T3 },
    );
    assert.equal(completed.run.state, "completed");
    assert.equal(completed.manifest.verified, true);
    assert.deepEqual(completed.manifest.agentReported, ["模型声称已修复"]);
    assert.deepEqual(completed.manifest.observed, ["diff 显示修改了 1 个文件"]);
    assert.deepEqual(completed.manifest.verification, [
      { text: "npm test 退出 0", evidenceRef: artifact.artifactId },
    ]);
    assert.equal(store.getResultManifest(admitted.run.runId, PRINCIPAL).manifestId, completed.manifest.manifestId);
    expectCode(() => store.getResultManifest(admitted.run.runId, OTHER_PRINCIPAL), "NOT_FOUND");
  } finally {
    store.close();
  }
});

test("缺少证据的 verification 与带证据的 agentReported 都被拒绝，且不留下半条结果", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "result-2" });
    driveToDraining(store, admitted.run.runId, T2);
    const beforeEvents = store.readEvents(admitted.run.runId).events.length;

    expectCode(
      () =>
        store.completeRunWithResult(
          admitted.run.runId,
          { verification: [{ text: "我验证过了" }] },
          { at: T3 },
        ),
      "INVALID_ARGUMENT",
    );
    expectCode(
      () =>
        store.completeRunWithResult(
          admitted.run.runId,
          { agentReported: [{ text: "完成", evidenceRef: "art_fake" }] },
          { at: T3 },
        ),
      "INVALID_ARGUMENT",
    );
    assert.equal(store.runs.require(admitted.run.runId).state, "draining");
    assert.equal(store.results.count(), 0);
    assert.equal(store.readEvents(admitted.run.runId).events.length, beforeEvents);
    assert.equal(store.sessions.require(fixture.session.sessionId).state, "busy");
  } finally {
    store.close();
  }
});

test("结果写入失败时 run 保持 draining，不产生终态事件或第二份清单", () => {
  const fixedManifest = "res_00000000-0000-4000-8000-000000000777";
  const store = BridgeStore.openMemory({ ids: fixedIds({ manifest: () => fixedManifest }) });
  try {
    const fixture = bootstrap(store);
    const first = admit(store, fixture, { clientRequestId: "atomic-1" });
    driveToDraining(store, first.run.runId, T2);
    store.completeRunWithResult(first.run.runId, { agentReported: [{ text: "first" }] }, { at: T3 });

    const secondSession = store.createSession({
      sessionId: SESSION_B_ID,
      ownerId: PRINCIPAL.principalId,
      workspaceId: fixture.workspaceId,
      profile: "review",
      at: T3,
    });
    store.bindSessionBackend(secondSession.sessionId, "oc-backend-2", fixture.serverEpoch, T3);
    const second = admit(store, fixture, { sessionId: SESSION_B_ID, clientRequestId: "atomic-2" });
    driveToDraining(store, second.run.runId, T4);

    assert.throws(() => store.completeRunWithResult(second.run.runId, {}, { at: T5 }));

    const after = store.runs.require(second.run.runId);
    assert.equal(after.state, "draining");
    assert.equal(after.resultManifestId, null);
    assert.equal(store.results.count(), 1);
    const events = store.readEvents(second.run.runId).events;
    assert.equal(events.at(-1)?.type, "run.draining");
    assert.equal(events.some((event) => event.type === "run.terminal"), false);
    assert.equal(store.sessions.require(SESSION_B_ID).state, "busy");
  } finally {
    store.close();
  }
});
