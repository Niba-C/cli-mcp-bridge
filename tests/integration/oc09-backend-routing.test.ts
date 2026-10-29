/**
 * OC-09-05：三后端 MCP→IPC→daemon→后端接线（B01/B02/B04/B05 核心）。
 *
 * 链路：run.start（带 backend）→ daemon 受理（backend 解析/冲突/继承）→
 * scheduler 派发 → 注册表工厂 → SDK adapter → 独占 worker → fake SDK
 * （真实子进程边界）。CodeBuddy/Qoder 后端的 run 真实落到 fake worker；
 * OpenCode fake 链路继续由既有套件覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupHarness, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";

const CB_FAKE = fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url));
const QD_FAKE = fileURLToPath(new URL("../fixtures/qoder-fake-sdk.mjs", import.meta.url));
const NODE = process.execPath;

const harnesses: DaemonHarness[] = [];

/** fake SDK log lives under dataRoot/backends/backend-id/ses-XXX (session dir is dynamic). */
function readFakeLog(dataRoot: string, backend: "codebuddy" | "qoder", file: string): Record<string, unknown> {
  const dir = join(dataRoot, "backends", backend);
  const sessionDir = readdirSync(dir).find((entry) => entry.startsWith("ses-"));
  if (sessionDir === undefined) throw new Error(`fake log missing: no session dir under ${dir}`);
  return JSON.parse(readFileSync(join(dir, sessionDir, file), "utf8")) as Record<string, unknown>;
}

async function newHarness(options: Parameters<typeof startDaemon>[0]): Promise<DaemonHarness> {
  const harness = await startDaemon(options);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) {
      // 先关停自己启动的 daemon（SDK worker 由 daemon 回收），再删目录；
      // 只删目录会让子进程继续持有 runner 的管道并挂住进程。
      await harness.shutdown();
      cleanupHarness(harness);
    }
  }
});

test("OC-09-05：codebuddy run 经 daemon→工厂→worker→fake SDK 全链路完成（显式 backend）", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
    },
  });
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-cb-e2e-1",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(started["reused"], false);
  assert.equal(started["state"], "completed", JSON.stringify(started));
  assert.equal(started["backendId"], "codebuddy", "回执应带后端归属");
  assert.equal(started["selectedModel"], "glm-5.3");

  // fake SDK 收到任务与模型（真实子进程边界完成）。
  const captured = readFakeLog(harness.dataRoot, "codebuddy", "fake-sdk.json");
  assert.equal(captured["model"], "glm-5.3");
  assert.match(String(captured["pathToCodebuddyCode"]), /codebuddy\.exe$/);

  // 结果清单可读（agentReported 来自 fake result）。
  const result = (await harness.client("run.result", { runId: started["runId"] })) as Record<string, unknown>;
  const agentReported = result["agentReported"] as readonly string[];
  assert.ok(agentReported.some((text) => text.includes("FAKE 结果")), JSON.stringify(result));
});

