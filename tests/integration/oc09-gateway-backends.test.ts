/**
 * OC-09-05：MCP SDK Client → stdio gateway → 真实 Unix IPC → daemon → fake SDK worker。
 *
 * 覆盖任务卡的完整链路：
 * - agent_capabilities 的 defaultBackend / backends 稳定投影（顶层 models 仍为 OpenCode 视图）；
 * - agent_start(backend/model) 经 gateway 受理并落到对应 fake worker；
 * - get/events/result/sessions 的 backendId 归属与 selectedModel/observedModel；
 * - 旧 daemon（ping 无 contractVersion）在新 gateway 派发前明确要求重启；
 * - CLI run 查询沿用同一条 IPC 输出（backendId 不丢失）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IpcServer } from "../../src/daemon/ipc.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { cleanupHarness, CLI_MAIN, startDaemon } from "../helpers/oc04-harness.ts";

const CB_FAKE = fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url));
const QD_FAKE = fileURLToPath(new URL("../fixtures/qoder-fake-sdk.mjs", import.meta.url));
const NODE = process.execPath;

interface McpCallResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface Gateway {
  readonly client: Client;
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
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
    client,
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as McpCallResult,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

function cli(dataRoot: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_MAIN, ...args, "--data-dir", dataRoot, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("OC-09-05：能力表与三后端查询经 gateway 返回稳定归属，run 落到 fake worker", async (t) => {
  const harness = await startDaemon({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
      qoder: { executable: NODE, model: "qoder-max", fakeModule: QD_FAKE },
    },
    defaultBackend: "codebuddy",
  });
  const gateway = await connectGateway(harness.dataRoot, "oc09-gateway-backends");
  t.after(async () => {
    await gateway.close();
    await harness.shutdown();
    cleanupHarness(harness);
  });

  const caps = await gateway.call("agent_capabilities", {});
  assert.notEqual(caps.isError, true, JSON.stringify(caps.structuredContent));
  const capsPayload = caps.structuredContent as Record<string, unknown>;
  assert.equal(capsPayload["contractVersion"], "2");
  assert.equal(capsPayload["defaultBackend"], "codebuddy");
  // 顶层 models 必须保持 OpenCode 兼容视图，不随 defaultBackend 改变。
  const opencodeModels = capsPayload["models"] as { default: string; allowed: string[] } | null;
  assert.equal(opencodeModels?.default, "minimax/MiniMax-M3.1-Flash");
  assert.deepEqual(opencodeModels?.allowed, ["minimax/MiniMax-M3.1-Flash"]);
  const backends = capsPayload["backends"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    backends.map((entry) => entry["id"]),
    ["opencode", "codebuddy", "qoder"],
    "后端表顺序稳定且只含已配置项",
  );
  for (const entry of backends) {
    assert.deepEqual(entry["profiles"], ["review"]);
    assert.equal((entry["evidence"] as Record<string, unknown>)["level"], "unverified");
    assert.ok(!JSON.stringify(entry).includes(NODE), "能力表不得包含本机可执行文件路径");
    assert.ok(!JSON.stringify(entry).includes("oc09-fake"), "能力表不得包含凭据内容");
  }
  const codebuddyEntry = backends.find((entry) => entry["id"] === "codebuddy") as Record<string, unknown>;
  assert.deepEqual((codebuddyEntry["models"] as Record<string, unknown>)["allowed"], ["glm-5.3"]);

  const workspaceList = await gateway.call("workspace_list", {});
  const workspaces = (workspaceList.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces;
  const main = workspaces.find((workspace) => workspace["name"] === "main") as Record<string, unknown>;

  const epoch = Number(capsPayload["serviceEpoch"]);
  // 新会话省略 backend：必须使用已加载 defaultBackend=codebuddy。
  const started = await gateway.call("agent_start", {
    workspaceId: main["workspaceId"],
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-gw-cb-1",
    serviceEpoch: epoch,
  });
  assert.notEqual(started.isError, true, JSON.stringify(started.structuredContent));
  const receipt = started.structuredContent as Record<string, unknown>;
  assert.equal(receipt["backendId"], "codebuddy");
  assert.equal(receipt["selectedModel"], "glm-5.3");
  const runId = receipt["runId"] as string;

  const waited = await gateway.call("agent_wait", { runs: [{ runId }], returnWhen: "all_terminal", timeoutMs: 25_000 });
  assert.notEqual(waited.isError, true, JSON.stringify(waited.structuredContent));
  const get = await gateway.call("agent_get", { runId });
  const getPayload = get.structuredContent as Record<string, unknown>;
  assert.equal(getPayload["state"], "completed");
  assert.equal(getPayload["backendId"], "codebuddy");
  assert.equal(getPayload["observedModel"], "glm-5.3");

  const events = await gateway.call("agent_events", { runId });
  assert.equal((events.structuredContent as Record<string, unknown>)["backendId"], "codebuddy");

  const result = await gateway.call("agent_result", { runId });
  const resultPayload = result.structuredContent as Record<string, unknown>;
  assert.notEqual(result.isError, true, JSON.stringify(resultPayload));
  assert.equal(resultPayload["backendId"], "codebuddy");
  assert.equal(resultPayload["selectedModel"], "glm-5.3");
  assert.equal(resultPayload["observedModel"], "glm-5.3");
  const sectionText = (resultPayload["page"] as Record<string, unknown>)["text"] as string;
  assert.ok(sectionText.includes("FAKE 结果"), sectionText);

  const sessions = await gateway.call("agent_sessions", { workspaceId: main["workspaceId"] });
  const sessionRows = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions;
  assert.ok(sessionRows.every((session) => session["backendId"] === "codebuddy"));
  assert.ok(sessionRows.some((session) => session["lastSelectedModel"] === "glm-5.3"));

  // qoder 显式后端：同一 gateway 会话内仍能切到另一后端的新会话。
  const qd = await gateway.call("agent_start", {
    workspaceId: main["workspaceId"],
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-gw-qd-1",
    serviceEpoch: epoch,
    backend: "qoder",
    model: "qoder-max",
  });
  assert.notEqual(qd.isError, true, JSON.stringify(qd.structuredContent));
  const qdReceipt = qd.structuredContent as Record<string, unknown>;
  assert.equal(qdReceipt["backendId"], "qoder");
  assert.equal(qdReceipt["selectedModel"], "qoder-max");

  // 低层 CLI 查询沿用同一 IPC，backendId 必须随结果返回。
  const runGet = cli(harness.dataRoot, ["run", "get", "--run-id", runId]);
  assert.equal(runGet.status, 0, runGet.stderr);
  const runGetPayload = JSON.parse(runGet.stdout) as Record<string, unknown>;
  assert.equal(runGetPayload["backendId"], "codebuddy");
  const runEvents = cli(harness.dataRoot, ["run", "events", "--run-id", runId]);
  assert.equal(runEvents.status, 0, runEvents.stderr);
  assert.equal((JSON.parse(runEvents.stdout) as Record<string, unknown>)["backendId"], "codebuddy");
  const runResult = cli(harness.dataRoot, ["run", "result", "--run-id", runId]);
  assert.equal(runResult.status, 0, runResult.stderr);
  assert.equal((JSON.parse(runResult.stdout) as Record<string, unknown>)["backendId"], "codebuddy");
});

test("OC-09-07 / B12：gateway 断连不取消 CodeBuddy run，重连凭原 runId 取回且不二次派发", async (t) => {
  const harness = await startDaemon({
    scenario: "text-happy",
    sdkBackends: { codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE } },
    defaultBackend: "codebuddy",
  });
  const firstGateway = await connectGateway(harness.dataRoot, "oc09-b12-first");
  const secondGateway = await connectGateway(harness.dataRoot, "oc09-b12-second");
  t.after(async () => {
    await firstGateway.close();
    await secondGateway.close();
    await harness.shutdown();
    cleanupHarness(harness);
  });

  const caps = (await firstGateway.call("agent_capabilities", {})).structuredContent as Record<string, unknown>;
  const epoch = Number(caps["serviceEpoch"]);
  const workspaceList = await firstGateway.call("workspace_list", {});
  const workspaces = (workspaceList.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces;
  const workspaceId = workspaces.find((workspace) => workspace["name"] === "main")!["workspaceId"] as string;

  const started = await firstGateway.call("agent_start", {
    workspaceId,
    prompt: "SCENARIO:hang",
    clientRequestId: "oc09-b12-disconnect",
    serviceEpoch: epoch,
  });
  assert.notEqual(started.isError, true, JSON.stringify(started.structuredContent));
  const runId = (started.structuredContent as Record<string, unknown>)["runId"] as string;

  const running = await harness.waitFor("run 进入 running", async () => {
    const snapshot = (await harness.client("run.get", { runId })) as Record<string, unknown>;
    return snapshot["state"] === "running" ? snapshot : null;
  }, 10_000);

  // 宿主断连（gateway 退出）不能取消 daemon 侧 run 或回收 worker。
  await firstGateway.close();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterDisconnect = (await harness.client("run.get", { runId })) as Record<string, unknown>;
  assert.equal(afterDisconnect["state"], "running", JSON.stringify(afterDisconnect));
  assert.equal(afterDisconnect["revision"], running["revision"], "断连不得改写 run 状态");

  // 重连后同 key 同参数重放原 run；fake 只应收到一次 hang 轮次。
  const replay = await secondGateway.call("agent_start", {
    workspaceId,
    prompt: "SCENARIO:hang",
    clientRequestId: "oc09-b12-disconnect",
    serviceEpoch: epoch,
  });
  const replayPayload = replay.structuredContent as Record<string, unknown>;
  assert.equal(replayPayload["reused"], true, JSON.stringify(replayPayload));
  assert.equal(replayPayload["runId"], runId);

  // 取消走 daemon，确认 worker 回收且终态只落一次派发证据。
  const latest = (await secondGateway.call("agent_get", { runId })).structuredContent as Record<string, unknown>;
  const cancelled = await secondGateway.call("agent_cancel", {
    runId,
    clientRequestId: "oc09-b12-cancel",
    expectedRevision: latest["revision"],
    serviceEpoch: epoch,
  });
  assert.notEqual(cancelled.isError, true, JSON.stringify(cancelled.structuredContent));
  await secondGateway.call("agent_wait", {
    runs: [{ runId, afterRevision: latest["revision"] }],
    returnWhen: "all_terminal",
    timeoutMs: 25_000,
  });
  const terminal = (await secondGateway.call("agent_get", { runId })).structuredContent as Record<string, unknown>;
  // 已派发后的取消不能宣称 cancelled；停止确认但终态事件缺失时保持 unknown。
  assert.ok(["cancelled", "unknown", "interrupted"].includes(String(terminal["state"])), JSON.stringify(terminal));

  const db = new DatabaseSync(join(harness.dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM dispatch_intents WHERE run_id = ?").get(runId) as Record<string, unknown>;
    assert.equal(Number(row["n"]), 1, "重连重放不得新增派发意图");
  } finally {
    db.close();
  }
});

test("OC-09-05 / B16：旧 daemon 无契约版本时，新 gateway 在派发前明确要求重启", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "oc09-old-daemon-"));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const paths = resolveDaemonPaths(dataRoot);
  mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
  const calls: string[] = [];
  const workspaceId = "ws_11111111-1111-4111-8111-111111111111";
  const server = new IpcServer({
    path: paths.clientSocket,
    source: "client",
    handler: ({ envelope }) => {
      calls.push(envelope.kind);
      if (envelope.kind === "ping") {
        // 旧 daemon：没有 contractVersion/defaultBackend/backends。
        return {
          pid: 4242,
          serviceEpoch: 7,
          serverEpoch: 7,
          editEnabled: false,
          controlChannelIsolation: "unverified",
          limits: {
            activeRuns: 1,
            runTimeoutMs: 900_000,
            waitTimeoutMs: 20_000,
            queueTtlMs: 300_000,
            approvalTimeoutMs: 300_000,
            artifactMaxBytes: 10 * 1024 * 1024,
          },
        };
      }
      if (envelope.kind === "workspace.list") {
        return { workspaces: [{ workspaceId, name: "main", profiles: ["review"], generation: 1 }] };
      }
      throw new Error(`旧 daemon 不应收到 ${envelope.kind}`);
    },
  });
  await server.start();
  const gateway = await connectGateway(dataRoot, "oc09-old-daemon");
  t.after(async () => {
    await gateway.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const caps = await gateway.call("agent_capabilities", {});
  const capsPayload = caps.structuredContent as Record<string, unknown>;
  // 查询不硬失败：如实告知旧 daemon 缺少新摘要。
  assert.equal(capsPayload["defaultBackend"], null);
  assert.equal(capsPayload["backends"], null);
  assert.equal(capsPayload["models"], null);
  assert.match(String(capsPayload["unsupportedExtra"]), /重启 daemon/);

  const started = await gateway.call("agent_start", {
    workspaceId,
    prompt: "hello",
    clientRequestId: "oc09-old-daemon-1",
    serviceEpoch: 7,
  });
  assert.equal(started.isError, true, JSON.stringify(started.structuredContent));
  const wire = (started.structuredContent as { error?: { code?: string; details?: Record<string, unknown> } }).error;
  assert.equal(wire?.code, "BACKEND_PROTOCOL_MISMATCH");
  assert.equal(wire?.details?.["reason"], "daemon_contract_upgrade_required");
  assert.equal(wire?.details?.["daemonContractVersion"], null);
  assert.equal(
    calls.includes("run.start"),
    false,
    "版本混跑必须在模型/后端派发前拒绝，不能先调用 run.start",
  );
});
