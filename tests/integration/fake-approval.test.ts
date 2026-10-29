import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type {
  ApprovalAnswer,
  BackendApprovalRequest,
  BackendEvent,
  BackendEventSink,
} from "../../src/contracts/backend.ts";
import { payloadHash } from "../../src/contracts/json.ts";

type Policy = "allow" | "deny" | "timeout";

async function runApproval(policy: Policy) {
  const backend = new FakeBackend({ scenario: "approval-gated" });
  const events: BackendEvent[] = [];
  const requests: BackendApprovalRequest[] = [];

  const sink: BackendEventSink = {
    emit(event) {
      events.push(event);
    },
    async requestApproval(request): Promise<ApprovalAnswer> {
      requests.push(request);
      if (policy === "deny") return { decision: "deny", actor: "operator" };
      if (policy === "timeout") return { decision: "timeout", actor: "product_expiry" };
      return { decision: "allow_once", actor: "operator" };
    },
    async requestInput() {
      return "unsupported";
    },
  };

  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const outcome = await backend.execute(
    { runId: "run_00000000-0000-4000-8000-000000000003", session, prompt: "approve", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: "2026-01-01T00:01:00.000Z" },
    sink,
  );
  return { outcome, events, requests };
}

test("批准后继续执行并完成", async () => {
  const { outcome, events } = await runApproval("allow");
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(
    events.map((event) => event.type),
    ["approval_requested", "progress"],
  );
});

test("拒绝后不执行该操作，run 终止（APPROVAL_DENIED）", async () => {
  const { outcome, events } = await runApproval("deny");
  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.error?.code, "APPROVAL_DENIED");
  // 拒绝之后不该再出现任何 progress：不允许模型换个说法继续执行。
  assert.equal(events.some((event) => event.type === "progress"), false);
});

test("无人决策按审批超时收敛（APPROVAL_EXPIRED），且不冒充用户拒绝", async () => {
  const { outcome } = await runApproval("timeout");
  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.error?.code, "APPROVAL_EXPIRED");
  assert.notEqual(outcome.error?.code, "APPROVAL_DENIED");
});

test("待批请求带齐本地决策所需字段，参数哈希可复算", async () => {
  const { requests } = await runApproval("allow");
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.toolName, "Bash");
  assert.equal(request.toolCallId, "tc-approve");
  assert.deepEqual(request.targetPaths, ["."]);
  assert.equal(request.requestKind, "tool_permission");
  assert.equal(request.serverEpoch, 1);
  assert.match(request.expiresAt, /Z$/);

  // 同样的参数集合必须得到同一个哈希（审批绑定 payloadHash 的基础）。
  const recomputed = payloadHash({ toolName: request.toolName, argumentsText: request.argumentsText });
  assert.equal(recomputed, payloadHash({ argumentsText: request.argumentsText, toolName: request.toolName }));
});

test("重复的 permission 通知不会产生第二条待批记录（fake 侧只发一次）", async () => {
  const { requests } = await runApproval("allow");
  assert.equal(requests.length, 1);
});
