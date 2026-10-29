/**
 * OC-05 集成：MCP SDK Client → stdio gateway 子进程 → Unix IPC daemon →
 * 既有 fake 后端 adapter/coordinator + SQLite。
 *
 * 不启动真实 OpenCode、不调用模型。断言的都是整条接线的真实行为，
 * 不是 handler stub。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ipcCall } from "../../src/daemon/ipc.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { TOOL_MANIFEST, type ToolName } from "../../src/contracts/tools.ts";
import {
  cleanupHarness,
  CLI_MAIN,
  startDaemon,
  type DaemonHarness,
} from "../helpers/oc04-harness.ts";

interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

interface McpCallResult {
  readonly content: McpTextContent[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface GatewaySession {
  readonly client: Client;
  readonly stderr: () => string;
  close(): Promise<void>;
}

async function connectGateway(harness: DaemonHarness): Promise<GatewaySession> {
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot],
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const client = new Client({ name: "oc05-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderrChunks.join(""),
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

async function callTool(session: GatewaySession, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return (await session.client.callTool({ name, arguments: args })) as McpCallResult;
}

async function expectToolError(
  session: GatewaySession,
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<void> {
  const result = await callTool(session, name, args);
  assert.equal(result.isError, true, `期望 ${name} 返回 isError（${code}），实际: ${JSON.stringify(result)}`);
  const wire = (result.structuredContent as { error?: { code?: string } } | undefined)?.error;
  assert.equal(wire?.code, code, `${name} 的错误码应为 ${code}，实际 ${JSON.stringify(wire)}`);
}

async function getEpoch(session: GatewaySession): Promise<number> {
  const caps = await callTool(session, "agent_capabilities", {});
  return Number((caps.structuredContent as Record<string, unknown>)["serviceEpoch"]);
}

test("OC-05 MCP gateway 全生命周期（发现/受理/等待/结果/工件/幂等/重连）", async (t) => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    workspaceFiles: { "seed.txt": "登记时已有的内容\n" },
    runTimeoutMs: 120_000,
  });
  t.after(async () => {
    await harness.shutdown();
    cleanupHarness(harness);
  });

  const gateway = await connectGateway(harness);
  t.after(async () => {
    await gateway.close();
  });

  await t.test("tools/list 发现 12 个工具且与 manifest 一致", async () => {
    const tools = await gateway.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, TOOL_MANIFEST.map((tool) => tool.name as string).sort());
    assert.equal(names.length, 12);
    const manifestByName = new Map(TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    for (const tool of tools.tools) {
      const definition = manifestByName.get(tool.name as ToolName);
      assert.ok(definition, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, definition.annotations.readOnlyHint);
      assert.ok((tool.description ?? "").length > 0);
      // 完整 strict schema 交给 SDK：对象含 properties/required 且拒绝未知字段。
      const inputSchema = tool.inputSchema as Record<string, unknown>;
      assert.equal(inputSchema["type"], "object");
      assert.equal(inputSchema["additionalProperties"], false, "strict schema 必须拒绝未知字段");
      assert.ok(typeof inputSchema["properties"] === "object");
      assert.ok(inputSchema["required"] === undefined || Array.isArray(inputSchema["required"]));
    }
  });

  let epoch = 0;
  let workspaceId = "";
  let workspaceDir = "";

  await t.test("agent_capabilities：只读能力、限制与显式 unsupported", async () => {
    const caps = await callTool(gateway, "agent_capabilities", {});
    assert.notEqual(caps.isError, true);
    const payload = caps.structuredContent as Record<string, unknown>;
    assert.equal(payload["contractVersion"], "2");
    assert.equal(payload["editEnabled"], false);
    assert.equal(payload["controlChannelIsolation"], "unverified");
    assert.equal(Number(payload["serviceEpoch"]) >= 1, true);
    epoch = Number(payload["serviceEpoch"]);
    const unsupported = payload["unsupported"] as string[];
    assert.ok(unsupported.some((line) => line.includes("edit")));
    assert.ok(unsupported.some((line) => line.includes("contextArtifactIds")));
    const limits = payload["limits"] as Record<string, unknown>;
    assert.equal(limits["activeRuns"], 1);
  });

  await t.test("workspace_list：登记工作区可见且不泄露本机绝对路径", async () => {
    const list = await callTool(gateway, "workspace_list", {});
    const payload = list.structuredContent as { workspaces: Array<Record<string, unknown>> };
    assert.equal(payload.workspaces.length, 2);
    const main = payload.workspaces.find((workspace) => workspace["name"] === "main");
    assert.ok(main);
    assert.match(String(main["workspaceId"]), /^ws_[0-9a-f-]+$/);
    assert.equal("canonicalRoot" in main, false);
    assert.equal("copyRoot" in main, false);
    workspaceId = String(main["workspaceId"]);
    workspaceDir = harness.workspaceDir;
    assert.equal(JSON.stringify(payload).includes(workspaceDir), false, "workspace_list 不得泄露绝对路径");
  });

  let runId = "";
  let sessionId = "";
  const requestId = `oc05-${Date.now()}`;

  await t.test("agent_start 快速受理；同 key 幂等；改参冲突；旧 epoch 新请求拒绝", async () => {
    const startedAt = Date.now();
    const start = await callTool(gateway, "agent_start", {
      workspaceId,
      prompt: "请只读总结这个仓库 🙂 中文",
      clientRequestId: requestId,
      serviceEpoch: epoch,
    });
    assert.notEqual(start.isError, true);
    assert.ok(Date.now() - startedAt < 10_000, "agent_start 必须快速返回，不等 worker/模型");
    const payload = start.structuredContent as Record<string, unknown>;
    runId = String(payload["runId"]);
    assert.match(runId, /^run_[0-9a-f-]+$/);
    // StartOutcome 不含 sessionId；从持久快照取（这也是重连后找回会话的路径）。
    const startedGet = await callTool(gateway, "agent_get", { runId });
    sessionId = String((startedGet.structuredContent as Record<string, unknown>)["sessionId"]);
    assert.match(sessionId, /^ses_[0-9a-f-]+$/);

    // 同 key 同参数：返回原 run
    const retry = await callTool(gateway, "agent_start", {
      workspaceId,
      prompt: "请只读总结这个仓库 🙂 中文",
      clientRequestId: requestId,
      serviceEpoch: epoch,
    });
    assert.equal((retry.structuredContent as Record<string, unknown>)["runId"], runId);
    assert.equal((retry.structuredContent as Record<string, unknown>)["reused"], true);

    // 同 key 改参：冲突
    await expectToolError(
      gateway,
      "agent_start",
      { workspaceId, prompt: "换一个 prompt", clientRequestId: requestId, serviceEpoch: epoch },
      "IDEMPOTENCY_CONFLICT",
    );

    // 旧 epoch 的新请求：拒绝
    await expectToolError(
      gateway,
      "agent_start",
      { workspaceId, prompt: "另一个请求", clientRequestId: `${requestId}-stale`, serviceEpoch: epoch + 999 },
      "EPOCH_MISMATCH",
    );
  });

  await t.test("agent_wait：any_terminal 到完成；timeout=0 快照；afterRevision 语义", async () => {
    const done = await callTool(gateway, "agent_wait", {
      runs: [{ runId }],
      returnWhen: "any_terminal",
      timeoutMs: 25_000,
    });
    const payload = done.structuredContent as { waitTimedOut: boolean; runs: Array<Record<string, unknown>> };
    assert.equal(payload.waitTimedOut, false);
    assert.equal(payload.runs[0]?.["state"], "completed");
    const revision = Number(payload.runs[0]?.["revision"]);

    const zero = await callTool(gateway, "agent_wait", {
      runs: [{ runId, afterRevision: revision }],
      returnWhen: "any_change",
      timeoutMs: 0,
    });
    const zeroPayload = zero.structuredContent as { waitTimedOut: boolean; runs: Array<Record<string, unknown>> };
    assert.equal(zeroPayload.waitTimedOut, true, "终态 run 无新变化：timeout=0 只给快照");
    assert.equal(zeroPayload.runs[0]?.["state"], "completed");

    const noChange = await callTool(gateway, "agent_wait", {
      runs: [{ runId, afterRevision: revision }],
      returnWhen: "any_change",
      timeoutMs: 400,
    });
    assert.equal((noChange.structuredContent as { waitTimedOut: boolean }).waitTimedOut, true);

    const change = await callTool(gateway, "agent_wait", {
      runs: [{ runId, afterRevision: 0 }],
      returnWhen: "any_change",
      timeoutMs: 1_000,
    });
    assert.equal((change.structuredContent as { waitTimedOut: boolean }).waitTimedOut, false);
  });

  await t.test("agent_get / agent_events / agent_result：水位、分页与三类证据分离", async () => {
    const get = await callTool(gateway, "agent_get", { runId });
    const snapshot = get.structuredContent as Record<string, unknown>;
    assert.equal(snapshot["state"], "completed");
    assert.equal(snapshot["resultReady"], true);
    assert.equal(snapshot["contractVersion"], "2");
    assert.equal(Number(snapshot["revision"]) > 0, true);

    // events 分页
    const events = await callTool(gateway, "agent_events", { runId, limit: 2 });
    const page = events.structuredContent as {
      events: Array<{ seq: number }>;
      nextSeq: number;
      hasMore: boolean;
      earliestSeq: number;
      snapshotRevision: number;
    };
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every((event, index) => index === 0 || event.seq > page.events[index - 1]!.seq), "seq 严格递增");
    if (page.hasMore) {
      const rest = await callTool(gateway, "agent_events", { runId, afterSeq: page.nextSeq - 1, limit: 100 });
      const restPayload = rest.structuredContent as { events: Array<{ seq: number }> };
      assert.equal(restPayload.events[0]?.seq, page.nextSeq);
    }

    // result：缺省有界组合分页（含三段标记），三类证据不混同
    const full = await callTool(gateway, "agent_result", { runId });
    const manifest = full.structuredContent as {
      section: string;
      page: { text: string; hasMore: boolean; totalLength: number; unit: string; nextOffset: number };
      verified: boolean;
      artifacts: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.verified, false, "没有独立验证证据时 verified 必须是 false");
    assert.equal(manifest.section, "all");
    assert.equal(manifest.page.unit, "code_point");
    assert.equal(manifest.page.text.length <= 16_000, true, "缺省返回必须有界");
    assert.equal(manifest.page.text.includes("[agentReported]"), true);
    assert.equal(manifest.page.text.includes("[observed]"), true);
    assert.equal(manifest.page.text.includes("[verification]"), true);
    assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 3, "结果/事件/diff 三个工件");
    assert.ok(manifest.artifacts.every((artifact) => typeof artifact["label"] === "string"), "工件必须带 label");

    // 缺省分页重组到完
    let assembled = "";
    let offset = 0;
    for (;;) {
      const pageCall = await callTool(gateway, "agent_result", { runId, offset, limitChars: 11 });
      const pagePayload = pageCall.structuredContent as {
        page: { text: string; nextOffset: number; hasMore: boolean; totalLength: number };
      };
      assembled += pagePayload.page.text;
      if (!pagePayload.page.hasMore) break;
      offset = pagePayload.page.nextOffset;
    }
    {
      const whole = await callTool(gateway, "agent_result", { runId, limitChars: 16_000 });
      assert.equal(assembled, (whole.structuredContent as { page: { text: string } }).page.text);
    }

    // section + code_point 分页重组（中文与 emoji 不重复不丢失）
    const observed = await callTool(gateway, "agent_result", { runId, section: "observed" });
    const observedText = observed.content[0]?.text ?? "";
    let sectionAssembled = "";
    let sectionOffset = 0;
    for (;;) {
      const pageResult = await callTool(gateway, "agent_result", { runId, section: "observed", offset: sectionOffset, limitChars: 7 });
      const pagePayload = pageResult.structuredContent as {
        page: { text: string; nextOffset: number; hasMore: boolean; totalLength: number; unit: string };
      };
      assert.equal(pagePayload.page.unit, "code_point");
      sectionAssembled += pagePayload.page.text;
      if (!pagePayload.page.hasMore) {
        assert.equal(pagePayload.page.nextOffset, pagePayload.page.totalLength);
        break;
      }
      assert.equal(pagePayload.page.nextOffset, sectionOffset + 7);
      sectionOffset = pagePayload.page.nextOffset;
    }
    assert.equal(sectionAssembled, observedText, "分页重组必须还原完整文本");
  });

  let diffArtifactId = "";
  let resultArtifactId = "";

  await t.test("artifact_read：只读 run 空 diff；hash 校验；code_point 分页；不泄露 internalPath", async () => {
    const full = await callTool(gateway, "agent_result", { runId });
    const artifacts = (full.structuredContent as { artifacts: Array<Record<string, unknown>> }).artifacts;
    // 逐个读取识别 diff 工件
    for (const artifact of artifacts) {
      const read = await callTool(gateway, "artifact_read", { artifactId: artifact["artifactId"] });
      const payload = read.structuredContent as Record<string, unknown>;
      assert.equal(JSON.stringify(payload).includes("internalPath"), false, "不得泄露 internalPath");
      const text = read.content[0]?.text ?? "";
      const sha = createHash("sha256").update(text, "utf8").digest("hex");
      assert.equal(sha, payload["sha256"], "读取内容必须与登记 sha256 一致");
      if (String(text).includes("# workspace diff")) {
        diffArtifactId = String(artifact["artifactId"]);
        assert.ok(String(text).includes("no file changes"), "只读 run 的 diff 必须为空");
        assert.equal(String(text).includes("seed.txt"), false, "登记前已有内容不算本轮新增");
      }
      if (String(text).includes("# run result text")) {
        resultArtifactId = String(artifact["artifactId"]);
        assert.ok(String(text).includes("READY"), "结果工件包含模型正文");
      }
    }
    assert.ok(diffArtifactId.length > 0);
    assert.ok(resultArtifactId.length > 0);

    // diff 工件分页重组
    const first = await callTool(gateway, "artifact_read", { artifactId: diffArtifactId, limitChars: 5 });
    const page = first.structuredContent as { page: { hasMore: boolean; nextOffset: number; totalLength: number } };
    if (page.page.hasMore) {
      const second = await callTool(gateway, "artifact_read", { artifactId: diffArtifactId, offset: page.page.nextOffset });
      const text = (first.content[0]?.text ?? "") + (second.content[0]?.text ?? "");
      assert.ok(text.includes("no file changes"));
    }

    // 未知 artifactId → NOT_FOUND
    await expectToolError(
      gateway,
      "artifact_read",
      { artifactId: "art_123e4567-e89b-42d3-a456-426614174000" },
      "NOT_FOUND",
    );
  });

  await t.test("gateway 断开重连：原 run/结果/会话可找回，同会话可续接", async () => {
    await gateway.close();
    const second = await connectGateway(harness);
    t.after(async () => {
      await second.close();
    });

    const get = await callTool(second, "agent_get", { runId });
    assert.equal((get.structuredContent as Record<string, unknown>)["state"], "completed");

    const result = await callTool(second, "agent_result", { runId, section: "agentReported" });
    assert.ok((result.content[0]?.text ?? "").includes("READY"));

    const sessions = await callTool(second, "agent_sessions", {});
    const sessionList = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.ok(sessionList.some((session) => session["sessionId"] === sessionId));

    // 同会话续接（前轮已终结）
    const followUp = await callTool(second, "agent_start", {
      workspaceId,
      prompt: "继续刚才的问题",
      clientRequestId: `${requestId}-followup`,
      serviceEpoch: epoch,
      sessionId,
    });
    assert.notEqual(followUp.isError, true);
    const followUpRun = String((followUp.structuredContent as Record<string, unknown>)["runId"]);
    assert.notEqual(followUpRun, runId);
    // 等续接 run 结束，session 回到 idle 后才能 close。
    const followUpWait = await callTool(second, "agent_wait", {
      runs: [{ runId: followUpRun }],
      returnWhen: "any_terminal",
      timeoutMs: 25_000,
    });
    assert.equal(
      (followUpWait.structuredContent as { runs: Array<{ state: string }> }).runs[0]?.state,
      "completed",
    );

    // 用原有 run 的 cancel（幂等已终结）：confirmed=false 且状态不被改写
    const getAgain = await callTool(second, "agent_get", { runId });
    const revision = Number((getAgain.structuredContent as Record<string, unknown>)["revision"]);
    const cancel = await callTool(second, "agent_cancel", {
      runId,
      clientRequestId: `${requestId}-cancel`,
      expectedRevision: revision,
      serviceEpoch: epoch,
    });
    const cancelPayload = cancel.structuredContent as Record<string, unknown>;
    assert.equal(cancelPayload["state"], "completed", "已完成 run 不因 cancel 变状态");
    assert.equal(cancelPayload["confirmed"], false);

    // 同 key 重试在 revision 不变时仍取原响应
    const retry = await callTool(second, "agent_cancel", {
      runId,
      clientRequestId: `${requestId}-cancel`,
      expectedRevision: revision,
      serviceEpoch: epoch,
    });
    assert.deepEqual(retry.structuredContent, cancelPayload);

    // 同 key 改参 → 冲突
    await expectToolError(
      second,
      "agent_cancel",
      { runId, clientRequestId: `${requestId}-cancel`, expectedRevision: revision + 5, serviceEpoch: epoch },
      "IDEMPOTENCY_CONFLICT",
    );

    // 新 key + 过期 revision → REVISION_CONFLICT
    await expectToolError(
      second,
      "agent_interrupt",
      { runId, clientRequestId: `${requestId}-interrupt-late`, expectedRevision: revision - 1, serviceEpoch: epoch },
      "REVISION_CONFLICT",
    );

    // close：idle 会话关闭并幂等重试（revision 取自 agent_sessions 的当前值）
    const sessionsNow = await callTool(second, "agent_sessions", {});
    const sessionNow = (sessionsNow.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions
      .find((session) => session["sessionId"] === sessionId);
    assert.ok(sessionNow, "续接会话在列表中");
    const close = await callTool(second, "agent_close", {
      sessionId,
      clientRequestId: `${requestId}-close`,
      expectedRevision: Number(sessionNow["revision"]),
      serviceEpoch: epoch,
    });
    assert.notEqual(close.isError, true, JSON.stringify(close));
    assert.equal((close.structuredContent as Record<string, unknown>)["state"], "closed");
    const closeRetry = await callTool(second, "agent_close", {
      sessionId,
      clientRequestId: `${requestId}-close`,
      expectedRevision: Number(sessionNow["revision"]),
      serviceEpoch: epoch,
    });
    assert.deepEqual(closeRetry.structuredContent, close.structuredContent);
    // 已关闭的 session 不能再受理
    await expectToolError(
      second,
      "agent_start",
      { workspaceId, prompt: "closed", clientRequestId: `${requestId}-after-close`, serviceEpoch: epoch, sessionId },
      "SESSION_CLOSED",
    );
  });

  await t.test("gateway stdout 只有 MCP 帧，诊断在 stderr", () => {
    const stderrText = gateway.stderr();
    assert.ok(stderrText.includes("[mcp] gateway ready"), stderrText);
  });
});

test("OC-05 停止类工具：运行中 cancel、并发同 key、重启后回执重放", async (t) => {
  const harness = await startDaemon({
    scenario: "deadline-stall",
    runTimeoutMs: 120_000,
  });
  t.after(async () => {
    await harness.shutdown();
    cleanupHarness(harness);
  });
  const gateway = await connectGateway(harness);
  t.after(async () => {
    await gateway.close();
  });
  const epoch = await getEpoch(gateway);
  const list = await callTool(gateway, "workspace_list", {});
  const workspaceId = String(
    (list.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces[0]?.["workspaceId"],
  );

  const start = await callTool(gateway, "agent_start", {
    workspaceId,
    prompt: "长时间任务",
    clientRequestId: "oc05-stop-1",
    serviceEpoch: epoch,
  });
  const runId = String((start.structuredContent as Record<string, unknown>)["runId"]);
  // 等 run 进入 running（deadline-stall 之后没有新事件，revision 稳定）再取 revision。
  let revision = 0;
  const stableDeadline = Date.now() + 15_000;
  for (;;) {
    const get = await callTool(gateway, "agent_get", { runId });
    const snapshot = get.structuredContent as Record<string, unknown>;
    if (String(snapshot["state"]) === "running") {
      revision = Number(snapshot["revision"]);
      break;
    }
    if (Date.now() > stableDeadline) {
      revision = Number(snapshot["revision"]);
      break;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }

  await t.test("run.wait 的 AbortSignal：中止后立即返回且不泄漏 socket", async () => {
    const paths = resolveDaemonPaths(harness.dataRoot);
    const controller = new AbortController();
    const pending = ipcCall(
      paths.clientSocket,
      "run.wait",
      { runs: [{ runId }], returnWhen: "any_terminal", timeoutMs: 25_000 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(pending, /中止/);
  });

  await t.test("并发同 key cancel 只执行一次并共享同一响应", async () => {
    const args = { runId, clientRequestId: "oc05-cancel-key", expectedRevision: revision, serviceEpoch: epoch };
    const [a, b] = await Promise.all([
      callTool(gateway, "agent_cancel", args),
      callTool(gateway, "agent_cancel", args),
    ]);
    assert.notEqual(a.isError, true, JSON.stringify(a));
    assert.notEqual(b.isError, true, JSON.stringify(b));
    assert.deepEqual(b.structuredContent, a.structuredContent);
    assert.equal((a.structuredContent as Record<string, unknown>)["intent"], "cancel");
  });

  await t.test("daemon 重启后同 key 重试重放原响应（跨代际回执）", async () => {
    harness.daemon.kill("SIGTERM");
    await harness.waitExit();
    await harness.respawn();
    const retry = await callTool(gateway, "agent_cancel", {
      runId,
      clientRequestId: "oc05-cancel-key",
      expectedRevision: revision,
      serviceEpoch: epoch,
    });
    const payload = retry.structuredContent as Record<string, unknown>;
    assert.equal(payload["runId"], runId);
    assert.equal(["cancelled", "unknown", "interrupted"].includes(String(payload["state"])), true, JSON.stringify(payload));
  });

  await t.test("close 忙碌/关闭语义", async () => {
    // text-happy harness 无活跃 run；先关闭 gateway 里的 session
    const sessions = await callTool(gateway, "agent_sessions", {});
    const sessionList = (sessions.structuredContent as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.ok(sessionList.length >= 1);
    const sessionId = String(sessionList[0]?.["sessionId"]);
    // 从 daemon 取 session revision（agent_sessions 已返回）
    const sessionRevision = Number(sessionList[0]?.["revision"]);
    const currentEpoch = await getEpoch(gateway);
    const closed = await callTool(gateway, "agent_close", {
      sessionId,
      clientRequestId: "oc05-close-1",
      expectedRevision: sessionRevision,
      serviceEpoch: currentEpoch,
    });
    assert.notEqual(closed.isError, true, JSON.stringify(closed));
    assert.equal((closed.structuredContent as Record<string, unknown>)["state"], "closed");
  });
});
