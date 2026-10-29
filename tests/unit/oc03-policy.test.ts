import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTurnOutcome } from "../../src/core/apply-outcome.ts";
import {
  buildControlledConfig,
  permissionConfig,
  permissionRules,
} from "../../src/backend/opencode/profile.ts";
import { collectTools, parseMessageList } from "../../src/backend/opencode/protocol.ts";
import { ApprovalCoordinator, type ApprovalContext } from "../../src/backend/opencode/approvals.ts";
import type { OpenCodeApi } from "../../src/backend/opencode/client.ts";
import { ownedProcesses, type ProcessInfo } from "../../src/backend/opencode/worker.ts";
import type { BackendApprovalRequest, BackendEvent, BackendEventSink } from "../../src/contracts/backend.ts";

const RUN = "run_00000000-0000-4000-8000-0000000000f1" as never;

/** 停止期间观察到 unknown：必须保留 unknown（不能改写成「已确认取消」）。 */
test("停止后观察到 unknown 仍收敛为 unknown，不解除阻塞", () => {
  for (const intent of ["cancel", "interrupt", "close", "deadline"] as const) {
    const applied = applyTurnOutcome(
      { kind: "unknown", terminalObservedAfterStop: true },
      { from: "stopping", stopIntent: intent },
    );
    assert.equal(applied.state, "unknown", `intent=${intent}`);
    assert.equal(applied.path.includes("cancelled"), false);
    assert.equal(applied.path.includes("timed_out"), false);
  }
  // 对照：停止之后到达的 completed 仍然按停止意图收敛（A05 语义不变）。
  const late = applyTurnOutcome({ kind: "completed", terminalObservedAfterStop: true }, { from: "running", stopIntent: "cancel" });
  assert.equal(late.state, "cancelled");
});

test("配置文件 permission 是 PermissionConfig（对象），session 规则集才是数组", () => {
  const config = buildControlledConfig({
    providers: { minimax: { options: {} } },
    defaultModelRef: "minimax/MiniMax-M3.1-Flash",
    policyProfile: "review",
  });
  const permission = config["permission"];
  assert.equal(Array.isArray(permission), false, "Config.permission 不能写 PermissionRuleset 数组");
  assert.equal(typeof permission, "object");
  assert.deepEqual(permissionConfig("review"), { "*": "deny", read: "allow", edit: "deny", bash: "deny", shell: "deny" });
  assert.deepEqual(permissionConfig("edit"), { "*": "deny", read: "allow", edit: "ask", bash: "ask", shell: "ask" });
  // 对照：POST /session 用数组。
  assert.equal(Array.isArray(permissionRules("review")), true);
  assert.equal((permissionRules("review")[0] as { permission: string }).permission, "*");
  assert.equal(config["model"], "minimax/MiniMax-M3.1-Flash");
  assert.equal(config["small_model"], "minimax/MiniMax-M3.1-Flash");
});

test("工具状态缺失/无法识别时保持未确认，不会让 finish=stop 误报成功", () => {
  const raw = [
    {
      info: { id: "msg_u", sessionID: "ses_x", role: "user", time: { created: 1 }, agent: "build", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } } },
      parts: [],
    },
    {
      info: { id: "msg_a", sessionID: "ses_x", role: "assistant", parentID: "msg_u", time: { created: 2, completed: 3 }, finish: "stop", providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
      parts: [
        { id: "prt_t", sessionID: "ses_x", messageID: "msg_a", type: "tool", callID: "c1", tool: "bash", state: { status: "weird", input: {} } },
        { id: "prt_t2", sessionID: "ses_x", messageID: "msg_a", type: "tool", callID: "c2", tool: "bash" },
        { id: "prt_t3", sessionID: "ses_x", messageID: "msg_a", type: "tool" },
      ],
    },
  ];
  const messages = parseMessageList(raw).messages;
  const tools = collectTools(messages.filter((message) => message.role === "assistant"));
  assert.equal(tools.observations.length, 3, "坏工具条目不能被悄悄丢掉");
  assert.equal(tools.pending, true);
  assert.equal(tools.unconfirmed, true);
  assert.equal(tools.anyError, false);
  for (const item of tools.observations) assert.equal(item.state, "unknown");
  // 有缺状态的工具时，任何「完成」判定都不能成立。
  const noTools: never[] = [];
  const clean = collectTools(noTools);
  assert.equal(clean.pending, false);
  assert.equal(clean.unconfirmed, false);
});

// ---------------------------------------------------------------- 审批严格性

interface StubApi {
  readonly api: OpenCodeApi;
  readonly replies: { requestId: string; reply: string }[];
}

function stubApi(): StubApi {
  const replies: { requestId: string; reply: string }[] = [];
  const api = {
    async replyPermission(requestId: string, reply: "once" | "reject") {
      replies.push({ requestId, reply });
      return { ok: true as const };
    },
  } as unknown as OpenCodeApi;
  return { api, replies };
}

function sinkWith(answer: () => Promise<{ decision: "allow_once" } | { decision: "deny" } | { decision: "timeout" }>): {
  sink: BackendEventSink;
  approvals: BackendApprovalRequest[];
  warnings: string[];
  asked(): number;
} {
  const approvals: BackendApprovalRequest[] = [];
  const warnings: string[] = [];
  let asked = 0;
  return {
    approvals,
    warnings,
    asked: () => asked,
    sink: {
      emit(event: BackendEvent) {
        if (event.type === "approval_requested") approvals.push(event.request);
        if (event.type === "warning") warnings.push(event.code);
      },
      requestApproval(request) {
        asked += 1;
        approvals.push(request);
        return answer() as never;
      },
      requestInput: async () => "unsupported",
    },
  };
}