test("OC-09-05：qoder run 全链路完成；同会话追问继承后端；跨后端拒绝", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      qoder: { executable: NODE, model: "qoder-max", fakeModule: QD_FAKE },
    },
  });
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-qd-e2e-1",
    backend: "qoder",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(started["state"], "completed", JSON.stringify(started));
  assert.equal(started["backendId"], "qoder");
  assert.equal(started["selectedModel"], "qoder-max");

  const sessionInfo = (await harness.client("run.get", { runId: started["runId"] })) as Record<string, unknown>;
  const sessionId = sessionInfo["sessionId"] as string;
  assert.match(sessionId, /^ses_/);

  const followup = (await harness.client("run.start", {
    sessionId,
    prompt: "SCENARIO:text 第二轮",
    clientRequestId: "oc09-qd-e2e-2",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(followup["state"], "completed");
  assert.equal(followup["backendId"], "qoder", "同会话省略 backend 继承原归属");

  await assert.rejects(
    harness.client("run.start", {
      sessionId,
      prompt: "跨后端",
      clientRequestId: "oc09-qd-e2e-3",
      backend: "codebuddy",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "INVALID_ARGUMENT" &&
      (error as { details?: { reason?: string } }).details?.reason === "backend_session_mismatch",
  );

  // 两轮 resume：第二轮 fake 收到首轮后端会话 ID。
  const captured = readFakeLog(harness.dataRoot, "qoder", "fake-qoder-sdk.json") as { resume: string | null };
  assert.equal(captured.resume, "qd-fake-session", "第二轮必须带首轮后端会话 ID 续接");
});

test("OC-09-05：未配置的 backend 拒绝受理；同 key 改 backend 幂等冲突；同参数重放", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
    },
  });
  // qoder 未配置：PROFILE_NOT_ALLOWED。
  await assert.rejects(
    harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "x",
      clientRequestId: "oc09-miss-1",
      backend: "qoder",
    }),
    (error: unknown) => (error as { code?: string }).code === "PROFILE_NOT_ALLOWED" && /未配置/.test((error as Error).message),
  );

  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-idem-1",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["state"], "completed");

  // 同 key 显式改 backend（codebuddy→opencode）：IDEMPOTENCY_CONFLICT。
  await assert.rejects(
    harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-idem-1",
      backend: "opencode",
    }),
    (error: unknown) => error instanceof Error && /已绑定其它后端/.test(error.message),
  );

  // 同 key 同参数重试：原 run 重放（不二次执行）。
  const retry = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-idem-1",
    backend: "codebuddy",
  })) as Record<string, unknown>;
  assert.equal(retry["reused"], true);
  assert.equal(retry["runId"], first["runId"]);
});

test("OC-09-05：修改默认后端并禁用原后端后，原 key 仍重放原回执，不重新派发", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
      qoder: { executable: NODE, model: "qoder-max", fakeModule: QD_FAKE },
    },
    defaultBackend: "codebuddy",
  });
  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-default-change-1",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["state"], "completed", JSON.stringify(first));
  assert.equal(first["backendId"], "codebuddy");

  // 停机改配置：默认后端换成 qoder，并禁用 codebuddy。
  await harness.shutdown();
  const config = JSON.parse(readFileSync(harness.configPath, "utf8")) as Record<string, unknown>;
  config["defaultBackend"] = "qoder";
  (config["backends"] as Record<string, Record<string, unknown>>)["codebuddy"]!["enabled"] = false;
  writeFileSync(harness.configPath, `${JSON.stringify(config)}\n`);
  await harness.respawn(30_000);

  // 原 key、原参数：重放原回执，不因后端已禁用而改投/重执行。
  const replay = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-default-change-1",
    backend: "codebuddy",
  })) as Record<string, unknown>;
  assert.equal(replay["reused"], true);
  assert.equal(replay["runId"], first["runId"]);
  assert.equal(replay["backendId"], "codebuddy");

  // 新 key 选择已禁用后端：明确拒绝，不回退默认后端。
  await assert.rejects(
    harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-default-change-2",
      backend: "codebuddy",
    }),
    (error: unknown) => (error as { code?: string }).code === "PROFILE_NOT_ALLOWED",
  );

  // 新会话省略 backend：采用新的默认后端 qoder。
  const fresh = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-default-change-3",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(fresh["state"], "completed", JSON.stringify(fresh));
  assert.equal(fresh["backendId"], "qoder");
});

