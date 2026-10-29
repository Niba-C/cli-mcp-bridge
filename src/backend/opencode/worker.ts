/**
 * 独占 OpenCode worker 的生命周期（技术规格 §7）。
 *
 * 硬性约束：
 * - 只管理**自己 spawn 出来**的服务：地址从自身 stdout 解析，不接受外部传入的 URL，
 *   因此不会附加到用户已运行的 TUI／桌面共享服务；
 * - 只接受 loopback 地址，出现其它 host 立即判定失败并回收；
 * - 最小 env：从空对象按白名单构造，只补 HOME／XDG／config／data 与临时认证密码，
 *   不继承用户全局 auth、MCP 或插件环境；
 * - 进程组所有权清晰：`detached: true` 让 worker 成为自己进程组的组长，
 *   回收时只对**这个组**与**它的后代**发信号，并逐个验证退出；
 * - 不把「父进程已经没了」当成「工具后代已经停了」。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { BackendPolicyProfile } from "../../contracts/backend.ts";
import { assertPinnedVersion, buildControlledConfig, collectSecretValues, redactSecrets } from "./profile.ts";

/** 生产固定参数：hostname 只允许 loopback，端口由系统分配（`--port 0`）。 */
export const OPENCODE_SERVE_ARGS: readonly string[] = Object.freeze([
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  "0",
  "--pure",
  "--log-level",
  "WARN",
]);

export interface WorkerCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

const OPENCODE_HEALTH_PATH = "/global/health";

/** 生产命令：可执行文件由调用方给出绝对路径，参数固定不可改。 */
export function pinnedServeCommand(executable: string): WorkerCommand {
  return { executable, args: [...OPENCODE_SERVE_ARGS] };
}

const ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/**
 * 其它供应商的凭证环境变量一律不转发，除非该供应商已在本地登记。
 * 目的是让「只启用登记供应商」不只是配置字面，而是环境层面的隔离。
 */
const FOREIGN_PROVIDER_BRANDS = [
  "MINIMAX",
  "DEEPSEEK",
  "OPENAI",
  "ANTHROPIC",
  "GEMINI",
  "GOOGLE",
  "GROQ",
  "MISTRAL",
  "OPENROUTER",
  "AZURE",
  "XAI",
  "COHERE",
  "TOGETHER",
  "FIREWORKS",
  "DASHSCOPE",
  "MOONSHOT",
  "ZHIPU",
  "QWEN",
] as const;

export interface BuiltEnv {
  readonly env: Record<string, string>;
  /** 被转发的环境变量名（只记名字，不记值）。 */
  readonly forwarded: readonly string[];
  /** 因为属于未登记供应商而被拒绝转发的名字。 */
  readonly rejectedForeign: readonly string[];
}

function referencedEnvNames(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    const names: string[] = [];
    for (const match of value.matchAll(/\{env:([^}]+)\}/g)) {
      const name = match[1];
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
    return names;
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const names: string[] = [];
  for (const child of Object.values(record)) names.push(...referencedEnvNames(child, depth + 1));
  return names;
}

/** 环境变量名里出现、且不属于已登记供应商的品牌词。 */
function unregisteredBrands(name: string, registeredKeywords: ReadonlySet<string>): readonly string[] {
  const hits: string[] = [];
  for (const brand of FOREIGN_PROVIDER_BRANDS) {
    if (name.toUpperCase().includes(brand) && !registeredKeywords.has(brand)) hits.push(brand);
  }
  return hits;
}

/**
 * 构造 worker 的最小环境。
 *
 * `providerConfigs`（已过滤到登记供应商）里用 `{env:NAME}` 引用的变量才会被转发
 * （登记供应商自己的密钥），其余继承环境一律不要；未登记供应商品牌的名字即使被引用也拒绝。
 */
