/**
 * OC-09 复核修复：SDK 审批队列、AskUserQuestion 有界停止、B06 身份矛盾。
 *
 * 链路是真实 gateway → IPC → daemon → fake SDK worker；审批由 operator
 * 通道决定。审批与输入都不经 adapter 单测的自定义 sink 绕过产品队列。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupHarness, CLI_MAIN, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";

const CB_FAKE = fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url));
const QD_FAKE = fileURLToPath(new URL("../fixtures/qoder-fake-sdk.mjs", import.meta.url));
const NODE = process.execPath;
const harnesses: DaemonHarness[] = [];

interface McpResult {
  readonly content: Array<{ type: string; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface Gateway {
  call(name: string, args: Record<string, unknown>): Promise<McpResult>;
  close(): Promise<void>;
}

async function mainWorkspace(gateway: Gateway): Promise<{ workspaceId: string; serviceEpoch: number }> {
  const caps = await gateway.call("agent_capabilities", {});
  assert.notEqual(caps.isError, true, JSON.stringify(caps.structuredContent));
  const listed = await gateway.call("workspace_list", {});
  const workspaces = (listed.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces;
  const main = workspaces.find((workspace) => workspace["name"] === "main");
  assert.ok(main !== undefined, JSON.stringify(listed.structuredContent));
  return {
    workspaceId: main["workspaceId"] as string,
    serviceEpoch: Number((caps.structuredContent as Record<string, unknown>)["serviceEpoch"]),
  };
}

async function connectGateway(dataRoot: string, label: string): Promise<Gateway> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_MAIN, "mcp", "serve", "--data-dir", dataRoot],
    stderr: "pipe",
  });
  const client = new Client({ name: label, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as McpResult,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

function readFakeLog(dataRoot: string, backend: "codebuddy" | "qoder", file: string): Record<string, unknown> {
  const dir = join(dataRoot, "backends", backend);
  const sessionDir = readdirSync(dir).find((entry) => entry.startsWith("ses-"));
  if (sessionDir === undefined) throw new Error(`fake log missing: no session dir under ${dir}`);
  return JSON.parse(readFileSync(join(dir, sessionDir, file), "utf8")) as Record<string, unknown>;
}

function openDb(harness: DaemonHarness): DatabaseSync {
  return new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"));
}

async function terminalEvents(harness: DaemonHarness, runId: string): Promise<readonly Record<string, unknown>[]> {
  const page = (await harness.client("run.events", { runId })) as {
    events: Array<{ type: string; state?: string | null; payload: Record<string, unknown> }>;
  };
  return page.events;
}

async function newHarness(backend: "codebuddy" | "qoder"): Promise<DaemonHarness> {
  const harness = await startDaemon({
    scenario: "text-happy",
    sdkBackends:
      backend === "codebuddy"
        ? { codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE } }
        : { qoder: { executable: NODE, model: "qoder-max", fakeModule: QD_FAKE } },
    defaultBackend: backend,
    approvalTimeoutMs: 20_000,
  });
  harnesses.push(harness);
  return harness;
}

after(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) {
      await harness.shutdown();
      cleanupHarness(harness);
    }
  }
});

interface ApprovalRow {
  readonly approvalId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly serverEpoch: number;
  readonly payloadHash: string;
  readonly toolName: string;
}

async function waitApproval(harness: DaemonHarness, runId: string): Promise<ApprovalRow> {
  return harness.waitFor("approval pending", async () => {
    const list = await harness.operator<{ approvals: ApprovalRow[] }>("approval.list");
    return list.approvals.find((entry) => entry.runId === runId) ?? null;
  }, 15_000);
}

test("P0：CodeBuddy Read 审批进入 operator 队列，allow_once 放行后 run 完成", async () => {
  const harness = await newHarness("codebuddy");
  const gateway = await connectGateway(harness.dataRoot, "oc09-approval-allow");
  try {
    const { workspaceId, serviceEpoch } = await mainWorkspace(gateway);
    const started = await gateway.call("agent_start", {
      workspaceId,
      serviceEpoch,
      prompt: "SCENARIO:ask-tool",
      clientRequestId: "oc09-approval-allow-1",
    });
    assert.notEqual(started.isError, true, JSON.stringify(started.structuredContent));
    const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;
    const approval = await waitApproval(harness, runId);
    assert.equal(approval.toolName, "Read");
    assert.match(approval.payloadHash, /^sha256:[0-9a-f]{64}$/);

    const decided = await harness.operator("approval.decide", {
      approvalId: approval.approvalId,
      decision: "allow_once",
      payloadHash: approval.payloadHash,
      serverEpoch: approval.serverEpoch,
      attemptId: approval.attemptId,
    });
    assert.equal((decided as Record<string, unknown>)["state"], "approved");

    await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 20_000 });
    const get = await gateway.call("agent_get", { runId });
    assert.equal((get.structuredContent as Record<string, unknown>)["state"], "completed");

    const captured = readFakeLog(harness.dataRoot, "codebuddy", "fake-sdk.json");
    const calls = captured["canUseToolCalls"] as Array<{ tool: string; decision: { behavior: string } }>;
    assert.equal(calls[0]?.tool, "Read");
    assert.equal(calls[0]?.decision.behavior, "allow");

    const db = openDb(harness);
    try {
      const row = db.prepare("SELECT state, decision_actor, created_at, expires_at FROM approvals WHERE approval_id = ?").get(approval.approvalId) as Record<string, unknown>;
      assert.equal(row["state"], "approved");
      assert.equal(row["decision_actor"], "operator");
      const lifetime = Date.parse(String(row["expires_at"])) - Date.parse(String(row["created_at"]));
      assert.ok(lifetime > 10_000 && lifetime <= 21_000, `approvalTimeoutMs=20s 未生效：${String(lifetime)}ms`);
    } finally {
      db.close();
    }
  } finally {
    await gateway.close();
  }
});

test("P1：OpenCode 先创建 serverEpoch 后，CodeBuddy 审批仍可由 operator 放行", async () => {
  const harness = await newHarness("codebuddy");
  const gateway = await connectGateway(harness.dataRoot, "oc09-approval-mixed");
  try {
    const opencode = (await harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-approval-mixed-opencode",
      backend: "opencode",
      waitMs: 25_000,
    })) as Record<string, unknown>;
    assert.equal(opencode["state"], "completed", JSON.stringify(opencode));

    const { workspaceId, serviceEpoch } = await mainWorkspace(gateway);
    const started = await gateway.call("agent_start", {
      workspaceId,
      serviceEpoch,
      prompt: "SCENARIO:ask-tool",
      clientRequestId: "oc09-approval-mixed-cb",
      backend: "codebuddy",
    });
    assert.notEqual(started.isError, true, JSON.stringify(started.structuredContent));
    const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;
    const approval = await waitApproval(harness, runId);
    const opencodeRunId = opencode["runId"] as string;
    const db = openDb(harness);
    try {
      const prior = db.prepare("SELECT server_epoch FROM dispatch_intents WHERE run_id = ?").all(opencodeRunId) as Array<Record<string, unknown>>;
      const priorEpoch = prior.map((row) => Number(row["server_epoch"]));
      assert.ok(!priorEpoch.includes(approval.serverEpoch), "SDK 应使用自己的活动 serverEpoch，而不是复用 OpenCode 代际");
    } finally {
      db.close();
    }
    const decided = await harness.operator("approval.decide", {
      approvalId: approval.approvalId,
      decision: "allow_once",
      payloadHash: approval.payloadHash,
      serverEpoch: approval.serverEpoch,
      attemptId: approval.attemptId,
    });
    assert.equal((decided as Record<string, unknown>)["state"], "approved", "混布 daemon 不得用最后创建的代际误拒绝 SDK 审批");

    await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 20_000 });
    const get = await gateway.call("agent_get", { runId });
    assert.equal((get.structuredContent as Record<string, unknown>)["state"], "completed");
  } finally {
    await gateway.close();
  }
});

test("P0：Qoder Read 审批 deny 回到同一 attempt，审批落库为 denied", async () => {
  const harness = await newHarness("qoder");
  const gateway = await connectGateway(harness.dataRoot, "oc09-approval-deny");
  try {
    const { workspaceId, serviceEpoch } = await mainWorkspace(gateway);
    const started = await gateway.call("agent_start", {
      workspaceId,
      serviceEpoch,
      prompt: "SCENARIO:ask-tool",
      clientRequestId: "oc09-approval-deny-1",
    });
    const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;
    const approval = await waitApproval(harness, runId);
    await harness.operator("approval.decide", {
      approvalId: approval.approvalId,
      decision: "deny",
      payloadHash: approval.payloadHash,
      serverEpoch: approval.serverEpoch,
      attemptId: approval.attemptId,
    });
    await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 20_000 });

    const captured = readFakeLog(harness.dataRoot, "qoder", "fake-qoder-sdk.json");
    const calls = captured["canUseToolCalls"] as Array<{ tool: string; decision: { behavior: string; message?: string } }>;
    assert.equal(calls[0]?.decision.behavior, "deny");
    assert.match(String(calls[0]?.decision.message), /operator denied/);

    const db = openDb(harness);
    try {
      const row = db.prepare("SELECT state, decision_actor FROM approvals WHERE approval_id = ?").get(approval.approvalId) as Record<string, unknown>;
      assert.equal(row["state"], "denied");
      assert.equal(row["decision_actor"], "operator");
    } finally {
      db.close();
    }
  } finally {
    await gateway.close();
  }
});

for (const backend of ["codebuddy", "qoder"] as const) {
  test(`P0：${backend} AskUserQuestion 走不支持输入的有界停止，不产生审批`, async () => {
    const harness = await newHarness(backend);
    const gateway = await connectGateway(harness.dataRoot, `oc09-input-${backend}`);
    try {
      const { workspaceId, serviceEpoch } = await mainWorkspace(gateway);
      const started = await gateway.call("agent_start", {
        workspaceId,
        serviceEpoch,
        prompt: "SCENARIO:question",
        clientRequestId: `oc09-input-${backend}-1`,
      });
      const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;
      await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 20_000 });
      const get = await gateway.call("agent_get", { runId });
      assert.equal((get.structuredContent as Record<string, unknown>)["state"], "failed");

      const events = await terminalEvents(harness, runId);
      assert.ok(events.some((event) => event.type === "run.input_required"), JSON.stringify(events));
      const terminal = events.find((event) => event.type === "run.terminal" && event.state === "failed");
      assert.equal((terminal?.payload as Record<string, unknown> | undefined)?.["reason"], "INPUT_REQUIRED_UNSUPPORTED");

      const captured = readFakeLog(harness.dataRoot, backend, backend === "codebuddy" ? "fake-sdk.json" : "fake-qoder-sdk.json");
      const calls = captured["canUseToolCalls"] as Array<{ tool: string; decision: { behavior: string; message?: string } }>;
      assert.equal(calls[0]?.tool, "AskUserQuestion");
      assert.equal(calls[0]?.decision.behavior, "deny");
      assert.match(String(calls[0]?.decision.message), /不支持事实输入/);

      const db = openDb(harness);
      try {
        const count = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(runId) as Record<string, unknown>;
        assert.equal(Number(count["n"]), 0, "事实提问不能进入审批队列");
      } finally {
        db.close();
      }
    } finally {
      await gateway.close();
    }
  });
}

for (const backend of ["codebuddy", "qoder"] as const) {
  test(`B06：${backend} 本轮 assistant 身份与选定模型矛盾时 fail 为 BACKEND_PROTOCOL_MISMATCH`, async () => {
    const harness = await newHarness(backend);
    const gateway = await connectGateway(harness.dataRoot, `oc09-mismatch-${backend}`);
    try {
      const { workspaceId, serviceEpoch } = await mainWorkspace(gateway);
      const started = await gateway.call("agent_start", {
        workspaceId,
        serviceEpoch,
        prompt: "SCENARIO:mismatch",
        clientRequestId: `oc09-mismatch-${backend}-1`,
      });
      const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;
      await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 20_000 });
      const get = await gateway.call("agent_get", { runId });
      const payload = get.structuredContent as Record<string, unknown>;
      assert.equal(payload["state"], "failed", JSON.stringify(payload));
      assert.equal(payload["selectedModel"], backend === "codebuddy" ? "glm-5.3" : "qoder-max");
      assert.equal(payload["observedModel"], backend === "codebuddy" ? "glm-mismatch" : "qoder-mismatch");

      const events = await terminalEvents(harness, runId);
      const terminal = events.find((event) => event.type === "run.terminal" && event.state === "failed");
      assert.equal((terminal?.payload as Record<string, unknown> | undefined)?.["reason"], "BACKEND_PROTOCOL_MISMATCH");
    } finally {
      await gateway.close();
    }
  });
}

test("P2：待批中 run stop(cancel) 先落 stopping，停止之后事件流不得回跳 running", async () => {
  const harness = await newHarness("codebuddy");
  try {
    const started = (await harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "SCENARIO:ask-tool",
      clientRequestId: "oc09-cancel-while-waiting",
      backend: "codebuddy",
    })) as Record<string, unknown>;
    const runId = started["runId"] as string;
    const approval = await waitApproval(harness, runId);

    const report = (await harness.client("run.stop", { runId, intent: "cancel" })) as Record<string, unknown>;
    assert.equal(report["found"], "run", JSON.stringify(report));

    const snapshot = (await harness.client("run.get", { runId })) as Record<string, unknown>;
    assert.ok(
      snapshot["state"] === "cancelled" || snapshot["state"] === "unknown",
      `取消必须按停止意图收敛，实际 ${String(snapshot["state"])}`,
    );

    const events = await terminalEvents(harness, runId);
    const types = events.map((event) => event.type);
    const stopIndex = types.indexOf("run.stop_requested");
    const waitIndex = types.lastIndexOf("run.approval_required");
    assert.ok(stopIndex >= 0, `SDK 取消必须先把 run 落进 stopping：${JSON.stringify(types)}`);
    assert.ok(!types.slice(waitIndex + 1, stopIndex).includes("run.state"), `待批必须直迁 stopping：${JSON.stringify(types)}`);
    assert.ok(!types.slice(stopIndex + 1).includes("run.state"), `停止之后不得回跳 running：${JSON.stringify(types)}`);
    const terminal = events.find((event) => event.type === "run.terminal");
    assert.notEqual(terminal?.state, "completed", "取消后不得把后端自称的完成当成功");

    const db = openDb(harness);
    try {
      const row = db
        .prepare("SELECT state FROM approvals WHERE approval_id = ?")
        .get(approval.approvalId) as Record<string, unknown>;
      assert.notEqual(row["state"], "approved", "取消不能留下已批准审批");
    } finally {
      db.close();
    }
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

test("P2：待批中 daemon 优雅关停不回跳 running，终态只收敛为 cancelled/unknown", async () => {
  const harness = await newHarness("qoder");
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:ask-tool",
    clientRequestId: "oc09-shutdown-while-waiting",
    backend: "qoder",
  })) as Record<string, unknown>;
  const runId = started["runId"] as string;
  await waitApproval(harness, runId);

  await harness.shutdown();

  const db = openDb(harness);
  try {
    const rows = db
      .prepare("SELECT type, state FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<Record<string, unknown>>;
    const types = rows.map((row) => String(row["type"]));
    const stopIndex = types.indexOf("run.stop_requested");
    const waitIndex = types.lastIndexOf("run.approval_required");
    assert.ok(stopIndex >= 0, `关停必须先把 run 落进 stopping：${JSON.stringify(types)}`);
    assert.ok(!types.slice(waitIndex + 1, stopIndex).includes("run.state"), `待批必须直迁 stopping：${JSON.stringify(types)}`);
    assert.ok(!types.slice(stopIndex + 1).includes("run.state"), `关停之后不得回跳 running：${JSON.stringify(types)}`);
    const run = db.prepare("SELECT state FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown>;
    assert.ok(
      run["state"] === "cancelled" || run["state"] === "unknown",
      `关停终态必须按停止意图收敛，实际 ${String(run["state"])}`,
    );
  } finally {
    db.close();
    cleanupHarness(harness);
  }
});
