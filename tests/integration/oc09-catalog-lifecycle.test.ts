import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fetchOnlineModelCatalog, OnlineCatalogError } from "../../src/cli/model-catalog.ts";
import { isProcessAlive } from "../../src/core/proc.ts";

const SDK = fileURLToPath(new URL("../fixtures/oc09-catalog-lifecycle.mjs", import.meta.url));

async function scenario(id: string, backendId: "codebuddy" | "qoder", run: (root: string, log: () => Array<Record<string, unknown>>, input: Parameters<typeof fetchOnlineModelCatalog>[0]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "oc09-catalog-life-"));
  const logPath = join(root, "calls.jsonl");
  const authFile = join(root, "auth.json");
  writeFileSync(authFile, JSON.stringify({ accessToken: "offline-fake-token" }), { mode: 0o600 });
  const oldScenario = process.env["ZB_CATALOG_LIFECYCLE_SCENARIO"];
  const oldLog = process.env["ZB_CATALOG_LIFECYCLE_LOG"];
  process.env["ZB_CATALOG_LIFECYCLE_SCENARIO"] = id;
  process.env["ZB_CATALOG_LIFECYCLE_LOG"] = logPath;
  const log = (): Array<Record<string, unknown>> => existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  try {
    await run(root, log, { backendId, executable: process.execPath, authFile, testSdkModuleId: SDK, timeoutMs: 1_000 });
  } finally {
    for (const row of log()) {
      if (row["kind"] === "spawn") { try { process.kill(Number(row["pid"]), "SIGKILL"); } catch { /* 已退出 */ } }
    }
    if (oldScenario === undefined) delete process.env["ZB_CATALOG_LIFECYCLE_SCENARIO"]; else process.env["ZB_CATALOG_LIFECYCLE_SCENARIO"] = oldScenario;
    if (oldLog === undefined) delete process.env["ZB_CATALOG_LIFECYCLE_LOG"]; else process.env["ZB_CATALOG_LIFECYCLE_LOG"] = oldLog;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const backendId of ["codebuddy", "qoder"] as const) {
  test(`在线目录 ${backendId}：保留方法接收者并关闭目录 CLI`, async () => {
    await scenario("ok", backendId, async (_root, log, input) => {
      const result = await fetchOnlineModelCatalog(input);
      assert.deepEqual(result.models, ["lifecycle-model"]);
      assert.ok(log().some((row) => row["kind"] === "closed"), "SDK 清理方法必须真正执行");
      const pid = Number(log().find((row) => row["kind"] === "spawn")?.["pid"]);
      for (let i = 0; i < 20 && isProcessAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(isProcessAlive(pid), false, "返回目录后不得遗留 CLI");
    });
  });
}

test("在线目录 Qoder：启动认证失败也映射为稳定目录错误", async () => {
  await scenario("startup-auth", "qoder", async (_root, _log, input) => {
    await assert.rejects(fetchOnlineModelCatalog(input), (error: unknown) => error instanceof OnlineCatalogError && error.code === "auth");
  });
});

for (const [backendId, step] of [["codebuddy", "connect"], ["codebuddy", "query"], ["qoder", "start"], ["qoder", "query"], ["qoder", "cleanup"]] as const) {
  test(`在线目录 ${backendId}：${step} 卡死时有界退出并回收 CLI`, async () => {
    await scenario(`hang-${step}`, backendId, async (_root, log, input) => {
      const started = Date.now();
      await assert.rejects(fetchOnlineModelCatalog(input), (error: unknown) => error instanceof OnlineCatalogError && error.code === "timeout");
      assert.ok(Date.now() - started < 4_000, "整个目录生命周期必须有界");
      const spawned = log().find((row) => row["kind"] === "spawn");
      assert.ok(spawned, "测试必须真的启动过受控 CLI");
      assert.equal(isProcessAlive(Number(spawned["pid"])), false, "超时后不得遗留 CLI");
    });
  });
}

test("在线目录：损坏响应不得冒充成功空目录", async () => {
  await scenario("malformed", "codebuddy", async (_root, _log, input) => {
    await assert.rejects(fetchOnlineModelCatalog(input), (error: unknown) => error instanceof OnlineCatalogError && error.code === "failed");
  });
});

test("在线目录 CodeBuddy：锁定的真实 SDK 只做目录握手并回收受控 CLI", async () => {
  await scenario("ok", "codebuddy", async (root, log, input) => {
    const executable = join(root, "catalog-cli.mjs");
    copyFileSync(fileURLToPath(new URL("../fixtures/oc09-codebuddy-catalog-cli.mjs", import.meta.url)), executable);
    chmodSync(executable, 0o755);
    const result = await fetchOnlineModelCatalog({ backendId: "codebuddy", executable, authFile: input.authFile, timeoutMs: 5_000 });
    assert.deepEqual(result.models, ["actual-sdk-catalog-model"]);
    const requests = log().filter((row) => row["kind"] === "request");
    assert.ok(requests.length > 0, "真实 SDK 必须发起握手");
    assert.ok(requests.every((row) => row["type"] === "control_request" && row["subtype"] === "initialize"), "目录查询不得发送 prompt/user 消息");
    const pid = Number(log().find((row) => row["kind"] === "spawn")?.["pid"]);
    assert.equal(isProcessAlive(pid), false, "真实 SDK 查询后也必须收回 CLI");
  });
});
