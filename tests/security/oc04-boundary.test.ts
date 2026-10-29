import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/cli/args.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { buildControlledConfig } from "../../src/backend/opencode/profile.ts";
import { buildWorkerEnv } from "../../src/backend/opencode/worker.ts";
import { ipcCall } from "../../src/daemon/ipc.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { cleanupHarness, mkTestRoot, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";
import { readRequests } from "../helpers/oc03-harness.ts";

let harness: DaemonHarness;

before(async () => {
  harness = await startDaemon({ scenario: "permission-deny", runTimeoutMs: 20_000 });
});

after(async () => {
  await harness.shutdown().catch(() => undefined);
  cleanupHarness(harness);
});

test("生产入口 `daemon start` 拒绝测试后端参数（测试通道无法经由 CLI 打开）", async () => {
  const root = mkTestRoot("sec-start");
  try {
    const parsed = parseArgs([
      "daemon", "start",
      "--data-dir", root.dataRoot, "--config", root.configPath,
      "--provider-config", root.providerConfigPath, "--test-backend-cmd", "/tmp/x",
    ]);
    await assert.rejects(
      runCommand(parsed.positional, parsed.flags),
      (error: unknown) => error instanceof Error && error.message.includes("未知参数"),
    );
  } finally {
    root.cleanup();
  }
});

test("edit 不能被任何 IPC 参数开启：session.create 只接受 review；daemon 声明 editEnabled=false", async () => {
  await assert.rejects(
    harness.client("session.create", { workspaceSlug: "main", profile: "edit" }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_ARGUMENT",
  );
  const status = (await harness.status()) as { editEnabled: boolean; controlChannelIsolation: string };
  assert.equal(status.editEnabled, false);
  assert.equal(status.controlChannelIsolation, "unverified", "OS 级边界未建立，不得宣称隔离");
});

test("socket 0600、daemon 目录 0700（本机边界的一部分，不是全部）", () => {
  const clientMode = statSync(harness.paths.clientSocket).mode & 0o777;
  const operatorMode = statSync(harness.paths.operatorSocket).mode & 0o777;
  const dirMode = statSync(harness.paths.daemonDir).mode & 0o777;
  assert.equal(clientMode, 0o600);
  assert.equal(operatorMode, 0o600);
  assert.equal(dirMode, 0o700);
});

test("worker 的受控环境含 OPENCODE_SERVER_PASSWORD（同用户进程可读——隔离未建立的依据之一）", () => {
  const env = buildWorkerEnv({
    providerConfigs: { minimax: { options: {} } },
    registeredProviderIDs: ["minimax"],
    runDir: "/tmp/oc04-boundary-run",
    configPath: "/tmp/oc04-boundary-run/opencode.json",
    password: "boundary-evidence-password",
  });
  assert.equal(env.env["OPENCODE_SERVER_PASSWORD"], "boundary-evidence-password");
});

test("实测：worker 等价子进程凭自身 env 的控制材料可被后端接受（同一 Basic 密码）", async () => {
  // 独立起一个 fake 后端，密码只通过 worker 等价 env 交给子进程；
  // 子进程读自身 env（与真实 worker 的能力一致）并调用后端 API。
  const dir = mkdtempSync(join(tmpdir(), "oc04-workercred-"));
  const fixture = fileURLToPath(new URL("../fixtures/oc03-fake-opencode.ts", import.meta.url));
  const logPath = join(dir, "requests.jsonl");
  const password = "worker-env-password-evidence";
  writeFileSync(logPath, "");
  // 受控配置文件由 buildControlledConfig 生成（与 daemon 给真实 worker 的完全一致）。
  const runDir = join(dir, "run");
  for (const sub of ["home", "config", "data", "state", "cache"]) {
    mkdirSync(join(runDir, sub), { recursive: true, mode: 0o700 });
  }
  const configPath = join(runDir, "opencode.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      buildControlledConfig({
        providers: { minimax: { options: { apiKey: "oc04-fake-key-not-real", baseURL: "http://127.0.0.1:1/v1" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } } },
        defaultModelRef: "minimax/MiniMax-M3.1-Flash",
        policyProfile: "review",
      }),
    )}\n`,
    { mode: 0o600 },
  );
  const server = spawn(process.execPath, [fixture, "--log", logPath, "--scenario", "text-happy"], {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG: configPath,
      HOME: join(runDir, "home"),
      XDG_CONFIG_HOME: join(runDir, "config"),
      XDG_DATA_HOME: join(runDir, "data"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      server.stdout?.setEncoding("utf8");
      server.stdout?.on("data", (chunk: string) => {
        const match = chunk.match(/https?:\/\/\S+/);
        if (match !== null) resolve(match[0]);
      });
      server.once("exit", () => reject(new Error("fake server 提前退出")));
      setTimeout(() => reject(new Error("等待 fake server 地址超时")), 10_000);
    });

    const child = spawn(
      process.execPath,
      [
        "-e",
        `const assert = require("node:assert/strict");
         const workerPassword = process.env.OPENCODE_SERVER_PASSWORD;
         assert.ok(typeof workerPassword === "string" && workerPassword.length > 0, "worker 应能读到控制材料");
         const auth = "Basic " + Buffer.from("opencode:" + workerPassword).toString("base64");
         fetch(process.argv[1] + "/global/health", { headers: { Authorization: auth } })
           .then(async (response) => {
            require("node:fs").writeSync(1, String(response.status));
             process.exit(0);
           })
           .catch((error) => { require("node:fs").writeSync(2, String(error)); process.exit(1); });`,
        url,
      ],
      {
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker 子进程失败: ${stdout}`))));
      setTimeout(() => reject(new Error("worker 子进程超时")), 10_000);
    });
    assert.equal(stdout, "200", "后端必须接受 worker 持有的同一 Basic 密码（无法区分调用者）");
    const requests = readRequests(logPath);
    assert.equal(
      requests.some((entry) => entry["route"] === "GET /global/health" && entry["authenticated"] === true),
      true,
      "后端日志应记录这次带合法凭据的调用",
    );
  } finally {
    try {
      server.kill("SIGKILL");
    } catch {
      // 已退出。
    }
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once("exit", () => resolve());
      setTimeout(resolve, 3_000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
  // 结论（推断，未直连实测 reply 接口）：worker 持有与 operator 相同的后端凭据，
  // `/permission/{id}/reply` 只按该凭据放行、无法区分调用者——因此 worker 理论上
  // 可以自批。此处只作「控制通道隔离未建立」的记录，不作为任何「自批成功」的宣称。
});