export function buildWorkerEnv(input: {
  readonly providerConfigs: Readonly<Record<string, unknown>>;
  readonly registeredProviderIDs: readonly string[];
  readonly runDir: string;
  readonly configPath: string;
  readonly password: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): BuiltEnv {
  const base = input.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  const forwarded: string[] = [];
  const rejectedForeign: string[] = [];
  const registeredKeywords = new Set(input.registeredProviderIDs.map((id) => id.toUpperCase()));

  for (const name of ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  for (const name of referencedEnvNames(input.providerConfigs)) {
    if (unregisteredBrands(name, registeredKeywords).length > 0) {
      rejectedForeign.push(name);
      continue;
    }
    const value = base[name];
    if (typeof value === "string" && value.length > 0 && !Object.hasOwn(env, name)) {
      env[name] = value;
      forwarded.push(name);
    }
  }

  Object.assign(env, {
    HOME: join(input.runDir, "home"),
    XDG_CONFIG_HOME: join(input.runDir, "config"),
    XDG_DATA_HOME: join(input.runDir, "data"),
    XDG_STATE_HOME: join(input.runDir, "state"),
    XDG_CACHE_HOME: join(input.runDir, "cache"),
    OPENCODE_CONFIG: input.configPath,
    OPENCODE_SERVER_PASSWORD: input.password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  });
  return { env, forwarded, rejectedForeign };
}

import {
  isProcessAlive,
  readProcessTable,
  listProcessTable,
  ownedProcesses,
  groupHasMembers,
  ownProcessGroupId,
} from "../../core/proc.ts";
import type { ProcessInfo, ProcessTableRead } from "../../core/proc.ts";
export { isProcessAlive, readProcessTable, listProcessTable, ownedProcesses, groupHasMembers };
export type { ProcessInfo, ProcessTableRead };

export interface WorkerStartResult {
  readonly baseUrl: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly version: string | null;
}

export interface WorkerStopReport {
  readonly signalSent: "none" | "SIGTERM" | "SIGKILL";
  readonly pidsBefore: readonly number[];
  readonly pidsAfter: readonly number[];
  readonly exited: boolean;
  readonly detail: string;
}

export interface WorkerSpawnInfo {
  readonly pid: number;
  readonly processGroupId: number;
}

export interface WorkerOptions {
  readonly command: WorkerCommand;
  readonly runDir: string;
  readonly workspaceRoot: string;
  /** 已过滤到登记供应商的配置（providerID → OpenCode 配置对象；含密钥，不打印不落库）。 */
  readonly providerConfigs: Readonly<Record<string, unknown>>;
  /** 登记供应商 ID 列表（环境转发白名单依据）。 */
  readonly registeredProviderIDs: readonly string[];
  /** default profile 的完整引用；写入 config.model／small_model。 */
  readonly defaultModelRef: string;
  readonly policyProfile: BackendPolicyProfile;
  readonly pinnedVersion: string;
  readonly startupTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly healthCheck?: (baseUrl: string) => Promise<{ ok: boolean; version: string | null }>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  /**
   * **spawn 之后、健康检查之前**立即回调：daemon 在这一刻持久化 worker 身份，
   * 否则 spawn→health 之间被杀会留下没有归属记录的进程。
   */
  readonly onSpawned?: (info: WorkerSpawnInfo) => void;
  /**
   * **仅供离线测试**注入进程表读取（模拟 `ps` 不可用）。
   * 生产路径固定使用 `readProcessTable()`。
   */
  readonly testProcessTable?: () => ProcessTableRead;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

/**
 * 独占 worker：spawn、等待自身 stdout 里的地址、健康检查、回收进程组。
 *
 * 缺证据时明确报告 `exited:false`，调用方不得当作已停止。
 */
export class OpenCodeWorker {
  private readonly options: WorkerOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stopped = false;
  /** 曾经观察到属于本 worker 的后代 PID；用于「服务先死」时核对是否还有存活者。 */
  private readonly knownDescendants = new Set<number>();
  private descendantsObserved = false;
  private readonly secrets: readonly string[];

  constructor(options: WorkerOptions) {
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.secrets = collectSecretValues(options.providerConfigs);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get url(): string | null {
    return this.baseUrl;
  }

  get hasExited(): boolean {
    return this.exitInfo !== null;
  }

  /** 供证据记录的诊断尾部（已脱敏、有界）。 */
  get stderr(): string {
    return this.stderrTail;
  }

  private log(line: string): void {
    this.options.log?.(redactSecrets(line, this.secrets));
  }

  /** 进程表读取入口：生产用 `ps`，离线测试可注入「读不到」。 */
  private readTable(): ProcessTableRead {
    return this.options.testProcessTable === undefined ? readProcessTable() : this.options.testProcessTable();
  }

  async start(): Promise<WorkerStartResult> {
    if (this.child !== null) throw new ZBridgeError("INVALID_ARGUMENT", "worker 已经启动过");
    const { command, runDir, workspaceRoot, providerConfigs, registeredProviderIDs, defaultModelRef, policyProfile } = this.options;

    if (!command.executable.startsWith("/")) {
      throw new ZBridgeError("INVALID_ARGUMENT", "OpenCode 可执行文件必须是绝对路径");
    }
    assertExecutable(command.executable);
    if (!existsSync(workspaceRoot)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "工作区根不存在");
    }
    for (const dir of ["home", "config", "data", "state", "cache"]) {
      mkdirSync(join(runDir, dir), { recursive: true, mode: 0o700 });
    }

    const password = randomBytes(24).toString("hex");
    const configPath = join(runDir, "opencode.json");
    const config = buildControlledConfig({ providers: providerConfigs, defaultModelRef, policyProfile });
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

    const built = buildWorkerEnv({
      providerConfigs,
      registeredProviderIDs,
      runDir,
      configPath,
      password,
    });
    this.log(
      `worker env: forwarded=[${built.forwarded.join(",")}] foreignRejected=[${built.rejectedForeign.join(",")}]`,
    );

    const child = spawn(command.executable, [...command.args], {
      cwd: workspaceRoot,
      env: built.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    // 归属证据必须在 spawn 之后、任何等待之前交给调用方落库：
    // daemon 在 spawn→health 之间被杀时，恢复逻辑凭这条记录安全回收。
    this.options.onSpawned?.({
      pid: child.pid ?? 0,
      processGroupId: child.pid ?? 0,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer = appendBounded(this.stdoutBuffer, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = appendBounded(this.stderrTail, chunk).slice(-4_000);
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });

    this.authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const baseUrl = await this.waitForBaseUrl();
    const version = await this.waitForHealth(baseUrl);
    // 期望版本本身必须与基线一致；实际版本再核对一次，两者都过才算就绪。
    assertPinnedVersion(this.options.pinnedVersion);
    assertPinnedVersion(version);
    this.baseUrl = baseUrl;
    this.log(`worker started pid=${child.pid ?? 0} version=${version}`);
    return {
      baseUrl,
      pid: child.pid ?? 0,
      processGroupId: child.pid ?? 0,
      version,
    };
  }

  private authHeader = "";

  get authorization(): string {
    return this.authHeader;
  }

  private async waitForBaseUrl(): Promise<string> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    while (this.now() < deadline) {
      if (this.exitInfo !== null) {
        throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode worker 启动后立即退出", {
          details: { exitCode: this.exitInfo.code, signal: this.exitInfo.signal ?? null, stderrTail: this.stderrTail },
        });
      }
      const match = this.stdoutBuffer.match(/https?:\/\/[^\s]+/);
      if (match !== null) {
        return assertLoopbackUrl(match[0]);
      }
      await this.sleep(50);
    }
    await this.stop("SIGTERM");
    throw new ZBridgeError("BACKEND_UNAVAILABLE", "等待 OpenCode worker 报告地址超时", {
      details: { stderrTail: this.stderrTail },
    });
  }

  private async waitForHealth(baseUrl: string): Promise<string | null> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const check = this.options.healthCheck ?? ((url: string) => this.defaultHealthCheck(url));
    let last: string | null = null;
    while (this.now() < deadline) {
      if (this.exitInfo !== null) {
        throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode worker 在健康检查前退出", {
          details: { exitCode: this.exitInfo.code, signal: this.exitInfo.signal ?? null, stderrTail: this.stderrTail },
        });
      }
      const result = await check(baseUrl);
      if (result.ok) return result.version;
      last = result.version;
      await this.sleep(100);
    }
    throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode worker 健康检查超时", {
      details: { lastVersion: last, stderrTail: this.stderrTail },
    });
  }

  /** 健康检查只用于启动就绪与版本核对；失败不猜「服务在跑」。 */
  private async defaultHealthCheck(baseUrl: string): Promise<{ ok: boolean; version: string | null }> {
    try {
      const response = await fetch(`${baseUrl}${OPENCODE_HEALTH_PATH}`, {
        headers: { Authorization: this.authHeader },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { ok: false, version: null };
      const body = (await response.json()) as unknown;
      if (body === null || typeof body !== "object") return { ok: false, version: null };
      const record = body as Record<string, unknown>;
      const version = typeof record["version"] === "string" ? record["version"] : null;
      return { ok: record["healthy"] !== false, version };
    } catch {
      return { ok: false, version: null };
    }
  }

  /**
   * 当前归属于该 worker 的进程（不含自身）。
   * 返回 null 表示进程表读不到：调用方不能把它当成「没有后代」。
   */
  owned(): readonly ProcessInfo[] | null {
    const pid = this.child?.pid;
    if (pid === undefined) return [];
    const table = this.readTable();
    if (!table.ok) return null;
    const rows = ownedProcesses(table.rows, pid, pid);
    for (const row of rows) this.knownDescendants.add(row.pid);
    this.descendantsObserved = true;
    return rows;
  }

  /**
   * 回收本 worker 的进程组。
   *
   * 顺序：SIGTERM 进程组 → 等宽限 → 仍在则 SIGKILL → 对曾记录的存活后代逐个补刀 → 再验证。
   * `exited` 只有在「进程组、当前后代、曾经观察到的后代都不可见」且「进程表可读」时才为 true。
   *
   * 三种保守情形都返回 `exited:false`：
   * 1. worker 在停止请求前已退出、而我们从未观察到它的后代；
   * 2. 进程表读不到（无法证明后代已结束）；
   * 3. 仍有记录在案的后代存活（父进程死了不代表工具停了）。
   */
  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM", graceMs = this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS): Promise<WorkerStopReport> {
    const child = this.child;
    if (child === null) {
      return { signalSent: "none", pidsBefore: [], pidsAfter: [], exited: true, detail: "worker 从未启动" };
    }
    const pid = child.pid;
    if (pid === undefined) {
      return { signalSent: "none", pidsBefore: [], pidsAfter: [], exited: true, detail: "worker 没有 PID" };
    }

    const firstTable = this.readTable();
    if (this.exitInfo !== null) {
      const recorded = [...this.knownDescendants];
      const alive = recorded.filter((candidate) => isProcessAlive(candidate));
      const groupAlive = firstTable.ok ? groupHasMembers(firstTable.rows, pid) : false;
      if (!firstTable.ok) {
        return {
          signalSent: "none",
          pidsBefore: recorded,
          pidsAfter: alive,
          exited: false,
          detail: `worker 已退出，但进程表不可读（${firstTable.reason}），无法确认后代是否结束`,
        };
      }
      const firstGroupAlive = groupAlive;
      if (!firstGroupAlive && alive.length === 0 && this.descendantsObserved) {
        this.stopped = true;
        return {
          signalSent: "none",
          pidsBefore: recorded,
          pidsAfter: [],
          exited: true,
          detail: "worker 已退出，且退出前观察到的后代全部结束",
        };
      }
      // 父进程已死但同组后代仍活着：这是**我们自己创建**的进程组（worker 曾是组长），
      // 即使没来得及记录后代也要给出回收路径，否则同组工具永远无人清理。
      let signalSent: WorkerStopReport["signalSent"] = "none";
      if (groupAlive) {
        this.signalGroup(pid, "SIGKILL");
        signalSent = "SIGKILL";
        await this.waitForExit(pid, Math.max(500, Math.min(graceMs, 2_000)));
      }
      // 逐个补掉曾经记录、可能已经脱离进程组的后代（PID 来自我们自己的观察记录）。
      for (const candidate of recorded) {
        if (!isProcessAlive(candidate)) continue;
        try {
          process.kill(candidate, "SIGKILL");
        } catch {
          // ESRCH 等：已经退出。
        }
      }
      if (recorded.length > 0) await this.waitForExit(pid, 1_000);
      const afterRead = this.readTable();
      const afterOwned = afterRead.ok ? ownedProcesses(afterRead.rows, pid, pid) : null;
      const after = [...new Set([...recorded, ...(afterOwned ?? []).map((row) => row.pid)])].filter((candidate) =>
        isProcessAlive(candidate),
      );
      const stillGroup = afterRead.ok ? groupHasMembers(afterRead.rows, pid) : true;
      // 已经回收并验证「本组 + 记录后代」都不在了，但从未观察过后代时，
      // 仍不能排除脱组后代：保守返回未确认，只报告已经做过的回收动作。
      const verifiable = afterRead.ok && !stillGroup && after.length === 0;
      const exited = verifiable && this.descendantsObserved;
      this.stopped = exited;
      return {
        signalSent,
        pidsBefore: recorded,
        pidsAfter: after,
        exited,
        detail: exited
          ? "worker 已退出，记录在案的后代也已结束"
          : !afterRead.ok
            ? `进程表不可读（${afterRead.reason}），无法确认后代是否结束`
            : verifiable && !this.descendantsObserved
              ? "worker 已退出；已回收同组进程并验证为空，但退出前从未观察过后代，无法排除脱组后代"
              : `worker 已退出，但仍有存活后代：[${after.join(",")}]`,
      };
    }

    if (!firstTable.ok) {
      // 进程表读不到：仍然可以按进程组发信号，但不能声称后代已退出。
      this.signalGroup(pid, signal === "SIGTERM" ? "SIGKILL" : signal);
      await this.waitForExit(pid, Math.max(500, Math.min(graceMs, 2_000)));
      return {
        signalSent: "SIGKILL",
        pidsBefore: [],
        pidsAfter: [],
        exited: false,
        detail: `进程表不可读（${firstTable.reason}），无法确认进程树已退出`,
      };
    }

    const before = this.owned() ?? [];
    let signalSent: WorkerStopReport["signalSent"] = "none";
    if (isProcessAlive(pid) || groupHasMembers(firstTable.rows, pid)) {
      this.signalGroup(pid, signal);
      signalSent = signal;
    }
    await this.waitForExit(pid, graceMs);
    const stillThere = (this.owned() ?? []).length > 0 || before.some((row) => isProcessAlive(row.pid));
    if (stillThere && signal !== "SIGKILL") {
      this.signalGroup(pid, "SIGKILL");
      signalSent = "SIGKILL";
      await this.waitForExit(pid, Math.max(1_000, Math.floor(graceMs / 2)));
    }
    // 曾经观察到、但可能已经脱离进程组的后代：逐个补刀（PID 来自我们自己的观察记录）。
    for (const row of before) {
      if (!isProcessAlive(row.pid)) continue;
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {
        // ESRCH 等：已经退出。
      }
    }
    if (before.length > 0) await this.waitForExit(pid, 1_000);

    const finalTable = this.readTable();
    const afterOwned = finalTable.ok ? ownedProcesses(finalTable.rows, pid, pid) : null;
    const survivors = [...new Set([...before.map((row) => row.pid), ...this.knownDescendants])].filter((candidate) =>
      isProcessAlive(candidate),
    );
    const groupAlive = finalTable.ok ? groupHasMembers(finalTable.rows, pid) || isProcessAlive(pid) : false;
    if (!finalTable.ok || afterOwned === null) {
      return {
        signalSent,
        pidsBefore: before.map((row) => row.pid),
        pidsAfter: survivors,
        exited: false,
        detail: `进程表不可读（${finalTable.ok ? "unknown" : finalTable.reason}），无法确认进程树已退出`,
      };
    }
    const after = afterOwned.map((row) => row.pid);
    const exited = !groupAlive && after.length === 0 && survivors.length === 0;
    this.stopped = exited;
    return {
      signalSent,
      pidsBefore: before.map((row) => row.pid),
      pidsAfter: [...new Set([...after, ...survivors])],
      exited,
      detail: exited
        ? `进程组 ${pid} 与后代均已退出`
        : `仍有存活进程：group=${groupAlive ? "alive" : "gone"} descendants=[${[...new Set([...after, ...survivors])].join(",")}]`,
    };
  }

  private signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    // 只对自己创建的组发信号：拒绝 1、0 和当前进程组，避免误伤用户服务。
    if (pid <= 1) throw new ZBridgeError("INVALID_ARGUMENT", "拒绝向非法进程组发送信号");
    const self = this.readTable();
    if (self.ok) {
      const ownGroup = ownProcessGroupId(self.rows);
      if (ownGroup !== null && ownGroup === pid) {
        throw new ZBridgeError("INVALID_ARGUMENT", "拒绝向当前进程组发送信号");
      }
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ESRCH") throw error;
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const owned = this.owned();
      if (!isProcessAlive(pid) && owned !== null && owned.length === 0) return;
      await this.sleep(50);
    }
  }

  get confirmedExited(): boolean {
    return this.stopped;
  }
}

function appendBounded(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function assertExecutable(executable: string): void {
  try {
    const stat = statSync(executable);
    if (!stat.isFile()) throw new Error("not a file");
    accessSync(executable, constants.X_OK);
  } catch {
    throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode 可执行文件不可用", {
      details: { executable },
    });
  }
}

/**
 * 只允许 loopback：即使 worker 报告了一个 LAN 地址也不能用，
 * 因为那意味着它监听面超出本机（或输出被篡改）。
 */
export function assertLoopbackUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "worker 输出的地址不合法");
  }
  if (parsed.protocol !== "http:") {
    throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "worker 必须使用 http 协议（本机回环）");
  }
  const host = parsed.hostname;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback) {
    throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "worker 必须监听 loopback；拒绝其它地址");
  }
  return `${parsed.protocol}//${parsed.host}`;
}
