/**
 * OC-08 集成测试：MCP/IPC 面的模型选择贯通到 fake HTTP 的实际派发。
 *
 * 链路与生产一致：client IPC → daemon 受理（解析/继承/允许列表）→ 调度 →
 * coordinator → adapter → fake OpenCode HTTP。fake 的请求日志记录每次
 * prompt_async 实际携带的 provider/model，据此断言「按指定值派发」。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupHarness, CLI_MAIN, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";

const MODEL_PROFILES = {
  default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
  "minimax-m3": { providerID: "minimax", modelID: "MiniMax-M3" },
  deepseek: { providerID: "deepseek", modelID: "deepseek-chat" },
} as const;

const PROVIDER_CONFIG = {
  providers: {
    minimax: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "oc08-fake-minimax-key", baseURL: "http://127.0.0.1:1/v1" },
      models: { "MiniMax-M3.1-Flash": { name: "Flash" }, "MiniMax-M3": { name: "M3" } },
    },
    deepseek: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "oc08-fake-deepseek-key", baseURL: "http://127.0.0.1:1/v1" },
      models: { "deepseek-chat": { name: "chat" } },
    },
  },
};

interface PromptRecord {
  readonly model: { readonly providerID: string; readonly modelID: string };
}

function promptModels(harness: DaemonHarness): PromptRecord["model"][] {
  const lines = readFileSync(harness.paths.backendLog, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const models: PromptRecord["model"][] = [];
  for (const line of lines) {
    const entry = JSON.parse(line) as { route?: string; body?: { model?: PromptRecord["model"] } };
    if (entry.route?.endsWith("/prompt_async") && entry.body?.model !== undefined) {
      models.push(entry.body.model);
    }
  }
  return models;
}

async function startRun(
  harness: DaemonHarness,
  input: { clientRequestId: string; prompt: string; model?: string; sessionId?: string; workspace?: string },
): Promise<Record<string, unknown>> {
  return harness.client("run.start", {
    prompt: input.prompt,
    clientRequestId: input.clientRequestId,
    workspaceSlug: input.workspace ?? "main",
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    waitMs: 15_000,
  }, 40_000);
}

async function expectCode(harness: DaemonHarness, payload: Record<string, unknown>, code: string): Promise<void> {
  await assert.rejects(
    () => harness.client("run.start", payload, 10_000),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === code,
    `期望错误码 ${code}`,
  );
}

test("OC-08 模型选择：默认/显式/跨供应商/继承/幂等/重启（真实 daemon + fake HTTP）", async () => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    modelProfiles: MODEL_PROFILES,
    providerConfig: PROVIDER_CONFIG,
  });
  try {
    // ---- M01：capabilities 摘要来自本地配置；查询不启动 worker（backendLog 尚不存在）。
    const status = (await harness.operator("daemon.status", {}, 5_000)) as Record<string, unknown>;
    const models = status["models"] as { default: string; allowed: string[] };
    assert.equal(models.default, "minimax/MiniMax-M3.1-Flash");
    assert.deepEqual(models.allowed, ["deepseek/deepseek-chat", "minimax/MiniMax-M3", "minimax/MiniMax-M3.1-Flash"]);
    assert.equal(existsSync(harness.paths.backendLog), false, "查询不得启动 worker");

    // ---- 新会话省略 model：用 default。
    const runA = await startRun(harness, { clientRequestId: "oc08-a", prompt: "第一轮" });
    assert.equal(runA["state"], "completed");
    assert.equal(runA["selectedModel"], "minimax/MiniMax-M3.1-Flash");
    const modelsAfterA = promptModels(harness);
    assert.equal(modelsAfterA.length, 1);
    assert.deepEqual(modelsAfterA[0], { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" });

    // agent_get / observedModel：fake 回显请求模型，观测身份应与选定一致。
    const gotA = (await harness.client("run.get", { runId: runA["runId"] }, 5_000)) as Record<string, unknown>;
    assert.equal(gotA["selectedModel"], "minimax/MiniMax-M3.1-Flash");
    assert.equal(gotA["observedModel"], "minimax/MiniMax-M3.1-Flash");
    const sessionId = gotA["sessionId"] as string;

    // ---- M02：同供应商换模型 A→B。
    const runB = await startRun(harness, { clientRequestId: "oc08-b", prompt: "第二轮", sessionId, model: "minimax/MiniMax-M3" });
    assert.equal(runB["state"], "completed");
    assert.equal(runB["selectedModel"], "minimax/MiniMax-M3");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "minimax", modelID: "MiniMax-M3" });

    // ---- M03：省略 model 沿用会话最近选择（B），backendSessionId 上下文保留。
    const runC = await startRun(harness, { clientRequestId: "oc08-c", prompt: "第三轮", sessionId });
    assert.equal(runC["state"], "completed");
    assert.equal(runC["selectedModel"], "minimax/MiniMax-M3");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "minimax", modelID: "MiniMax-M3" });
    const sessions = (await harness.client("session.list", {}, 5_000)) as {
      sessions: Array<{ sessionId: string; lastSelectedModel: string | null }>;
    };
    assert.equal(sessions.sessions.find((item) => item.sessionId === sessionId)?.lastSelectedModel, "minimax/MiniMax-M3");

    // ---- M02：跨供应商模型 C。
    const runD = await startRun(harness, { clientRequestId: "oc08-d", prompt: "第四轮", sessionId, model: "deepseek/deepseek-chat" });
    assert.equal(runD["state"], "completed");
    assert.equal(runD["selectedModel"], "deepseek/deepseek-chat");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "deepseek", modelID: "deepseek-chat" });

    // ---- M04：同 key 同模型重试不重复派发。
    const promptCountBefore = promptModels(harness).length;
    const retryD = await startRun(harness, { clientRequestId: "oc08-d", prompt: "第四轮", sessionId, model: "deepseek/deepseek-chat" });
    assert.equal(retryD["reused"], true);
    assert.equal(retryD["runId"], runD["runId"]);
    assert.equal(promptModels(harness).length, promptCountBefore, "重试不得再次派发");
    // 同 key 显式换模型：冲突。
    await expectCode(
      harness,
      { prompt: "第四轮", clientRequestId: "oc08-d", sessionId, workspaceSlug: "main", model: "minimax/MiniMax-M3.1-Flash", waitMs: 1 },
      "IDEMPOTENCY_CONFLICT",
    );

    // ---- M06：非法格式 / 不在允许列表。
    await expectCode(
      harness,
      { prompt: "x", clientRequestId: "oc08-bad-format", workspaceSlug: "main", model: "not a ref", waitMs: 1 },
      "INVALID_ARGUMENT",
    );
    await expectCode(
      harness,
      { prompt: "x", clientRequestId: "oc08-bad-allowed", workspaceSlug: "main", model: "openai/gpt-4", waitMs: 1 },
      "PROFILE_NOT_ALLOWED",
    );

    // ---- M07（跨工作区部分）：另一工作区会话选择不同模型，不互相改写。
    // 注：同工作区多会话受 fake 夹具限制（POST /session 恒返回同一后端会话 ID，
    // 无法表达第二个同工作区会话），该项保持未验证——见实施记录「未验证范围」。
    const altRun = await startRun(harness, { clientRequestId: "oc08-alt", prompt: "alt 轮", workspace: "alt", model: "minimax/MiniMax-M3" });
    assert.equal(altRun["selectedModel"], "minimax/MiniMax-M3");
    const altGot = (await harness.client("run.get", { runId: altRun["runId"] }, 5_000)) as Record<string, unknown>;
    const altSessionId = altGot["sessionId"] as string;
    const sessionsAfterAlt = (await harness.client("session.list", {}, 5_000)) as {
      sessions: Array<{ sessionId: string; lastSelectedModel: string | null }>;
    };
    const mainSession = sessionsAfterAlt.sessions.find((item) => item.sessionId === sessionId);
    const altSession = sessionsAfterAlt.sessions.find((item) => item.sessionId === altSessionId);
    assert.equal(mainSession?.lastSelectedModel, "deepseek/deepseek-chat", "main 会话选择不被 alt 会话改写");
    assert.equal(altSession?.lastSelectedModel, "minimax/MiniMax-M3");

    // ---- M05：daemon 重启保留模型、回执与会话最近选择；恢复后省略 model 沿用。
    await harness.respawn(30_000);
    const gotD = (await harness.client("run.get", { runId: runD["runId"] }, 5_000)) as Record<string, unknown>;
    assert.equal(gotD["selectedModel"], "deepseek/deepseek-chat");
    assert.equal(gotD["observedModel"], "deepseek/deepseek-chat");
    // ---- M04：重启后重试「省略 model」的旧 key（oc08-c 原选 M3）：
    // 必须重放首次回执（selectedModel=M3），且不改写会话当前选择（deepseek）。
    const promptsBeforeRetry = promptModels(harness).length;
    const retryC = await startRun(harness, { clientRequestId: "oc08-c", prompt: "第三轮", sessionId });
    assert.equal(retryC["reused"], true);
    assert.equal(retryC["selectedModel"], "minimax/MiniMax-M3");
    assert.equal(promptModels(harness).length, promptsBeforeRetry, "重试不得再次派发");
    const sessionsAfterRetry = (await harness.client("session.list", {}, 5_000)) as {
      sessions: Array<{ sessionId: string; lastSelectedModel: string | null }>;
    };
    assert.equal(
      sessionsAfterRetry.sessions.find((item) => item.sessionId === sessionId)?.lastSelectedModel,
      "deepseek/deepseek-chat",
      "重放不改写会话当前选择",
    );
    const runE = await startRun(harness, { clientRequestId: "oc08-e", prompt: "重启后一轮", sessionId });
    assert.equal(runE["state"], "completed");
    assert.equal(runE["selectedModel"], "deepseek/deepseek-chat", "重启后继承会话最近选择");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "deepseek", modelID: "deepseek-chat" });
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

test("OC-08 登记但缺凭据的供应商：派发前明确 failed，不阻塞会话、不回退默认模型", async () => {
  // 配置登记 deepseek，但供应商文件只有 minimax：受理合法（允许列表来自配置），
  // 派发时才发现该供应商未连接。必须收敛为 failed（确定未发送），session 不阻塞，
  // 且不得静默改用 default——同会话下一轮显式选允许模型可继续。
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    modelProfiles: {
      default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
      deepseek: { providerID: "deepseek", modelID: "deepseek-chat" },
    },
    providerConfig: {
      options: { apiKey: "oc08-fake-minimax-key", baseURL: "http://127.0.0.1:1/v1" },
      models: { "MiniMax-M3.1-Flash": { name: "Flash" } },
    },
  });
  try {
    const failedRun = await startRun(harness, { clientRequestId: "oc08-nocred-1", prompt: "选缺凭据供应商", model: "deepseek/deepseek-chat" });
    assert.equal(failedRun["state"], "failed", "缺凭据必须是明确失败，不是 unknown");
    assert.equal(failedRun["selectedModel"], "deepseek/deepseek-chat");
    const got = (await harness.client("run.get", { runId: failedRun["runId"] }, 5_000)) as Record<string, unknown>;
    assert.equal(got["observedModel"], null);
    const sessionId = got["sessionId"] as string;
    const sessions = (await harness.client("session.list", {}, 5_000)) as {
      sessions: Array<{ sessionId: string; state: string; blockedReason: string | null }>;
    };
    const session = sessions.sessions.find((item) => item.sessionId === sessionId);
    assert.equal(session?.state, "idle", "确定未发送的失败不阻塞会话");
    assert.equal(session?.blockedReason, null);
    const prompts = promptModels(harness);
    assert.equal(prompts.length, 0, "缺凭据供应商没有任何 HTTP 派发");
    // 下一轮显式选允许的模型可继续（无备用模型自动顶替）。
    const recover = await startRun(harness, { clientRequestId: "oc08-nocred-2", prompt: "显式换回", sessionId, model: "minimax/MiniMax-M3.1-Flash" });
    assert.equal(recover["state"], "completed");
    assert.equal(recover["selectedModel"], "minimax/MiniMax-M3.1-Flash");
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

test("OC-08 会话上次选择被移出允许列表后：省略 model 报错，不静默替换", async () => {
  // 单独一个 daemon：先选 deepseek，随后用只剩 minimax 的配置重启，
  // 同会话省略 model 必须 PROFILE_NOT_ALLOWED；显式选择仍允许的模型可继续。
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    modelProfiles: MODEL_PROFILES,
    providerConfig: PROVIDER_CONFIG,
  });
  try {
    const first = await startRun(harness, { clientRequestId: "oc08-shrink-1", prompt: "选 deepseek", model: "deepseek/deepseek-chat" });
    assert.equal(first["state"], "completed");
    const firstGot = (await harness.client("run.get", { runId: first["runId"] }, 5_000)) as Record<string, unknown>;
    const sessionId = firstGot["sessionId"] as string;

    // 收缩配置：只留 minimax。先停旧 daemon（实例锁），改配置文件后重启。
    await harness.shutdown();
    const { readFileSync: read, writeFileSync: write } = await import("node:fs");
    const config = JSON.parse(read(harness.configPath, "utf8")) as Record<string, unknown>;
    const backend = (config["backends"] as Record<string, Record<string, unknown>>)["opencode"]!;
    backend["modelProfiles"] = { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } };
    write(harness.configPath, `${JSON.stringify(config)}\n`);
    await harness.respawn(30_000);

    await expectCode(
      harness,
      { prompt: "继承已移除的模型", clientRequestId: "oc08-shrink-2", sessionId, workspaceSlug: "main", waitMs: 1 },
      "PROFILE_NOT_ALLOWED",
    );
    // ---- M04：配置收缩 + 重启后，重试「省略 model」的旧 key（原显式 deepseek）：
    // 重放首次回执（selectedModel=deepseek），不改写会话选择，也不再派发。
    const shrinkRetry = await startRun(harness, { clientRequestId: "oc08-shrink-1", prompt: "选 deepseek", sessionId });
    assert.equal(shrinkRetry["reused"], true);
    assert.equal(shrinkRetry["selectedModel"], "deepseek/deepseek-chat");
    const shrinkSessions = (await harness.client("session.list", {}, 5_000)) as {
      sessions: Array<{ sessionId: string; lastSelectedModel: string | null }>;
    };
    assert.equal(
      shrinkSessions.sessions.find((item) => item.sessionId === sessionId)?.lastSelectedModel,
      "deepseek/deepseek-chat",
    );
    const explicit = await startRun(harness, { clientRequestId: "oc08-shrink-3", prompt: "显式换回允许模型", sessionId, model: "minimax/MiniMax-M3.1-Flash" });
    assert.equal(explicit["state"], "completed");
    assert.equal(explicit["selectedModel"], "minimax/MiniMax-M3.1-Flash");
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

/** 把文件库降回 v3 形状（删 v4 迁移记录与三个模型列），用于真实 v3→v4 升级回归。 */
function downgradeToV3(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  db.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
  db.exec("ALTER TABLE runs DROP COLUMN selected_model");
  db.exec("ALTER TABLE runs DROP COLUMN observed_model");
  db.exec("ALTER TABLE sessions DROP COLUMN last_selected_model");
  db.exec("COMMIT");
  db.close();
}