test("实测：同用户子进程可经 operator socket 完成审批（daemon 层无 OS 边界）", async () => {
  await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "边界验证",
    clientRequestId: "req-boundary-1",
  });
  const pending = await harness.waitFor(
    "待批审批出现",
    async () => {
      const list = (await harness.operator("approval.list", {}, 3_000)) as { approvals: Array<Record<string, unknown>> };
      const found = list.approvals.find((item) => item["state"] === "pending" && item["waitlisted"] === true);
      return found ?? null;
    },
    15_000,
  );

  // 子进程与 worker 同属当前 macOS 用户——worker 理论上可用的同一条 IPC 路径。
  // 子进程回显自己实际收到的 argv，证明参数真实进入子进程并被执行。
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { connect } = require("node:net");
       const socketPath = process.argv[1];
       const pending = JSON.parse(process.argv[2]);
       if (typeof socketPath !== "string" || socketPath.length === 0) { process.stdout.write("BAD-ARGS"); process.exit(1); }
       const socket = connect(socketPath);
       const send = (message) => socket.write(JSON.stringify(message) + String.fromCharCode(10));
       let buffer = "";
       socket.setEncoding("utf8");
       socket.on("connect", () => send({ v: 1, id: "s1", kind: "approval.decide", payload: {
         approvalId: pending.approvalId, decision: "allow_once",
         payloadHash: pending.payloadHash, serverEpoch: pending.serverEpoch, attemptId: pending.attemptId } }));
       socket.on("data", (chunk) => {
         buffer += chunk;
         const line = buffer.split(String.fromCharCode(10))[0];
         if (!line) return;
         const message = JSON.parse(line);
         require("node:fs").writeSync(1, JSON.stringify({ argvSocket: socketPath, ok: message.ok === true, code: message.error ? message.error.code : null }));
         socket.destroy();
         process.exit(0);
       });
       socket.on("error", (error) => {
         require("node:fs").writeSync(1, JSON.stringify({ argvSocket: socketPath, ok: false, code: error.code ?? "SOCKET_ERROR" }));
         process.exit(0);
       });
       setTimeout(() => { require("node:fs").writeSync(1, JSON.stringify({ argvSocket: socketPath, ok: false, code: "TIMEOUT" })); process.exit(0); }, 8000);`,
      harness.paths.operatorSocket,
      JSON.stringify({
        approvalId: pending["approvalId"],
        payloadHash: pending["payloadHash"],
        serverEpoch: pending["serverEpoch"],
        attemptId: pending["attemptId"],
      }),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  const parsed = JSON.parse(stdout.split("\n")[0] ?? "{}") as { argvSocket?: string; ok?: boolean };
  assert.equal(parsed.argvSocket, harness.paths.operatorSocket, "子进程实际收到的 socket 路径必须与预期一致");
  // **期望即失败记录**：daemon 层没有 OS 边界，同用户进程可以自批成功。
  // 未来引入真正 OS 级隔离后，这条断言应翻转为「必须失败」。
  assert.equal(parsed.ok, true, `同用户自批被 daemon 接受（控制通道隔离未建立）: ${stdout}`);
});

test("生产入口闭环：daemon start（替身可执行）→ run 完成 → stop（无模型调用）", async () => {
  const root = mkTestRoot("prod-start");
  const shim = fileURLToPath(new URL("../fixtures/oc04-opencode-shim.mjs", import.meta.url));
  try {
    const parsed = parseArgs([
      "daemon", "start",
      "--data-dir", root.dataRoot, "--config", root.configPath,
      "--provider-config", root.providerConfigPath, "--opencode", shim, "--json",
    ]);
    const started = await runCommand(parsed.positional, parsed.flags);
    assert.equal(started.exitCode, 0, `daemon start 应就绪: ${started.output}`);

    const paths = resolveDaemonPaths(root.dataRoot);
    const run = (await ipcCall(paths.clientSocket, "run.start", {
      workspaceSlug: "main",
      prompt: "只回复 READY",
      clientRequestId: "req-prod-start-1",
      waitMs: 20_000,
    }, { timeoutMs: 30_000 })) as { runId: string; state: string };
    assert.equal(run.state, "completed");

    const stopParsed = parseArgs(["daemon", "stop", "--data-dir", root.dataRoot]);
    const stopped = await runCommand(stopParsed.positional, stopParsed.flags);
    assert.equal(stopped.exitCode, 0, `daemon stop 应成功: ${stopped.output}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    assert.equal(existsSync(paths.lockFile), false, "停止后锁文件应删除");
  } finally {
    root.cleanup();
  }
});
