/**
 * OC-03 故障测试：停止与进程回收、崩溃窗口。
 *
 * 全部离线：模拟服务是本地 Node HTTP 子进程；不启动真实 OpenCode、不调用模型。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { newId } from "../../src/contracts/ids.ts";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import { OpenCodeWorker } from "../../src/backend/opencode/worker.ts";
import { BridgeStore } from "../../src/storage/index.ts";
import { createAdapterHarness, makeDirs, readRequests, FAKE_SERVER } from "../helpers/oc03-harness.ts";

const RUN_ID = newId("run", "00000000-0000-4000-8000-0000000000c1");
const CRASH_CHILD = fileURLToPath(new URL("../fixtures/oc03-crash-child.ts", import.meta.url));

test("abort 不被确认时回收独占进程组，并验证工具后代退出", async () => {
  const harness = await createAdapterHarness({ scenario: "abort-ignore", stopGraceMs: 600 });
  try {
    const executing = harness.adapter.executeTurn(
      {
        runId: RUN_ID,
        session: harness.session as never,
        prompt: "跑脚本",
        model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
        deadlineAt: new Date(Date.now() + 8_000).toISOString(),
      },
      harness.sink,
    );
    // 等到工具真的开始（子进程已经 spawn）再停止。
    await waitFor(() => harness.sink.tools.includes("bash:started"), "工具开始");
    await waitFor(() => requests(harness.logPath).some((entry) => entry["event"] === "child_spawned"), "子进程启动");

    const outcome = await harness.adapter.stop({
      runId: RUN_ID,
      session: harness.session as never,
      intent: "cancel",
      graceMs: 600,
    });
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.method, "process_tree", "协议没有收尾，只能靠进程树确认");
    assert.match(outcome.detail, /已回收/);

    const result = await executing;
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(harness.adapter.isWorkerAlive, false);

    // 子进程本应在 2s 后写 late 标记；进程组已被回收，标记不应出现。
    await delay(2_500);
    assert.equal(existsSync(harness.marker("late-ignore.txt")), false, "工具后代必须被回收");
    const spawned = requests(harness.logPath).find((entry) => entry["event"] === "child_spawned");
    const childPid = Number(spawned?.["pid"] ?? 0);
    assert.equal(isAlive(childPid), false, "记录到的子进程必须已经退出");
  } finally {
    await harness.close();
  }
});

test("服务先死：执行中就要有界回收同组工具，不能等调用方 close", async () => {
  const harness = await createAdapterHarness({ scenario: "worker-crash", stopGraceMs: 600 });
  try {
    const executing = harness.adapter.executeTurn(
      {
        runId: RUN_ID,
        session: harness.session as never,
        prompt: "跑脚本",
        model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
        deadlineAt: new Date(Date.now() + 8_000).toISOString(),
      },
      harness.sink,
    );
    await waitFor(() => requests(harness.logPath).some((entry) => entry["event"] === "child_spawned"), "子进程启动");
    const spawned = requests(harness.logPath).find((entry) => entry["event"] === "child_spawned");
    const childPid = Number(spawned?.["pid"] ?? 0);
    const workerPid = harness.adapter.workerPid;
    assert.ok(workerPid !== null);

    // 只杀父服务，故意留下工具后代（本机实测到的故障形态）。
    process.kill(workerPid, "SIGKILL");
    const result = await executing;
    assert.notEqual(result.outcome.kind, "completed");
    assert.equal(result.stopCause, "worker_exit");

    // 关键：回收发生在 execute 内部，而不是靠 finally 或调用方 close。
    await waitFor(() => !isAlive(workerPid), "父进程退出");
    await waitFor(() => !isAlive(childPid), "执行中回收同组工具");
    assert.ok(
      result.observations.warnings.some((warning) => warning.includes("回收")),
      `应记录回收动作：${result.observations.warnings.join(" | ")}`,
    );

    // 本应在 2s 后写出的 late 标记不能出现。
    await delay(2_500);
    assert.equal(existsSync(harness.marker("late-crash.txt")), false, "工具后代必须被回收");

    // close 仍然不能是 no-op：要么已确认，要么明确 STOP_UNCONFIRMED。
    let closeError: unknown = null;
    try {
      await harness.adapter.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== null) {
      assert.ok(closeError instanceof ZBridgeError && closeError.code === "STOP_UNCONFIRMED");
      assert.equal(harness.adapter.isWorkerAlive, true, "未确认时不能假装 worker 已关闭");
    } else {
      assert.equal(harness.adapter.isWorkerAlive, false);
    }
  } finally {
    await harness.close();
  }
});

test("worker 停在自己都说不清的状态时，stop 如实返回未确认", async () => {
  // 直接构造一个 worker：让模拟服务先派生子进程，然后自杀；全程不调用 owned()，
  // 因此「退出前是否记录过后代」是没有证据的，stop 必须保守返回 exited:false。
  const dirs = makeDirs("self-kill");
  const logPath = join(dirs.root, "requests.jsonl");
  const worker = new OpenCodeWorker({
    command: {
      executable: process.execPath,
      args: [FAKE_SERVER, "--log", logPath, "--scenario", "self-kill-escaped"],
    },
    runDir: dirs.runDir,
    workspaceRoot: dirs.workspace,
    providerConfigs: { minimax: { options: { apiKey: "fake-test-key-not-real" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } } },
    registeredProviderIDs: ["minimax"],
    defaultModelRef: "minimax/MiniMax-M3.1-Flash",
    policyProfile: "review",
    pinnedVersion: "1.18.32",
    startupTimeoutMs: 10_000,
    stopGraceMs: 500,
  });
  let childPid = 0;
  try {
    await worker.start();
    await waitFor(() => readRequests(logPath).some((entry) => entry["event"] === "child_spawned"), "子进程启动");
    childPid = Number(readRequests(logPath).find((entry) => entry["event"] === "child_spawned")?.["pid"] ?? 0);
    const workerPid = worker.pid ?? 0;
    await waitFor(() => !isAlive(workerPid), "worker 自杀");
    const report = await worker.stop("SIGTERM", 500);
    assert.equal(report.exited, false, "没有记录的退出不能算确认");
    assert.match(report.detail, /无法确认|无法排除|没有记录后代|仍有存活/);
  } finally {
    if (isAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
    await worker.stop("SIGKILL", 300).catch(() => undefined);
    dirs.cleanup();
  }
});

test("崩溃窗口：待在审批时被杀，恢复看到 confirmed 消息且不重发", async () => {
  // 这里从零建目录：数据库由「daemon」子进程自己创建，父进程只在它被杀后打开检查。
  const dirs = makeDirs("oc03-crash-window");
  const dbPath = join(dirs.root, "bridge.sqlite");
  const logPath = join(dirs.root, "requests.jsonl");
  const readyPath = join(dirs.root, "ready.json");
  const workerPath = join(dirs.root, "worker.json");
  let child: ReturnType<typeof spawn> | null = null;
  let workerPid: number | null = null;
  try {
    child = spawn(process.execPath, [CRASH_CHILD, dbPath, dirs.workspace, dirs.runDir, logPath, readyPath, workerPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await waitFor(() => existsSync(readyPath), `子进程进入待批状态（stderr=${stderr.slice(-800)}）`, 25_000);
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
      runId: string;
      sessionId: string;
      messageId: string | null;
      state: string;
    };
    workerPid = Number((JSON.parse(readFileSync(workerPath, "utf8")) as { pid: number }).pid);
    assert.equal(ready.state, "waiting_approval");

    child.kill("SIGKILL");
    await new Promise((resolve) => child?.once("exit", resolve));

    // 另一个连接看到的现场：已确认的消息 + 未收尾的 run。
    const store = BridgeStore.open(dbPath);
    try {
      const intent = store.dispatches.findByRun(ready.runId as never);
      assert.equal(intent?.phase, "confirmed", "崩溃前已确认的消息必须落库");
      assert.match(intent?.backendMessageId ?? "", /^msg/);
      assert.equal(intent?.backendMessageId, ready.messageId);

      const report = store.recoverPendingRuns();
      assert.equal(report.descendantsConfirmedStopped, false);
      const recovered = report.runs[0];
      assert.ok(recovered !== undefined);
      assert.equal(recovered.disposition, "confirmed_but_unsettled");
      assert.equal(recovered.stateAfter, "unknown");
      assert.equal(recovered.blocked, true);
      assert.equal(store.runs.require(ready.runId as never).state, "unknown");
      const session = store.sessions.require(ready.sessionId as never);
      assert.equal(session.blockedReason, "unknown_outcome");
      assert.equal(session.recoveryVerification, "unverified");
      // 不重发：只有一次 prompt_async。
      const prompts = readRequests(logPath).filter((entry) => String(entry.route ?? "").includes("prompt_async"));
      assert.equal(prompts.length, 1, "崩溃恢复不能重发原 prompt");
      assert.equal(store.dispatches.count(), 1);
    } finally {
      store.close();
    }
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (workerPid !== null && isAlive(workerPid)) {
      try {
        process.kill(-workerPid, "SIGKILL");
      } catch {
        // 组可能已经消失。
      }
    }
    dirs.cleanup();
  }
});

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function requests(logPath: string) {
  return readRequests(logPath);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await delay(20);
  }
}