test("OC-09-07 / B03：CodeBuddy 完成一轮后 daemon 重启，同会话带原生 resume 续接", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
    },
  });
  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text 第一轮",
    clientRequestId: "oc09-b03-restart-1",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["state"], "completed", JSON.stringify(first));
  const sessionId = ((await harness.client("run.get", { runId: first["runId"] })) as Record<string, unknown>)["sessionId"] as string;

  // 正常完成后 worker 随 daemon 关停；重启后同会话必须加载原受控目录并 resume 原生会话。
  await harness.shutdown();
  await harness.respawn(30_000);
  const second = (await harness.client("run.start", {
    sessionId,
    prompt: "SCENARIO:text 第二轮",
    clientRequestId: "oc09-b03-restart-2",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(second["state"], "completed", JSON.stringify(second));
  assert.equal(second["backendId"], "codebuddy");

  const captured = readFakeLog(harness.dataRoot, "codebuddy", "fake-sdk.json");
  assert.equal(captured["prompt"], "SCENARIO:text 第二轮", "重启后只执行新 prompt");
  assert.equal(captured["resume"], "cb-fake-session", "重启后同会话必须带首轮原生 ID 续接");
});

test("OC-09-07 / B05：CodeBuddy 同会话换到另一允许模型，fake 实际收到新 ID", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: {
        executable: NODE,
        model: "glm-5.3",
        models: ["glm-5.3", "glm-5.4"],
        fakeModule: CB_FAKE,
      },
    },
  });
  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text 第一轮",
    clientRequestId: "oc09-b05-switch-1",
    backend: "codebuddy",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["state"], "completed", JSON.stringify(first));
  assert.equal(first["selectedModel"], "glm-5.3");
  assert.equal(readFakeLog(harness.dataRoot, "codebuddy", "fake-sdk.json")["model"], "glm-5.3");
  const sessionId = ((await harness.client("run.get", { runId: first["runId"] })) as Record<string, unknown>)["sessionId"] as string;

  const second = (await harness.client("run.start", {
    sessionId,
    prompt: "SCENARIO:text 第二轮",
    clientRequestId: "oc09-b05-switch-2",
    backend: "codebuddy",
    model: "glm-5.4",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(second["state"], "completed", JSON.stringify(second));
  assert.equal(second["selectedModel"], "glm-5.4", "同会话显式换到另一允许模型");
  const secondInfo = (await harness.client("run.get", { runId: second["runId"] })) as Record<string, unknown>;
  assert.equal(secondInfo["observedModel"], "glm-5.4", "本轮实际模型身份");
  assert.equal(secondInfo["sessionId"], sessionId, "换模型保留产品会话");
  const captured = readFakeLog(harness.dataRoot, "codebuddy", "fake-sdk.json");
  assert.equal(captured["model"], "glm-5.4", "fake SDK 必须实际收到新模型 ID");
  assert.equal(captured["resume"], "cb-fake-session", "换模型保留原生会话并续接");
});

test("OC-09-07 / B05：Qoder 同会话换到另一允许模型，fake 实际收到新 ID", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      qoder: {
        executable: NODE,
        model: "qoder-max",
        models: ["qoder-max", "qoder-next"],
        fakeModule: QD_FAKE,
      },
    },
  });
  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text 第一轮",
    clientRequestId: "oc09-b05-qd-1",
    backend: "qoder",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["selectedModel"], "qoder-max");
  const sessionId = ((await harness.client("run.get", { runId: first["runId"] })) as Record<string, unknown>)["sessionId"] as string;

  const second = (await harness.client("run.start", {
    sessionId,
    prompt: "SCENARIO:text 第二轮",
    clientRequestId: "oc09-b05-qd-2",
    backend: "qoder",
    model: "qoder-next",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(second["state"], "completed", JSON.stringify(second));
  assert.equal(second["selectedModel"], "qoder-next");
  const secondInfo = (await harness.client("run.get", { runId: second["runId"] })) as Record<string, unknown>;
  assert.equal(secondInfo["observedModel"], "qoder-next", "本轮 assistant 身份优先于旧 modelUsage");
  assert.equal(secondInfo["sessionId"], sessionId);
  const captured = readFakeLog(harness.dataRoot, "qoder", "fake-qoder-sdk.json");
  assert.equal(captured["model"], "qoder-next", "fake SDK 必须实际收到新模型 ID");
  assert.equal(captured["resume"], "qd-fake-session");
});

test("OC-09-05：codebuddy 会话换到未允许模型被拒（B05 边界）", async () => {
  const harness = await newHarness({
    scenario: "text-happy",
    sdkBackends: {
      codebuddy: { executable: NODE, model: "glm-5.3", fakeModule: CB_FAKE },
    },
  });
  const first = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "SCENARIO:text",
    clientRequestId: "oc09-cb-model-1",
    backend: "codebuddy",
    model: "glm-5.3",
    waitMs: 25_000,
  })) as Record<string, unknown>;
  assert.equal(first["state"], "completed");

  const sessionInfo = (await harness.client("run.get", { runId: first["runId"] })) as Record<string, unknown>;
  await assert.rejects(
    harness.client("run.start", {
      sessionId: sessionInfo["sessionId"],
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-cb-model-2",
      model: "not-allowed-model",
    }),
    (error: unknown) => error instanceof Error && /允许列表/.test(error.message),
  );
});
