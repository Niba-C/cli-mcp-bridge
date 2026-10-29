/**
 * OC-04 离线夹具：daemon 真实子进程 + 真实 Unix IPC。
 *
 * daemon 由 `node src/cli/main.ts daemon serve` 启动（与生产完全相同的入口），
 * 区别只有 `--test-backend-cmd` 指向 `tests/fixtures/oc03-fake-opencode.ts`，
 * 因此不启动真实 OpenCode、不调用模型。所有等待有界；清理只覆盖自己启动的进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { ipcCall } from "../../src/daemon/ipc.ts";
import { resolveDaemonPaths, type DaemonPaths } from "../../src/daemon/layout.ts";

export const FAKE_SERVER = fileURLToPath(new URL("../fixtures/oc03-fake-opencode.ts", import.meta.url));
export const CLI_MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

export interface DaemonHarnessOptions {
  readonly scenario: string;
  /** 工作区源目录内容定制（默认一个 seed 文件）。 */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  readonly queueTtlMs?: number;
  readonly runTimeoutMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
  /** OC-08：覆盖 backend.modelProfiles（默认单 MiniMax Flash）。 */
  readonly modelProfiles?: Readonly<Record<string, { providerID: string; modelID: string }>>;
  /** OC-08：覆盖供应商配置文件内容（默认旧格式单 MiniMax 对象）。 */
  readonly providerConfig?: unknown;
  /** OC-09：注入 SDK 后端（fake SDK 模块路径）与默认后端切换。 */
  readonly sdkBackends?: {
    readonly codebuddy?: {
      readonly executable: string;
      readonly model: string;
      readonly fakeModule: string;
      /** 额外允许列表；省略时只允许 model。 */
      readonly models?: readonly string[];
    };
    readonly qoder?: {
      readonly executable: string;
      readonly model: string;
      readonly fakeModule: string;
      readonly models?: readonly string[];
    };
  };
  readonly defaultBackend?: "opencode" | "codebuddy" | "qoder";
  /** 测试：缩短 SDK adapter 的 deadline 宽限，快速复现超时回收。 */
  readonly sdkDeadlineGraceMs?: number;
}

