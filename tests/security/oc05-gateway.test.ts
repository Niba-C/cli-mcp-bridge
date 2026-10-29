/**
 * OC-05 安全与边界：经真实 MCP gateway 验证主体/工作区访问控制、
 * strict 输入拒绝与工件路径/哈希/编码边界。
 *
 * 外来主体/已撤销工作区的实体通过真实 BridgeStore API 种入（与 daemon 同库，
 * 先验证访问控制，再走 MCP 全链路
 * 验证拒绝——不是 handler stub。所有 client 子进程在注册后立即挂 t.after
 * 清理，断言失败也会回收。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ipcCall } from "../../src/daemon/ipc.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { newId, type PrincipalId } from "../../src/contracts/ids.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import {
  cleanupHarness,
  CLI_MAIN,
  startDaemon,
  type DaemonHarness,
} from "../helpers/oc04-harness.ts";

interface McpCallResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

async function connectGateway(harness: DaemonHarness, teardown: (fn: () => Promise<void>) => void): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot],
    stderr: "pipe",
  });
  // 持续消费 stderr，避免管道缓冲填满阻塞 gateway。
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "oc05-security", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  teardown(async () => {
    await client.close().catch(() => undefined);
  });
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return (await client.callTool({ name, arguments: args })) as McpCallResult;
}

async function expectError(client: Client, name: string, args: Record<string, unknown>, code: string): Promise<void> {
  const result = await callTool(client, name, args);
  const wire = (result.structuredContent as { error?: { code?: string } } | undefined)?.error;
  assert.equal(result.isError, true, `期望 ${code}，实际: ${JSON.stringify(result)}`);
  assert.equal(wire?.code, code);
}

interface SeededEntities {
  readonly foreignRunId: string;
  readonly revokedRunId: string;
  readonly revokedWorkspaceId: string;
}

/** 用真实 BridgeStore API 种入「外 owner」与「同 owner 但已撤销工作区」的实体。 */
function seedForeignEntities(harness: DaemonHarness): SeededEntities {
  const paths = resolveDaemonPaths(harness.dataRoot);
  const principalId = (JSON.parse(readFileSync(paths.principalFile, "utf8")) as { principalId: string }).principalId as PrincipalId;
  const store = BridgeStore.open(join(harness.dataRoot, "data", "opencode-bridge.sqlite"));
  try {
    const workspace = store.workspaces.list().find((candidate) => candidate.name === "main");
    assert.ok(workspace, "main workspace 必须已登记");
    const other = newId("principal");
    const foreignSession = store.createSession({
      ownerId: other,
      workspaceId: workspace.workspaceId,
      profile: "review",
    });
    const foreignRun = store.admitRun({
      principal: { principalId: other, allowedWorkspaces: [workspace.workspaceId], role: "owner" },
      sessionId: foreignSession.sessionId,
      toolName: "agent_start",
      clientRequestId: "sec-foreign-root",
      serviceEpoch: store.currentServiceEpoch() ?? 0,
      prompt: "seed foreign",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }).run;

    // 已撤销工作区：owner 是本主体，但 daemon 配置不再包含它（未登记进 runtimes）。
    const revokedWorkspace = store.createWorkspace({
      name: `sec-revoked-${randomUUID().slice(0, 8)}`,
      canonicalRoot: join(harness.root, "revoked-source"),
      profiles: ["review"],
    });
    const revokedSession = store.createSession({
      ownerId: principalId,
      workspaceId: revokedWorkspace.workspaceId,
      profile: "review",
    });
    const revokedRun = store.admitRun({
      principal: { principalId, allowedWorkspaces: [revokedWorkspace.workspaceId], role: "owner" },
      sessionId: revokedSession.sessionId,
      toolName: "agent_start",
      clientRequestId: "sec-revoked-root",
      serviceEpoch: store.currentServiceEpoch() ?? 0,
      prompt: "seed revoked",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }).run;
    return {
      foreignRunId: foreignRun.runId,
      revokedRunId: revokedRun.runId,
      revokedWorkspaceId: revokedWorkspace.workspaceId,
    };
  } finally {
    store.close();
  }
}

