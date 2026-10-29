import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateConfigObject } from "../../src/contracts/config.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ipcCall } from "../../src/daemon/ipc.ts";
import { isProcessAlive } from "../../src/daemon/lock.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { BridgeStore } from "../../src/storage/store.ts";
import { FAKE_SERVER } from "../helpers/oc04-harness.ts";

test("worker 身份落库失败：清理刚启动的进程，不建发送意图、不发 prompt", async () => {
  const root = mkdtempSync("/private/tmp/oc04-rec-");
  const source = join(root, "source");
  const dataRoot = join(root, "data");
  mkdirSync(source);
  writeFileSync(join(source, "seed.txt"), "seed\n");
  const config = validateConfigObject({
    schemaVersion: 2,
    mode: "personal",
    backend: { adapter: "opencode-http", pinnedVersion: "1.18.32", modelProfiles: { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } } },
    workspaces: [{ id: "main", root: source, profiles: ["review"] }],
    limits: { activeRuns: 1 },
    transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
  });
  assert.ok(config.ok);
  const daemon = new Daemon({
    dataRoot,
    config: config.config,
    providerConfig: { options: { apiKey: "oc04-fake-not-real", baseURL: "http://127.0.0.1:1/v1" } },
    testBackendCommand: { fixturePath: FAKE_SERVER, scenario: "text-happy" },
  });
  let spawnedPid: number | null = null;
  const recordWorkerStart = BridgeStore.prototype.recordWorkerStart;
  try {
    await daemon.start();
    BridgeStore.prototype.recordWorkerStart = function (input) {
      spawnedPid = input.pid;
      throw new Error("injected worker record failure");
    };
    const paths = resolveDaemonPaths(dataRoot);
    const accepted = await ipcCall<{ runId: string }>(paths.clientSocket, "run.start", {
      workspaceSlug: "main", prompt: "must not be sent", clientRequestId: "record-failure",
    });
    let state = "queued";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snapshot = await ipcCall<{ state: string }>(paths.clientSocket, "run.get", { runId: accepted.runId });
      state = snapshot.state;
      if (state === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(state, "cancelled", "未派发失败应收敛为未执行取消");
    assert.ok(spawnedPid !== null);
    assert.equal(isProcessAlive(spawnedPid), false, "未登记 worker 必须已退出");
    const db = new DatabaseSync(join(dataRoot, "data", "opencode-bridge.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatch_intents").get()?.["n"], 0);
    } finally {
      db.close();
    }
    const log = existsSync(paths.backendLog) ? readFileSync(paths.backendLog, "utf8") : "";
    assert.equal(log.includes("prompt_async"), false);
  } finally {
    BridgeStore.prototype.recordWorkerStart = recordWorkerStart;
    await daemon.shutdown("test_cleanup");
    if (spawnedPid !== null && isProcessAlive(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