function rewriteDefault(harness: DaemonHarness, defaultRef: string, extra: Record<string, { providerID: string; modelID: string }>): void {
  const [defaultProvider, defaultModel] = defaultRef.split("/");
  const config = JSON.parse(readFileSync(harness.configPath, "utf8")) as Record<string, unknown>;
  const backend = (config["backends"] as Record<string, Record<string, unknown>>)["opencode"]!;
  backend["modelProfiles"] = {
    default: { providerID: defaultProvider, modelID: defaultModel },
    ...extra,
  };
  writeFileSync(harness.configPath, `${JSON.stringify(config)}\n`);
}

test("OC-08 真实 v3→v4 升级后改 default：旧会话继承固定 MiniMax，新会话才用新 default", async () => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    modelProfiles: MODEL_PROFILES,
    providerConfig: PROVIDER_CONFIG,
  });
  try {
    // v4 时代的旧会话：省略 model → 当时的 default（Flash）。
    const first = await startRun(harness, { clientRequestId: "oc08-v3-1", prompt: "升级前一轮" });
    assert.equal(first["state"], "completed");
    assert.equal(first["selectedModel"], "minimax/MiniMax-M3.1-Flash");
    const sessionId = ((await harness.client("run.get", { runId: first["runId"] }, 5_000)) as Record<string, unknown>)["sessionId"] as string;

    // 停机后把库降回 v3 形状（真实升级起点：无模型列、迁移记录止于 v3），
    // 再把 default 改成 deepseek 并重启——daemon 原地迁移 v3→v4。
    await harness.shutdown();
    downgradeToV3(join(harness.dataRoot, "data", "opencode-bridge.sqlite"));
    rewriteDefault(harness, "deepseek/deepseek-chat", {
      "minimax-flash": { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    });
    await harness.respawn(30_000);

    // 旧会话省略 model：必须继承「最近一次已受理」的固定 MiniMax 身份，
    // 不能因为 default 改成 deepseek 就换模型/换供应商。
    const legacyRun = await startRun(harness, { clientRequestId: "oc08-v3-2", prompt: "升级后继承", sessionId });
    assert.equal(legacyRun["state"], "completed");
    assert.equal(legacyRun["selectedModel"], "minimax/MiniMax-M3.1-Flash", "旧会话继承历史身份，不采用新 default");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" });

    // 真正的新会话（从未受理过）省略 model 才使用新 default。放在另一工作区：
    // fake 的 POST /session 恒返回同一后端会话 ID，同工作区第二个会话会在
    // 绑定唯一性上撞夹具限制（复核已记录）；跨工作区 worker 独立，不受影响。
    const freshRun = await startRun(harness, { clientRequestId: "oc08-v3-3", prompt: "新会话用新 default", workspace: "alt" });
    assert.equal(freshRun["state"], "completed");
    assert.equal(freshRun["selectedModel"], "deepseek/deepseek-chat");

    // 继承值被移出允许列表：明确拒绝，不自动换模型。
    await harness.shutdown();
    rewriteDefault(harness, "deepseek/deepseek-chat", {});
    await harness.respawn(30_000);
    await expectCode(
      harness,
      { prompt: "继承已移除的模型", clientRequestId: "oc08-v3-4", sessionId, workspaceSlug: "main", waitMs: 1 },
      "PROFILE_NOT_ALLOWED",
    );
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

test("OC-08 MCP SDK 全链路：capabilities.models、agent_get/agent_result 的模型字段", async () => {
  const harness = await startDaemon({
    scenario: "text-happy-repeat",
    modelProfiles: MODEL_PROFILES,
    providerConfig: PROVIDER_CONFIG,
  });
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot],
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const client = new Client({ name: "oc08-sdk-test", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await client.callTool({ name, arguments: args })) as Record<string, unknown>;

    // capabilities：模型摘要经 MCP 可见（查询不启动 worker）。
    const caps = (await call("agent_capabilities", {})) as { structuredContent?: Record<string, unknown> };
    const models = caps.structuredContent?.["models"] as { default: string; allowed: string[] };
    assert.equal(models.default, "minimax/MiniMax-M3.1-Flash");
    assert.deepEqual(models.allowed, ["deepseek/deepseek-chat", "minimax/MiniMax-M3", "minimax/MiniMax-M3.1-Flash"]);

    const workspaceList = (await call("workspace_list", {})) as { structuredContent?: { workspaces: Array<{ workspaceId: string }> } };
    const workspaceId = workspaceList.structuredContent?.workspaces[0]?.workspaceId as string;
    const status = (await harness.client("ping", {}, 5_000)) as { serviceEpoch: number };

    // 同供应商换模型 → agent_get 与 agent_result 都带选定/观测模型（P2 修复验证）。
    const startB = (await call("agent_start", {
      workspaceId,
      prompt: "SDK 轮 B",
      clientRequestId: "oc08-sdk-b",
      serviceEpoch: status.serviceEpoch,
      model: "minimax/MiniMax-M3",
    })) as { structuredContent?: { runId: string; selectedModel: string } };
    const runB = startB.structuredContent;
    assert.equal(runB?.selectedModel, "minimax/MiniMax-M3");
    await call("agent_wait", { runs: [{ runId: runB?.runId }], returnWhen: "any_terminal", timeoutMs: 20_000 });
    const gotB = (await call("agent_get", { runId: runB?.runId })) as { structuredContent?: Record<string, unknown> };
    assert.equal(gotB.structuredContent?.["selectedModel"], "minimax/MiniMax-M3");
    assert.equal(gotB.structuredContent?.["observedModel"], "minimax/MiniMax-M3");
    const resultB = (await call("agent_result", { runId: runB?.runId })) as { structuredContent?: Record<string, unknown> };
    assert.equal(resultB.structuredContent?.["selectedModel"], "minimax/MiniMax-M3", "agent_result 必须返回 selectedModel");
    assert.equal(resultB.structuredContent?.["observedModel"], "minimax/MiniMax-M3", "agent_result 必须返回 observedModel");

    // 跨供应商（同一会话显式切换；fake 单后端会话限制下不能另开同工作区新会话）→
    // 结果接口同样携带派发身份。
    const startC = (await call("agent_start", {
      workspaceId,
      prompt: "SDK 轮 C",
      clientRequestId: "oc08-sdk-c",
      serviceEpoch: status.serviceEpoch,
      sessionId: gotB.structuredContent?.["sessionId"],
      model: "deepseek/deepseek-chat",
    })) as { structuredContent?: { runId: string } };
    await call("agent_wait", { runs: [{ runId: startC.structuredContent?.runId }], returnWhen: "any_terminal", timeoutMs: 20_000 });
    const resultC = (await call("agent_result", { runId: startC.structuredContent?.runId })) as { structuredContent?: Record<string, unknown> };
    assert.equal(resultC.structuredContent?.["selectedModel"], "deepseek/deepseek-chat");
    assert.equal(resultC.structuredContent?.["observedModel"], "deepseek/deepseek-chat");
    assert.deepEqual(promptModels(harness).at(-1), { providerID: "deepseek", modelID: "deepseek-chat" });

    // 同 key 同模型重试：MCP 面重放，不重复派发。
    const promptsBefore = promptModels(harness).length;
    const retryC = (await call("agent_start", {
      workspaceId,
      prompt: "SDK 轮 C",
      clientRequestId: "oc08-sdk-c",
      serviceEpoch: status.serviceEpoch,
      model: "deepseek/deepseek-chat",
    })) as { structuredContent?: { runId: string; reused: boolean } };
    assert.equal(retryC.structuredContent?.reused, true);
    assert.equal(retryC.structuredContent?.runId, startC.structuredContent?.runId);
    assert.equal(promptModels(harness).length, promptsBefore, "MCP 重试不得再次派发");
  } finally {
    await client.close().catch(() => undefined);
    await harness.shutdown();
    cleanupHarness(harness);
  }
});