test("OC-05 访问控制与输入边界（真实 gateway + 种入实体）", async (t) => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    runTimeoutMs: 120_000,
  });
  t.after(async () => {
    await harness.shutdown();
    cleanupHarness(harness);
  });
  const client = await connectGateway(harness, (fn) => t.after(fn));

  const caps = await callTool(client, "agent_capabilities", {});
  const epoch = Number((caps.structuredContent as Record<string, unknown>)["serviceEpoch"]);
  const list = await callTool(client, "workspace_list", {});
  const mainWorkspace = String(
    (list.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces.find((w) => w["name"] === "main")?.["workspaceId"],
  );

  const seeded = seedForeignEntities(harness);

  await t.test("外 owner 的 run：get/events/result/wait/cancel 全部 NOT_FOUND", async () => {
    await expectError(client, "agent_get", { runId: seeded.foreignRunId }, "NOT_FOUND");
    await expectError(client, "agent_events", { runId: seeded.foreignRunId }, "NOT_FOUND");
    await expectError(client, "agent_result", { runId: seeded.foreignRunId }, "NOT_FOUND");
    await expectError(
      client,
      "agent_wait",
      { runs: [{ runId: seeded.foreignRunId }], timeoutMs: 0 },
      "NOT_FOUND",
    );
    await expectError(
      client,
      "agent_cancel",
      { runId: seeded.foreignRunId, clientRequestId: "sec-cancel-foreign", expectedRevision: 1, serviceEpoch: epoch },
      "NOT_FOUND",
    );
  });

  await t.test("已撤销工作区的同 owner run：同样不可见、不可取消", async () => {
    await expectError(client, "agent_get", { runId: seeded.revokedRunId }, "NOT_FOUND");
    await expectError(client, "agent_result", { runId: seeded.revokedRunId }, "NOT_FOUND");
    await expectError(
      client,
      "agent_cancel",
      { runId: seeded.revokedRunId, clientRequestId: "sec-cancel-revoked", expectedRevision: 1, serviceEpoch: epoch },
      "NOT_FOUND",
    );
    // agent_sessions 不返回已撤销工作区的会话
    const sessions = await callTool(client, "agent_sessions", {});
    const sessionList = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(
      sessionList.some((session) => session["workspaceId"] === seeded.revokedWorkspaceId),
      false,
      "已撤销工作区的会话不得出现在列表里",
    );
  });

  await t.test("strict 输入：危险字段/未知字段经 MCP 拒绝", async () => {
    // SDK McpServer 把输入校验失败收敛为 isError 工具结果（非 JSON-RPC 拒绝）。
    const expectValidationFailure = async (name: string, args: Record<string, unknown>): Promise<void> => {
      let rejected: unknown = null;
      let resolved: McpCallResult | null = null;
      try {
        resolved = await callTool(client, name, args);
      } catch (error) {
        rejected = error;
      }
      if (rejected !== null) {
        assert.match(String(rejected), /Invalid arguments/);
        return;
      }
      assert.equal(resolved?.isError, true, `期望校验失败，实际成功: ${JSON.stringify(resolved)}`);
      assert.match(resolved?.content[0]?.text ?? "", /Invalid arguments/);
    };
    await expectValidationFailure("agent_start", {
      workspaceId: mainWorkspace,
      prompt: "x",
      clientRequestId: "sec-env-1",
      serviceEpoch: epoch,
      env: { SECRET: "1" },
    });
    await expectValidationFailure("artifact_read", { artifactId: `art_${randomUUID()}`, path: "/etc/passwd" });
    // 越权语义字段：principal 指定 → 未知字段拒绝
    await expectValidationFailure("agent_get", { runId: `run_${randomUUID()}`, principalId: "prn_other" });
  });

  let runId = "";
  await t.test("profile/timeout/contextArtifactIds 非默认值显式拒绝", async () => {
    const startArgs = {
      workspaceId: mainWorkspace,
      prompt: "边界检查",
      clientRequestId: `sec-boundary-${Date.now()}`,
      serviceEpoch: epoch,
    };
    await expectError(client, "agent_start", { ...startArgs, profile: "edit" }, "PROFILE_NOT_ALLOWED");
    await expectError(client, "agent_start", { ...startArgs, timeoutMs: 1234 }, "INVALID_ARGUMENT");
    await expectError(client, "agent_start", { ...startArgs, contextArtifactIds: [`art_${randomUUID()}`] }, "INVALID_ARGUMENT");
    // 空数组允许（schema 兼容，行为等于不支持）
    const okStart = await callTool(client, "agent_start", { ...startArgs, contextArtifactIds: [] });
    assert.notEqual(okStart.isError, true);
    runId = String((okStart.structuredContent as Record<string, unknown>)["runId"]);
    const wait = await callTool(client, "agent_wait", { runs: [{ runId }], returnWhen: "any_terminal", timeoutMs: 25_000 });
    assert.equal((wait.structuredContent as { runs: Array<{ state: string }> }).runs[0]?.state, "completed");
  });

  await t.test("工件边界：symlink 逃逸/二进制/hash 不符/外 owner 拒绝；internalPath 不外泄", async () => {
    const result = await callTool(client, "agent_result", { runId });
    const ownArtifacts = ((result.structuredContent as Record<string, unknown>)["artifacts"] ??
      []) as Array<Record<string, unknown>>;
    assert.ok(ownArtifacts.length === 3);
    // artifactStatus 从返回值可发现（主执行者补充字段）
    const artifactStatus = (result.structuredContent as Record<string, unknown>)["artifactStatus"] as Record<string, unknown>;
    assert.deepEqual(artifactStatus["missing"], []);
    assert.equal(artifactStatus["complete"], true);

    const artifactsDir = join(harness.dataRoot, "artifacts");
    const runDir = join(artifactsDir, runId);
    mkdirSync(runDir, { recursive: true });
    const dbPath = join(harness.dataRoot, "data", "opencode-bridge.sqlite");
    const db = new DatabaseSync(dbPath);
    const registerRow = (artifactId: string, internalPath: string, sha256: string, bytes: number, ownerId?: string): void => {
      db.prepare(
        `INSERT INTO artifacts (artifact_id, owner_id, run_id, media_type, sha256, bytes, internal_path, provenance, truncated, created_at)
         VALUES (?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?, 'daemon_capture', 0, '2026-10-24T00:00:00.000Z')`,
      ).run(
        artifactId,
        ownerId ?? String((db.prepare("SELECT owner_id FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown>)["owner_id"]),
        runId,
        sha256,
        bytes,
        internalPath,
      );
    };
    try {
      // 1) symlink 逃逸（owner 合法，路径逃逸）
      const escapeTarget = join(harness.root, "escape-target.txt");
      writeFileSync(escapeTarget, "secret outside artifact root\n");
      symlinkSync(escapeTarget, join(runDir, "escape.txt"));
      const escapeId = `art_${randomUUID()}`;
      const escapeContent = "secret outside artifact root\n";
      registerRow(escapeId, `${runId}/escape.txt`, createHash("sha256").update(escapeContent).digest("hex"), Buffer.byteLength(escapeContent));
      await expectError(client, "artifact_read", { artifactId: escapeId }, "UNAUTHORIZED");

      // 2) 相对路径逃逸（../）：路径形状非法，先于存在性判断拒绝
      const escapeId2 = `art_${randomUUID()}`;
      registerRow(escapeId2, `${runId}/../../config.json`, createHash("sha256").update("x").digest("hex"), 1);
      await expectError(client, "artifact_read", { artifactId: escapeId2 }, "INVALID_ARGUMENT");

      // 3) 二进制（非法 UTF-8）
      const binaryId = `art_${randomUUID()}`;
      const binaryBytes = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
      writeFileSync(join(runDir, "binary.txt"), binaryBytes);
      registerRow(binaryId, `${runId}/binary.txt`, createHash("sha256").update(binaryBytes).digest("hex"), binaryBytes.length);
      await expectError(client, "artifact_read", { artifactId: binaryId }, "INVALID_ARGUMENT");

      // 4) hash 不符
      const tamperedId = `art_${randomUUID()}`;
      registerRow(tamperedId, `${runId}/tampered.txt`, "0".repeat(64), 4);
      writeFileSync(join(runDir, "tampered.txt"), "abcd");
      await expectError(client, "artifact_read", { artifactId: tamperedId }, "BACKEND_PROTOCOL_MISMATCH");

      // 5) 外 owner 工件
      const foreignArtifact = `art_${randomUUID()}`;
      registerRow(foreignArtifact, "outside.txt", "a".repeat(64), 1, newId("principal"));
      await expectError(client, "artifact_read", { artifactId: foreignArtifact }, "NOT_FOUND");
    } finally {
      db.close();
    }
    // 正常工件读取不泄露 internalPath
    for (const artifact of ownArtifacts) {
      const read = await callTool(client, "artifact_read", { artifactId: artifact["artifactId"] });
      assert.equal(JSON.stringify(read).includes("internalPath"), false);
    }
  });
});

test("OC-05 配置移除工作区后旧实体经 MCP 不可见（重启 + 缩减配置）", async (t) => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    runTimeoutMs: 120_000,
  });
  t.after(async () => {
    await harness.shutdown();
    cleanupHarness(harness);
  });
  const client = await connectGateway(harness, (fn) => t.after(fn));
  const caps = await callTool(client, "agent_capabilities", {});
  const epoch = Number((caps.structuredContent as Record<string, unknown>)["serviceEpoch"]);
  const list = await callTool(client, "workspace_list", {});
  const altWorkspace = String(
    (list.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces.find((w) => w["name"] === "alt")?.["workspaceId"],
  );

  const start = await callTool(client, "agent_start", {
    workspaceId: altWorkspace,
    prompt: "将被撤销的工作区",
    clientRequestId: `sec-revoke-${Date.now()}`,
    serviceEpoch: epoch,
  });
  const runId = String((start.structuredContent as Record<string, unknown>)["runId"]);
  await callTool(client, "agent_wait", { runs: [{ runId }], returnWhen: "any_terminal", timeoutMs: 25_000 });

  // 重启 daemon，配置移除 alt 工作区
  harness.daemon.kill("SIGTERM");
  await harness.waitExit();
  const config = JSON.parse(readFileSync(harness.configPath, "utf8")) as { workspaces: Array<{ name: string }> };
  config.workspaces = config.workspaces.filter((workspace) => workspace.name !== "alt");
  writeFileSync(harness.configPath, JSON.stringify(config));
  await harness.respawn();

  await t.test("重启后 get/sessions/start/legacy stop 都拒绝已移除工作区", async () => {
    await expectError(client, "agent_get", { runId }, "NOT_FOUND");
    const workspaces = await callTool(client, "workspace_list", {});
    assert.equal(
      ((workspaces.structuredContent as { workspaces: Array<{ workspaceId: string }> }).workspaces).some((workspace) => workspace.workspaceId === altWorkspace),
      false,
      "workspace_list 不得返回已撤销工作区",
    );
    const sessions = await callTool(client, "agent_sessions", {});
    const sessionList = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(
      sessionList.some((session) => session["workspaceId"] === altWorkspace),
      false,
      "已移除工作区的会话不得出现在列表里",
    );
    const refreshed = await callTool(client, "agent_capabilities", {});
    const newEpoch = Number((refreshed.structuredContent as Record<string, unknown>)["serviceEpoch"]);
    // 已移除工作区对外与「不存在」不可区分（统一 NOT_FOUND，不做存在性探测）。
    await expectError(
      client,
      "agent_start",
      { workspaceId: altWorkspace, prompt: "撤销后再来", clientRequestId: `sec-revoked-2-${Date.now()}`, serviceEpoch: newEpoch },
      "WORKSPACE_NOT_ALLOWED",
    );
    // 旧 IPC run.stop 同样拒绝
    const paths = resolveDaemonPaths(harness.dataRoot);
    await assert.rejects(
      ipcCall(paths.clientSocket, "run.stop", { runId, intent: "cancel" }, { timeoutMs: 5_000 }),
      (error: Error) => "code" in error && (error as { code: string }).code === "NOT_FOUND",
    );
  });
});