export interface DaemonHarness {
  readonly root: string;
  readonly workspaceDir: string;
  readonly altWorkspaceDir: string;
  readonly dataRoot: string;
  readonly paths: DaemonPaths;
  readonly configPath: string;
  readonly providerConfigPath: string;
  readonly daemon: ChildProcess;
  /** 客户端通道调用（普通查询/执行；不能批准）。 */
  client<T = unknown>(kind: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** operator 通道调用（审批决定/解除阻塞/关停）。 */
  operator<T = unknown>(kind: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  status(): Promise<Record<string, unknown>>;
  /** 有界等待一个谓词成立；失败抛出（含最后一次状态摘要）。 */
  waitFor<T>(description: string, probe: () => Promise<T | null>, timeoutMs?: number): Promise<T>;
  /** 有界等 daemon 进程退出。 */
  waitExit(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
  /** 用相同参数重启 daemon 子进程并等待就绪；可换 scenario（崩溃恢复测试用）。 */
  respawn(timeoutMs?: number, scenario?: string): Promise<void>;
}

function writeWorkspace(dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * 登记规则拒绝 $TMPDIR 下的工作区（旧规则暂保留），因此测试源工作区放在
 * home 下的专用前缀目录；cleanupHarness 负责删除自己创建的部分。
 */
function makeWorkspaceDir(scenario: string): string {
  const base = join(homedir(), ".opencode-bridge-oc04-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `${scenario.slice(0, 24)}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function startDaemon(options: DaemonHarnessOptions): Promise<DaemonHarness> {
  const root = mkdtempSync(join(tmpdir(), `oc04-${options.scenario.slice(0, 10)}-`)); // 场景名过长会让 socket 路径超 macOS sun_path 上限
  const workspaceDir = makeWorkspaceDir(options.scenario);
  const altWorkspaceDir = makeWorkspaceDir(`${options.scenario}-alt`);
  const dataRoot = join(root, "data");
  const paths = resolveDaemonPaths(dataRoot);
  writeWorkspace(workspaceDir, options.workspaceFiles ?? { "seed.txt": "seed\n" });
  writeWorkspace(altWorkspaceDir, { "alt.txt": "alt\n" });
  chmodSync(workspaceDir, 0o755);
  chmodSync(altWorkspaceDir, 0o755);

  const configPath = join(root, "config.json");
  const backends: Record<string, unknown> = {
    opencode: {
      adapter: "opencode-http",
      enabled: true,
      pinnedVersion: "1.18.32",
      executable: null,
      providerConfigFile: null,
      modelProfiles: options.modelProfiles ?? { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
    },
  };
  if (options.sdkBackends?.codebuddy !== undefined) {
    backends["codebuddy"] = {
      adapter: "codebuddy-sdk",
      enabled: true,
      pinnedVersion: "2.173.0",
      executable: options.sdkBackends.codebuddy.executable,
      auth: { mode: "credential-file", file: join(root, "codebuddy-auth.json") },
      models: {
        default: options.sdkBackends.codebuddy.model,
        allowed: options.sdkBackends.codebuddy.models ?? [options.sdkBackends.codebuddy.model],
      },
    };
    writeFileSync(join(root, "codebuddy-auth.json"), `${JSON.stringify({ accessToken: "oc09-fake-cb-pat" })}\n`, { mode: 0o600 });
  }
  if (options.sdkBackends?.qoder !== undefined) {
    backends["qoder"] = {
      adapter: "qoder-sdk",
      enabled: true,
      pinnedVersion: "1.1.78",
      executable: options.sdkBackends.qoder.executable,
      auth: { mode: "credential-file", file: join(root, "qoder-auth.json") },
      models: {
        default: options.sdkBackends.qoder.model,
        allowed: options.sdkBackends.qoder.models ?? [options.sdkBackends.qoder.model],
      },
    };
    writeFileSync(join(root, "qoder-auth.json"), `${JSON.stringify({ accessToken: "oc09-fake-qd-pat" })}\n`, { mode: 0o600 });
  }
  const config = {
    schemaVersion: 3,
    mode: "personal",
    defaultBackend: options.defaultBackend ?? "opencode",
    backends,
    workspaces: [
      { id: "main", name: "main", root: workspaceDir, profiles: ["review"] },
      { id: "alt", name: "alt", root: altWorkspaceDir, profiles: ["review"] },
    ],
    limits: {
      activeRuns: 1,
      ...(options.queueTtlMs === undefined ? {} : { queueTtlMs: options.queueTtlMs }),
      ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }),
    },
    transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
  };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

  // 测试供应商配置：形状合法但不是真实密钥；fake 服务只校验结构。
  const providerConfigPath = join(root, "provider.json");
  writeFileSync(
    providerConfigPath,
    `${JSON.stringify(options.providerConfig ?? { options: { apiKey: "oc04-fake-key-not-real", baseURL: "http://127.0.0.1:1/v1" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } })}\n`,
    { mode: 0o600 },
  );

  const serveArgsFor = (scenarioValue: string): string[] => [
    CLI_MAIN,
    "daemon", "serve",
    "--data-dir", dataRoot,
    "--config", configPath,
    "--provider-config", providerConfigPath,
    "--test-backend-cmd", FAKE_SERVER,
    "--test-backend-scenario", scenarioValue,
    ...(options.sdkBackends?.codebuddy === undefined ? [] : ["--test-sdk-codebuddy", options.sdkBackends.codebuddy.fakeModule]),
    ...(options.sdkBackends?.qoder === undefined ? [] : ["--test-sdk-qoder", options.sdkBackends.qoder.fakeModule]),
    ...(options.sdkDeadlineGraceMs === undefined ? [] : ["--test-sdk-deadline-grace-ms", String(options.sdkDeadlineGraceMs)]),
  ];

  const child = spawn(process.execPath, serveArgsFor(options.scenario), {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  let stderrTail = "";
  const watchStderr = (target: ChildProcess): void => {
    target.stderr?.setEncoding("utf8");
    target.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_000);
    });
  };
  watchStderr(child);

  const client = async <T>(kind: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> =>
    ipcCall<T>(paths.clientSocket, kind, payload, { timeoutMs });
  const operator = async <T>(kind: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> =>
    ipcCall<T>(paths.operatorSocket, kind, payload, { timeoutMs });

  const status = async (): Promise<Record<string, unknown>> => operator("daemon.status", {}, 3_000);

  const readyDeadlineLoop = async (target: ChildProcess, timeoutMs: number): Promise<void> => {
    const readyDeadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await operator("ping", {}, 2_000);
        return;
      } catch (error) {
        if (target.exitCode !== null || target.signalCode !== null) {
          throw new Error(`daemon 提前退出 (code=${target.exitCode}/${target.signalCode ?? ""}): stderr=${stderrTail}`);
        }
        if (Date.now() > readyDeadline) {
          throw new Error(`daemon 未就绪: ${error instanceof Error ? error.message : String(error)}; stderr=${stderrTail}`);
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
      }
    }
  };

  let daemonProcess: ChildProcess = child;
  const respawn = async (timeoutMs = 30_000, scenario?: string): Promise<void> => {
    const next = spawn(process.execPath, serveArgsFor(scenario ?? options.scenario), {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    watchStderr(next);
    daemonProcess = next;
    await readyDeadlineLoop(next, timeoutMs);
  };

  const harness: DaemonHarness = {
    root,
    workspaceDir,
    altWorkspaceDir,
    dataRoot,
    paths,
    configPath,
    providerConfigPath,
    get daemon(): ChildProcess {
      return daemonProcess;
    },
    client,
    operator,
    status,
    async waitFor<T>(description: string, probe: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const value = await probe();
          if (value !== null) return value;
        } catch {
          // 探测失败继续等到期限。
        }
        if (Date.now() > deadline) {
          let summary = "";
          try {
            summary = JSON.stringify(await status());
          } catch {
            summary = "status 不可用";
          }
          throw new Error(`等待超时: ${description}; stderr=${stderrTail}; status=${summary}`);
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
    },
    async waitExit(timeoutMs = 15_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (daemonProcess.exitCode !== null || daemonProcess.signalCode !== null) return;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      assert.fail(`daemon 未在期限内退出; stderr=${stderrTail}`);
    },
    async shutdown(): Promise<void> {
      try {
        await operator("daemon.shutdown", {}, 5_000);
      } catch {
        try {
          daemonProcess.kill("SIGTERM");
        } catch {
          // 已退出。
        }
      }
      await harness.waitExit().catch(() => undefined);
    },
    respawn,
  };

  try {
    await readyDeadlineLoop(child, 30_000);
  } catch (error) {
    // 启动失败也必须清理自己创建的目录，不留泄漏。
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出。
    }
    cleanupHarness(harness);
    throw error;
  }
  return harness;
}

export function cleanupHarness(harness: DaemonHarness): void {
  try {
    rmSync(harness.root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结果。
  }
  for (const dir of [harness.workspaceDir, harness.altWorkspaceDir]) {
    try {
      // 只删除本夹具创建的工作区目录（名字带随机后缀，不会误删其它内容）。
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 同上。
    }
  }
}

export interface TestEnv {
  readonly root: string;
  readonly workspaceDir: string;
  readonly altWorkspaceDir: string;
  readonly dataRoot: string;
  readonly paths: DaemonPaths;
  readonly configPath: string;
  readonly providerConfigPath: string;
  cleanup(): void;
}

/** 只准备目录与配置文件，不启动 daemon（给 `daemon start` 拒绝路径测试等使用）。 */
export function mkTestRoot(label: string, workspaceFiles: Readonly<Record<string, string>> = { "seed.txt": "seed\n" }): TestEnv {
  const root = mkdtempSync(join(tmpdir(), `oc04-${label}-`));
  const workspaceDir = makeWorkspaceDir(label);
  const altWorkspaceDir = makeWorkspaceDir(`${label}-alt`);
  const dataRoot = join(root, "data");
  const paths = resolveDaemonPaths(dataRoot);
  writeWorkspace(workspaceDir, workspaceFiles);
  writeWorkspace(altWorkspaceDir, { "alt.txt": "alt\n" });
  const configPath = join(root, "config.json");
  const config = {
    schemaVersion: 2,
    mode: "personal",
    backend: {
      adapter: "opencode-http",
      pinnedVersion: "1.18.32",
      modelProfiles: { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
    },
    workspaces: [
      { id: "main", name: "main", root: workspaceDir, profiles: ["review"] },
      { id: "alt", name: "alt", root: altWorkspaceDir, profiles: ["review"] },
    ],
    limits: { activeRuns: 1 },
    transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
  };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const providerConfigPath = join(root, "provider.json");
  writeFileSync(
    providerConfigPath,
    `${JSON.stringify({ options: { apiKey: "oc04-fake-key-not-real", baseURL: "http://127.0.0.1:1/v1" }, models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } } })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    workspaceDir,
    altWorkspaceDir,
    dataRoot,
    paths,
    configPath,
    providerConfigPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失败不影响断言结果。
      }
      for (const dir of [workspaceDir, altWorkspaceDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // 同上。
        }
      }
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
