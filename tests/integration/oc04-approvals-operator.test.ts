import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupHarness, sleep, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";
import { readRequests } from "../helpers/oc03-harness.ts";

interface ApprovalItem {
  readonly approvalId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly serverEpoch: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly argumentsText: string;
  readonly payloadHash: string;
  readonly state: string;
  readonly waitlisted: boolean;
}

interface DecisionResult {
  readonly approvalId: string;
  readonly state: string;
  readonly decisionActor: string | null;
}

/** 有界等待待批出现在 operator 队列。 */
async function waitPending(harness: DaemonHarness): Promise<ApprovalItem> {
  return harness.waitFor(
    "待批审批出现在 operator 队列",
    async () => {
      const list = (await harness.operator("approval.list", {}, 3_000)) as { approvals: ApprovalItem[] };
      const pending = list.approvals.find((item) => item.state === "pending" && item.waitlisted);
      return pending ?? null;
    },
    15_000,
  );
}

async function startPermissionRun(harness: DaemonHarness, clientRequestId: string): Promise<string> {
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "需要审批的任务",
    clientRequestId,
  })) as { runId: string };
  return started.runId;
}

test("operator 阳性对照：批准 allow_once → 后端收到 reply once → run 完成", async () => {
  const harness = await startDaemon({ scenario: "permission-deny", runTimeoutMs: 20_000 });
  try {
    const runId = await startPermissionRun(harness, "req-approve-1");
    const pending = await waitPending(harness);
    assert.equal(pending.runId, runId);
    const decided = (await harness.operator("approval.decide", {
      approvalId: pending.approvalId,
      decision: "allow_once",
      payloadHash: pending.payloadHash,
      serverEpoch: pending.serverEpoch,
      attemptId: pending.attemptId,
    })) as DecisionResult;
    assert.equal(decided.state, "approved");
    assert.equal(decided.decisionActor, "operator");

    await harness.waitFor(
      "批准后的 run 完成",
      async () => {
        const snap = (await harness.client("run.get", { runId })) as { state: string };
        return snap.state === "completed" ? snap : null;
      },
      20_000,
    );
    const requests = readRequests(harness.paths.backendLog);
    assert.equal(
      requests.some((entry) => entry["route"] !== undefined && String(entry["route"]).includes("/reply") && entry["reply"] === "once"),
      true,
      "后端必须真实收到 once 回复",
    );
    await harness.shutdown();
    cleanupHarness(harness);
  } catch (error) {
    await harness.shutdown().catch(() => undefined);
    cleanupHarness(harness);
    throw error;
  }
});

test("operator deny → run failed/APPROVAL_DENIED；审批落 denied 不可复用", async () => {
  // 无最终文字的拒绝（tool-calls + tool.error）：OC-03 语义下收敛为 failed/APPROVAL_DENIED。
  const harness = await startDaemon({ scenario: "permission-reject-no-final", runTimeoutMs: 20_000 });
  try {
    const runId = await startPermissionRun(harness, "req-deny-1");
    const pending = await waitPending(harness);
    const decided = (await harness.operator("approval.decide", {
      approvalId: pending.approvalId,
      decision: "deny",
      payloadHash: pending.payloadHash,
      serverEpoch: pending.serverEpoch,
      attemptId: pending.attemptId,
    })) as DecisionResult;
    assert.equal(decided.state, "denied");

    await harness.waitFor(
      "拒绝后的 run 收敛为 failed",
      async () => {
        const snap = (await harness.client("run.get", { runId })) as { state: string };
        return snap.state === "failed" ? snap : null;
      },
      20_000,
    );
    // 二次决定：报不可复用。
    await assert.rejects(
      harness.operator("approval.decide", {
        approvalId: pending.approvalId,
        decision: "allow_once",
        payloadHash: pending.payloadHash,
        serverEpoch: pending.serverEpoch,
        attemptId: pending.attemptId,
      }),
      (error: unknown) => error instanceof Error,
    );
    await harness.shutdown();
    cleanupHarness(harness);
  } catch (error) {
    await harness.shutdown().catch(() => undefined);
    cleanupHarness(harness);
    throw error;
  }
});

test("普通查询通道不能批准；改参/换上下文的决定被拒绝", async () => {
  const harness = await startDaemon({ scenario: "permission-deny", runTimeoutMs: 20_000 });
  try {
    const runId = await startPermissionRun(harness, "req-guard-1");
    const pending = await waitPending(harness);

    // client 通道：UNAUTHORIZED。
    await assert.rejects(
      harness.client("approval.decide", {
        approvalId: pending.approvalId,
        decision: "allow_once",
        payloadHash: pending.payloadHash,
        serverEpoch: pending.serverEpoch,
        attemptId: pending.attemptId,
      }),
      (error: unknown) => (error as { code?: string }).code === "UNAUTHORIZED",
    );
    // operator 通道但上下文被改：拒绝且审批作废（改参不能复用）。
    await assert.rejects(
      harness.operator("approval.decide", {
        approvalId: pending.approvalId,
        decision: "allow_once",
        payloadHash: "sha256:" + "0".repeat(64),
        serverEpoch: pending.serverEpoch,
        attemptId: pending.attemptId,
      }),
      (error: unknown) => error instanceof Error,
    );
    // 取消 run 后，pending 被清理；迟到决定不能复活。
    await harness.client("run.stop", { runId, intent: "cancel" });
    await sleep(300);
    await assert.rejects(
      harness.operator("approval.decide", {
        approvalId: pending.approvalId,
        decision: "allow_once",
        payloadHash: pending.payloadHash,
        serverEpoch: pending.serverEpoch,
        attemptId: pending.attemptId,
      }),
      (error: unknown) => error instanceof Error,
    );
    await harness.shutdown();
    cleanupHarness(harness);
  } catch (error) {
    await harness.shutdown().catch(() => undefined);
    cleanupHarness(harness);
    throw error;
  }
});
