/**
 * 崩溃窗口子进程（只由 fault 测试启动）。
 *
 * 它扮演「daemon」：占住文件库、启动真实 adapter（对着模拟服务）、受理一个 run
 * 并执行到「等待审批」。父进程会在这一刻 SIGKILL 它，模拟进程崩溃。
 *
 * 参数：node oc03-crash-child.ts <dbPath> <workspace> <runDir> <logPath> <readyPath> <workerPath>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OpenCodeHttpAdapter } from "../../src/backend/opencode/adapter.ts";
import { OpenCodeRunCoordinator } from "../../src/backend/opencode/coordinator.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import { admit, bootstrap } from "../helpers/storage-fixture.ts";

const [dbPath, workspace, runDir, logPath, readyPath, workerPath] = process.argv.slice(2);
if (
  dbPath === undefined ||
  workspace === undefined ||
  runDir === undefined ||
  logPath === undefined ||
  readyPath === undefined ||
  workerPath === undefined
) {
  process.stderr.write("missing arguments\n");
  process.exit(2);
}

const fakeServer = fileURLToPath(new URL("../fixtures/oc03-fake-opencode.ts", import.meta.url));
const store = BridgeStore.open(dbPath);
const fixture = bootstrap(store, { backendSessionId: null });
const adapter = new OpenCodeHttpAdapter({
  executable: "/nonexistent",
  workspaceRoot: workspace,
  runDir,
  providerConfigs: { minimax: { options: { apiKey: "fake-test-key-not-real" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } } },
  modelProfiles: { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
  policyProfile: "edit",
  serverEpoch: fixture.serverEpoch,
  pollIntervalMs: 20,
  permissionPollMs: 20,
  stopGraceMs: 800,
  approvalTimeoutMs: 30_000,
  startupTimeoutMs: 10_000,
  testCommand: {
    executable: process.execPath,
    args: [fakeServer, "--log", logPath, "--scenario", "permission-deny"],
  },
});
const session = await adapter.createSession({
  workspaceRoot: workspace,
  profile: "edit",
  policyProfile: "edit",
  model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
  runDir,
});
store.bindSessionBackend(fixture.session.sessionId, session.backendSessionId, session.serverEpoch);

let approved: (() => void) | null = null;
const coordinator = new OpenCodeRunCoordinator(store, adapter, {
  onApproval: async () => {
    // 永不回答：让 run 停在等待审批，等父进程杀掉本进程。
    await new Promise<void>((resolve) => {
      approved = resolve;
    });
    return { decision: "timeout", actor: "product_expiry" };
  },
});
void approved;

const deadlineAt = new Date(Date.now() + 60_000).toISOString();
const admitted = admit(store, fixture, {
  clientRequestId: "oc03-crash-window",
  prompt: "写文件",
  deadlineAt,
});

void coordinator
  .run({ runId: admitted.run.runId, prompt: "写文件", model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt })
  .catch(() => undefined);

// 等到 waiting_approval，把现场写给父进程。
for (;;) {
  const run = store.runs.require(admitted.run.runId);
  if (run.state === "waiting_approval") {
    const intent = store.dispatches.findByRun(admitted.run.runId);
    writeFileSync(
      readyPath,
      `${JSON.stringify({
        runId: admitted.run.runId,
        sessionId: fixture.session.sessionId,
        state: run.state,
        messageId: intent?.backendMessageId ?? null,
      })}\n`,
    );
    writeFileSync(workerPath, `${JSON.stringify({ pid: adapter.workerPid ?? 0 })}\n`);
    break;
  }
  await delay(20);
}
process.stderr.write(`waiting for crash at ${join(runDir, "noop")}\n`);