function context(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    runId: RUN,
    attemptId: "att_1",
    serverEpoch: 1,
    sessionId: "ses_fake",
    deadlineMs: Date.now() + 5_000,
    approvalTimeoutMs: 2_000,
    ownsMessage: (messageId) => messageId === "msg_asst",
    ...overrides,
  };
}

function rawPermission(overrides: Record<string, unknown> = {}) {
  return {
    id: "per_1",
    sessionId: "ses_fake",
    permission: "bash",
    patterns: ["sh ./x.sh"],
    command: "sh ./x.sh",
    diff: null,
    toolMessageId: "msg_asst",
    toolCallId: "call_1",
    ...overrides,
  };
}

test("审批只对「本会话 + 本 run 消息 + 有 callID」的请求生效", async () => {
  const { api, replies } = stubApi();
  const { sink, approvals, warnings } = sinkWith(async () => ({ decision: "allow_once" }));
  const coordinator = new ApprovalCoordinator();

  const foreign = await coordinator.process(
    [rawPermission({ id: "per_foreign", sessionId: "ses_other" })],
    context(),
    api,
    sink,
    Date.now,
  );
  assert.equal(foreign.kind, "none");
  assert.equal(approvals.length, 0);
  assert.ok(warnings.includes("APPROVAL_UNATTRIBUTED"));

  const missingMessage = await coordinator.process([rawPermission({ id: "per_no_message", toolMessageId: null })], context(), api, sink, Date.now);
  assert.equal(missingMessage.kind, "none");

  const unattributed = await coordinator.process([rawPermission({ id: "per_unattributed", toolMessageId: "msg_other" })], context(), api, sink, Date.now);
  assert.equal(unattributed.kind, "none");

  const noCallId = await coordinator.process([rawPermission({ id: "per_no_call", toolCallId: null })], context(), api, sink, Date.now);
  assert.equal(noCallId.kind, "none");

  assert.equal(replies.length, 0, "归属不明时绝不能发许可");

  const own = await coordinator.process([rawPermission({ id: "per_own" })], context(), api, sink, Date.now);
  assert.equal(own.kind, "allowed");
  assert.deepEqual(replies, [{ requestId: "per_own", reply: "once" }]);
  assert.equal(approvals.at(-1)?.toolCallId, "call_1");
  assert.equal(approvals.at(-1)?.backendRequestId, "per_own");
});

test("审批超时后迟到的 allow 不会被发送", async () => {
  const { api, replies } = stubApi();
  const holder: { release: ((value: { decision: "allow_once" }) => void) | null } = { release: null };
  const { sink } = sinkWith(
    () =>
      new Promise<{ decision: "allow_once" }>((resolve) => {
        holder.release = resolve;
      }),
  );
  const coordinator = new ApprovalCoordinator();
  const pending = coordinator.process([rawPermission({ id: "per_late" })], context({ approvalTimeoutMs: 60 }), api, sink, Date.now);
  const result = await pending;
  assert.equal(result.kind, "timeout");
  // 迟到的许可：即使操作者此刻返回 allow_once，也不会再发回复。
  holder.release?.({ decision: "allow_once" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replies.length, 0);
});

test("审批请求在 run 期限之前到期后不再询问操作者", async () => {
  const { api, replies } = stubApi();
  const { sink, approvals } = sinkWith(async () => ({ decision: "allow_once" }));
  const coordinator = new ApprovalCoordinator();
  const result = await coordinator.process(
    [rawPermission({ id: "per_expired" })],
    context({ deadlineMs: Date.now() - 1_000 }),
    api,
    sink,
    Date.now,
  );
  assert.equal(result.kind, "timeout");
  assert.equal(approvals.length, 0);
  assert.equal(replies.length, 0);
});

test("同一 callID 重新请求时复用拒绝，不再询问", async () => {
  const { api, replies } = stubApi();
  const { sink, approvals, asked } = sinkWith(async () => ({ decision: "deny" }));
  const coordinator = new ApprovalCoordinator();
  const first = await coordinator.process([rawPermission({ id: "per_a" })], context(), api, sink, Date.now);
  assert.equal(first.kind, "denied");
  const second = await coordinator.process([rawPermission({ id: "per_b" })], context(), api, sink, Date.now);
  assert.equal(second.kind, "repeat_denied");
  assert.equal(asked(), 1, "第二次不应再打扰操作者");
  assert.equal(approvals.length, 2, "只有一次 approval_requested 事件 + 一次决策记录");
  assert.deepEqual(replies, [
    { requestId: "per_a", reply: "reject" },
    { requestId: "per_b", reply: "reject" },
  ]);
});

test("进程归属：只选自己的进程组与后代，拒绝当前组", () => {
  const table: ProcessInfo[] = [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 101, ppid: 100, pgid: 100 },
    { pid: 200, ppid: 1, pgid: 200 },
  ];
  const owned = ownedProcesses(table, 100, 100);
  assert.deepEqual(owned.map((row) => row.pid), [101]);
  // 当前进程组（这里用 test runner 自己的 pid）永远不能被当成 worker 的组。
  const self = table.map((row) => (row.pid === 200 ? { ...row, pid: process.pid, pgid: process.pid } : row));
  assert.deepEqual(ownedProcesses(self, process.pid, process.pid), []);
  // 非法进程组（0/1）一律不选。
  assert.deepEqual(ownedProcesses(table, 1, 1), []);
});
