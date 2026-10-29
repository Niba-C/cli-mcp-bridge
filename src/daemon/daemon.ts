/**
 * 本地 daemon（OC-04）。
 *
 * 职责：单实例锁、代际、工作区登记、启动恢复（worker 归属核对 + 数据库收敛）、
 * 两条 Unix IPC、调度与本地审批队列。gateway/客户端断开不影响 run；MCP gateway
 * 属 OC-05，本文件不实现。
 *
 * 边界（诚实声明）：
 * - 同 macOS 用户进程可以连上 operator socket、读取 worker 的 OPENCODE_SERVER_PASSWORD：
 *   本项**没有**建立 OS 级控制通道隔离，真实 edit 保持禁用，也不接受任何参数开启；
 * - daemon 只回收自己启动、且身份确认的 worker/后代；证据不足一律 unknown 并阻塞会话。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeHttpAdapter } from "../backend/opencode/adapter.ts";
import type { WorkerCommand } from "../backend/opencode/worker.ts";
import type { ProcessTableRead } from "../core/proc.ts";
import { pinnedServeCommand } from "../backend/opencode/worker.ts";
import { ensureBackendRuntime, hasBackendRuntime, registerBackendRuntime } from "../backend/registry.ts";
import { CodebuddyAdapter } from "../backend/codebuddy/adapter.ts";
import { QoderAdapter } from "../backend/qoder/adapter.ts";
import { SdkRunCoordinator } from "../backend/registry.ts";
import { OpenCodeRunCoordinator } from "../backend/opencode/coordinator.ts";
import {
  buildModelGate,
  parseModelRef,
  parseProviderConfigFile,
  LEGACY_MODEL_REF,
  type ModelGate,
} from "../backend/opencode/profile.ts";
import type { BackendModelSelection, BackendSessionRef } from "../contracts/backend.ts";
import { CONTRACT_VERSION, OPENCODE_ADAPTER_ID, OPENCODE_PINNED_VERSION, type BackendId } from "../contracts/version.ts";
import type { ProductConfig } from "../contracts/config.ts";
import { backendEntryFingerprint, privateFileDigest, providerEntriesDigest } from "../core/config-fingerprint.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import { payloadHash } from "../contracts/json.ts";
import { assertWorkspaceAllowed, type Principal } from "../contracts/common.ts";
import { newId, isId, type ArtifactId, type PrincipalId, type WorkspaceId, type RunId, type SessionId } from "../contracts/ids.ts";
import type { IsoTimestamp } from "../contracts/common.ts";
import { isTerminalRunState, type RunSnapshot } from "../contracts/run.ts";
import type { Run } from "../contracts/run.ts";
import type { ResultManifest } from "../storage/types.ts";
import type { WorkspaceSummary } from "../contracts/workspace.ts";
import { ArtifactManager } from "./artifacts.ts";
import { BridgeStore } from "../storage/store.ts";
import { DaemonApprovalQueue, type ApprovalListItem } from "./approvals.ts";
import { IpcServer } from "./ipc.ts";
import { resolveDaemonPaths, type DaemonPaths } from "./layout.ts";
import { ensureDaemonDir, InstanceLock, processIdentity } from "./lock.ts";
import { reclaimWorkerRecord, verifyOwnership, type OwnershipVerdict } from "./ownership.ts";
import { Scheduler, type QueuedView, type RuntimeHandle, type StopReport } from "./scheduler.ts";
import { WorkspaceManager, type RegistrationResult } from "./workspacemgr.ts";

export interface DaemonOptions {
  readonly dataRoot: string;
  /** 已通过 `validateConfigObject` 的产品配置（v3，或 v2 内存规范化结果）；daemon 不再接受配置注入。 */
  readonly config: ProductConfig;
  /**
   * OpenCode 可执行文件绝对路径（CLI 显式参数）。
   * 优先级：该次显式参数 > 配置项 backends.opencode.executable > 报错。
   */
  readonly executable?: string;
  /**
   * 供应商配置对象（含密钥）；只写进受控运行目录，绝不打印、不落库。
   * 显式参数优先；未提供时读配置项 backends.opencode.providerConfigFile。
   */
  readonly providerConfig?: unknown;
  /** **仅供离线测试**：用模拟服务子进程代替真实 `opencode serve`。 */
  readonly testBackendCommand?: { readonly fixturePath: string; readonly scenario: string };
  /**
   * **仅供离线测试**：SDK 后端（codebuddy/qoder）的 worker 注入 fake SDK 模块。
   * 生产路径未提供时对应后端不可选择（assertBackendSelectable 拒绝）。
   */
  readonly testSdkModuleIds?: { readonly codebuddy?: string; readonly qoder?: string };
  /**
   * **仅供离线测试**：缩短 SDK adapter 的 deadline 宽限，便于在秒级复现
   * 超时回收与调度串行；生产缺省为 worker 启动超时（20s）。
   */
  readonly testSdkDeadlineGraceMs?: number;
  /** **仅供离线测试**：注入进程表读取（验证恢复的保守分支）。 */
  readonly testProcessTable?: () => ProcessTableRead;
  readonly now?: () => IsoTimestamp;
  readonly onEvent?: (message: string) => void;
  /** 本进程实际加载的配置文件路径；仅供 operator 管理状态，不进入 client/MCP 输出。 */
  readonly sourceConfigPath?: string;
  /** 显式覆盖的供应商文件路径（仅用于 status 说明覆盖来源）。 */
  readonly sourceProviderConfigPath?: string;
}

/** OC-09：单个后端在本 daemon 中加载后的摘要（客户端可见，无本机路径/凭据）。 */
export interface BackendStatusSummary {
  readonly id: BackendId;
  readonly adapter: string;
  readonly enabled: boolean;
  /** daemon 当前进程已加载该配置项（不是磁盘文件是否变化）。 */
  readonly loaded: boolean;
  readonly runtimeState: "not_started" | "running" | "stopped" | "unknown";
  readonly defaultModel: string | null;
  readonly allowedModels: readonly string[];
  /** 配置锁定的版本；不是观测值。 */
  readonly configuredVersion: string;
  /** 运行时实际观测到的版本；没有证据时为 null。 */
  readonly observedVersion: string | null;
}

/** 本机管理状态：只在 operator 通道返回，包含无凭据的加载摘要。 */
export interface BackendManagementStatus extends BackendStatusSummary {
  readonly entryFingerprint: string;
  readonly privateConfigDigest: string | null;
  readonly executable: string | null;
  readonly executableSource: "cli_override" | "config" | "default" | null;
  readonly providerConfigFile: string | null;
  readonly providerConfigSource: "cli_override" | "config" | null;
  readonly providerConfigDigest: string | null;
  readonly authMode: "cli-login" | "credential-file" | null;
  readonly authFile: string | null;
}

export interface ManagementStatus extends DaemonStatus {
  readonly loadedConfigPath: string | null;
  readonly backendDetails: readonly BackendManagementStatus[];
  readonly overrides: {
    readonly executable: string | null;
    readonly providerConfigFile: string | null;
  };
}

export interface DaemonStatus {
  /** OC-09：产品契约版本；新 gateway/CLI 用它在派发前识别旧 daemon。 */
  readonly contractVersion: string;
  readonly running: boolean;
  readonly pid: number;
  readonly serviceEpoch: number;
  readonly serverEpoch: number | null;
  readonly activeRunId: RunId | null;
  readonly queue: readonly QueuedView[];
  readonly pendingApprovals: number;
  readonly workspaces: number;
  readonly sessions: number;
  readonly editEnabled: false;
  readonly controlChannelIsolation: "unverified";
  readonly lastRecovery: RecoverySummary | null;
  /** OC-05：gateway capabilities 需要的受控上限（timeoutMs 校验等）。 */
  readonly limits: {
    readonly activeRuns: number;
    readonly runTimeoutMs: number;
    readonly waitTimeoutMs: number;
    readonly queueTtlMs: number;
    readonly approvalTimeoutMs: number;
    readonly artifactMaxBytes: number;
  };
  /**
   * OC-08：OpenCode 本地模型允许列表摘要（兼容视图，固定指 opencode）。
   * OC-09：未配置 OpenCode 时为 null；查询不启动 worker、不调用模型。
   */
  readonly models: {
    readonly default: string;
    readonly allowed: readonly string[];
  } | null;
  /** OC-09：新会话省略 backend 时的默认后端（本进程已加载值）。 */
  readonly defaultBackend: BackendId;
  /** OC-09：三个后端中已配置项的顺序稳定摘要（仅已配置项）。 */
  readonly backends: readonly BackendStatusSummary[];
}

export interface WorkerRecoveryReport {
  readonly serverEpoch: number;
  readonly pid: number;
  readonly verdict: OwnershipVerdict["kind"];
  readonly attempted: boolean;
  readonly confirmedStopped: boolean;
  readonly detail: string;
}

export interface RecoverySummary {
  readonly at: IsoTimestamp;
  readonly workers: readonly WorkerRecoveryReport[];
  readonly runsConverged: number;
  readonly blockedSessions: number;
  readonly notes: readonly string[];
}

interface WorkspaceRuntime {
  handle: RuntimeHandle | null;
  readonly workspaceId: WorkspaceId;
  generation: number;
  /** 登记产物的工作副本根；SDK worker 的 cwd 来源（OC-09）。 */
  copyRoot: string | null;
}

export class Daemon {
  private readonly options: DaemonOptions;
  private readonly paths: DaemonPaths;
  private readonly lock: InstanceLock;
  /** OC-08：从 opencode `modelProfiles` 生成的允许列表；未配置 opencode 时为 null。 */
  private readonly modelGate: ModelGate | null;
  /** OC-09：v3 配置里的 opencode 项（v2 输入经内存规范化后同样有这一项；可缺失）。 */
  private readonly opencodeConfig: Extract<ProductConfig["backends"][string], { adapter: "opencode-http" }> | null;
  /** 解析后的供应商配置（providerID → OpenCode 配置对象；含密钥，不打印不落库）。 */
  private readonly providerEntries: Readonly<Record<string, unknown>>;
  private readonly entryFingerprints = new Map<BackendId, string>();
  private readonly privateConfigDigests = new Map<BackendId, string | null>();
  private readonly loadedProviderDigest: string | null;
  private store: BridgeStore | null = null;
  private serviceEpoch = 0;
  private principalIdValue: PrincipalId | null = null;
  private readonly clientServer: IpcServer;
  private readonly operatorServer: IpcServer;
  private approvals: DaemonApprovalQueue | null = null;
  private scheduler: Scheduler | null = null;
  private artifacts: ArtifactManager | null = null;
  private readonly runtimes = new Map<WorkspaceId, WorkspaceRuntime>();
  /** OC-09：SDK 后端运行时按产品会话独立（key = backendId:sessionId）。 */
  private readonly sdkRuntimes = new Map<string, { readonly handle: RuntimeHandle; workspaceId: WorkspaceId; generation: number }>();
  private lastRecovery: RecoverySummary | null = null;
  private running = false;
  private shuttingDown = false;
  private observerTimer: NodeJS.Timeout | null = null;
  private observerBusy = false;

  /** 后代身份观测频率：足够捕捉「服务先死、shell 还活着」的窗口。 */
  private static readonly OBSERVE_INTERVAL_MS = 1_000;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.paths = resolveDaemonPaths(options.dataRoot);
    this.lock = new InstanceLock(this.paths.lockFile);
    // OC-09：配置是 v3 三后端结构（v2 输入已在读取边界内存规范化）。
    // OpenCode 项可缺失：只启用 CodeBuddy/Qoder 的实例不要求 OpenCode 可执行文件
    // 或供应商配置；缺失时 opencode 选择由 assertBackendSelectable 明确拒绝。
    const opencodeEntry = options.config.backends.opencode;
    if (opencodeEntry !== undefined && opencodeEntry.adapter !== OPENCODE_ADAPTER_ID) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "backends.opencode 的 adapter 不是 opencode-http", {
        details: { adapter: opencodeEntry.adapter },
      });
    }
    this.opencodeConfig = opencodeEntry ?? null;
    // OC-08：配置与供应商文件在构造期解析，格式错误让 daemon 启动直接失败；
    // default 供应商必须存在（worker 配置的 model/small_model 依赖它）。
    // OC-09：disabled 的 OpenCode 项不要求供应商配置——禁用后端的缺失项不能阻塞启动。
    this.modelGate = opencodeEntry === undefined ? null : buildModelGate(opencodeEntry.modelProfiles);
    this.providerEntries = opencodeEntry !== undefined && opencodeEntry.enabled ? this.resolveProviderEntries() : {};
    if (opencodeEntry !== undefined && opencodeEntry.enabled && this.modelGate !== null && !Object.hasOwn(this.providerEntries, this.modelGate.defaultModel.providerID)) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "供应商配置缺少 default profile 指向的供应商", {
        details: { providerID: this.modelGate.defaultModel.providerID, configured: Object.keys(this.providerEntries) },
      });
    }
    // OC-09 管理状态：加载期快照指纹（不含凭据内容），供 status 比对磁盘配置。
    this.loadedProviderDigest = opencodeEntry !== undefined && opencodeEntry.enabled ? providerEntriesDigest(this.providerEntries) : null;
    for (const [id, entry] of Object.entries(options.config.backends) as Array<[BackendId, ProductConfig["backends"][string]]>) {
      this.entryFingerprints.set(id, backendEntryFingerprint(entry));
      const privateDigest =
        entry.adapter === OPENCODE_ADAPTER_ID
          ? null
          : entry.auth.mode === "cli-login"
            ? null
            : privateFileDigest(entry.auth.file);
      this.privateConfigDigests.set(id, privateDigest);
    }
    this.clientServer = new IpcServer({
      path: this.paths.clientSocket,
      source: "client",
      handler: (context) => this.handleClient(context.envelope.kind, context.envelope.payload, context.signal),
    });
    this.operatorServer = new IpcServer({
      path: this.paths.operatorSocket,
      source: "operator",
      handler: (context) => this.handleOperator(context.envelope.kind, context.envelope.payload),
    });
  }

  // ---------------------------------------------------------------- 启动

  async start(): Promise<void> {
    if (this.running) return;
    ensureDaemonDir(this.paths.dataRoot);
    ensureDaemonDir(this.paths.daemonDir);
    chmodSync(this.paths.daemonDir, 0o700);
    chmodSync(this.paths.dataRoot, 0o700);
    this.lock.acquire();

    try {
      const dbDir = join(this.paths.dataRoot, "data");
      ensureDaemonDir(dbDir);
      this.store = BridgeStore.open(join(dbDir, "opencode-bridge.sqlite"));
      const service = this.store.beginService({ pid: process.pid });
      this.serviceEpoch = service.serviceEpoch;
      this.principalIdValue = this.ensurePrincipal();
      const registrations = new WorkspaceManager(this.store, this.paths).registerAllFromConfig(this.options.config);
      for (const registration of registrations) {
        this.runtimes.set(registration.workspace.workspaceId, {
          handle: null,
          workspaceId: registration.workspace.workspaceId,
          generation: registration.workspace.generation,
          copyRoot: registration.workspace.copyRoot ?? null,
        });
      }
      this.approvals = new DaemonApprovalQueue(this.store);
      ensureDaemonDir(this.paths.artifactsDir);
      this.artifacts = new ArtifactManager(this.store, this.paths.artifactsDir, this.options.config.limits);
      this.registerSdkBackendRuntimes();
      this.scheduler = this.buildScheduler();
      // 恢复必须先于任何监听：旧 worker 收敛完成、unknown 全部落账后才开始服务。
      this.lastRecovery = await this.recover();
      await this.clientServer.start();
      await this.operatorServer.start();
      this.running = true;
      this.writeRunInfo();
      this.startObserver();
    } catch (error) {
      this.cleanupAfterFailedStart();
      throw error;
    }
  }

  private buildScheduler(): Scheduler {
    const store = this.requireStore();
    const approvals = this.requireApprovals();
    if (this.principalIdValue === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "principal 未初始化");
    return new Scheduler({
      store,
      approvals,
      principalId: this.principalIdValue,
      backendSelection: {
        defaultBackendId: () => this.options.config.defaultBackend,
        assertBackendSelectable: (backendId) => this.assertBackendSelectable(backendId),
      },
      runtime: {
        ensure: (backendId, workspaceId, generation, sessionId) => this.ensureRuntime(backendId, workspaceId, generation, sessionId),
        prepareSession: (handle, sessionId, model) => this.prepareSession(handle, sessionId, model),
        beforeDispatch: (_handle, runId) => this.captureRunBaseline(runId),
        onRunSettled: (handle, runId) => this.onRunSettled(handle, runId),
        closeAll: async () => this.closeRuntimes(),
      },
      limits: {
        activeRuns: this.options.config.limits.activeRuns,
        queueTtlMs: this.options.config.limits.queueTtlMs,
        runTimeoutMs: this.options.config.limits.runTimeoutMs,
        queueCapacity: 20,
        stopGraceMs: 3_000,
      },
      onEvent: this.options.onEvent,
    });
  }

  private cleanupAfterFailedStart(): void {
    // 启动失败也要关掉可能已经监听的 socket，不留「半启动」现场。
    try {
      void this.clientServer.close();
    } catch {
      // 未监听时 close 无操作。
    }
    try {
      void this.operatorServer.close();
    } catch {
      // 同上。
    }
    this.stopObserver();
    this.lock.release();
    try {
      this.store?.close();
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    this.store = null;
  }

  private ensurePrincipal(): PrincipalId {
    const existing = (() => {
      if (!existsSync(this.paths.principalFile)) return null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.paths.principalFile, "utf8"));
        if (parsed === null || typeof parsed !== "object") return null;
        const candidate = (parsed as Record<string, unknown>)["principalId"];
        if (typeof candidate === "string" && isId("principal", candidate)) return candidate as PrincipalId;
        return null;
      } catch {
        return null;
      }
    })();
    if (existing !== null) return existing;
    mkdirSync(join(this.paths.dataRoot, "operator"), { recursive: true, mode: 0o700 });
    const created = newId("principal");
    writeFileSync(this.paths.principalFile, `${JSON.stringify({ principalId: created })}\n`, { mode: 0o600 });
    return created;
  }

  private principal() {
    if (this.principalIdValue === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return {
      principalId: this.principalIdValue,
      allowedWorkspaces: [...this.runtimes.keys()],
      role: "owner" as const,
    };
  }

  // ---------------------------------------------------------------- 恢复

  private async recover(): Promise<RecoverySummary> {
    const store = this.requireStore();
    const workerReports: WorkerRecoveryReport[] = [];
    // active：需要归属核对与回收；unknown：此前已判定不可归因，绝不发信号，只入报告。
    for (const record of store.listWorkersByStatus("active")) {
      const verdict = verifyOwnership(record);
      const reclaim = await reclaimWorkerRecord(record, {
        ...(this.options.testProcessTable === undefined ? {} : { readTable: this.options.testProcessTable }),
        graceMs: 3_000,
      });
      const status = reclaim.confirmedStopped ? "stopped" : verdict.kind === "pid_reused" ? "unknown" : "crashed";
      store.markWorkerStatus(record.serverEpoch, status, { note: `${verdict.kind}: ${reclaim.detail}` });
      if (!reclaim.confirmedStopped) {
        // 旧 worker 代际已不可用：绑定与 dispatch 由 recoverPendingRuns 收敛为 unknown。
        store.stopServer(record.serverEpoch, store.now(), "crashed");
      }
      workerReports.push({
        serverEpoch: record.serverEpoch,
        pid: record.pid,
        verdict: verdict.kind,
        attempted: reclaim.attempted,
        confirmedStopped: reclaim.confirmedStopped,
        detail: reclaim.detail,
      });
      this.options.onEvent?.(
        `recovery worker ${record.serverEpoch}: ${verdict.kind}, attempted=${reclaim.attempted}, confirmed=${reclaim.confirmedStopped}`,
      );
    }
    for (const record of store.listWorkersByStatus("unknown")) {
      workerReports.push({
        serverEpoch: record.serverEpoch,
        pid: record.pid,
        verdict: "unreadable",
        attempted: false,
        confirmedStopped: false,
        detail: record.note ?? "此前已判定不可归因；保持 unknown，不发信号",
      });
    }
    const dbReport = store.recoverPendingRuns();
    const blockedSessions = dbReport.runs.filter((run) => run.blocked).length;
    return {
      at: store.now(),
      workers: workerReports,
      runsConverged: dbReport.runs.length,
      blockedSessions,
      notes: [
        "daemon 恢复：先核对 worker/后代身份再回收；PID 复用、身份缺失或进程表不可读时不发信号",
        "recoverPendingRuns 只收敛数据库状态；unknown 会话需 operator 显式解除阻塞",
        "同一产品 session 重启后在同一受控数据目录加载旧 backendSessionId（epoch 推进）；加载失败明确报错，不静默换空会话",
        "daemon 强退期间排队的 run（未派发）由恢复收敛为 cancelled；已派发的收敛为 unknown，不重发",
      ],
    };
  }

  // ---------------------------------------------------------------- 运行时

  /**
   * 每个 workspace 一个**稳定**的受控运行目录（独立 HOME／XDG／config／data）。
   * worker 换代时复用同一目录：这是「同数据目录重启后 load 旧 backendSession」
   * 的前提（OC-03 已验证）；审批与派发仍按 serverEpoch 隔离，不会跨代复用在途状态。
   */
  private runDirFor(workspaceId: WorkspaceId): string {
    return join(this.paths.dataRoot, "backend", `ws-${workspaceId}`);
  }

  /** 只保留允许列表覆盖的供应商（登记集合）；顺序稳定，凭据不离开本进程与受控运行目录。 */
  private registeredProviderConfigs(): Readonly<Record<string, unknown>> {
    if (this.modelGate === null) return {};
    const registered = new Set(this.modelGate.providerIDs);
    return Object.fromEntries(
      Object.entries(this.providerEntries)
        .filter(([id]) => registered.has(id))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  private backendCommand(): WorkerCommand {
    if (this.options.testBackendCommand !== undefined) {
      return {
        executable: process.execPath,
        args: [
          this.options.testBackendCommand.fixturePath,
          "--log",
          this.paths.backendLog,
          "--scenario",
          this.options.testBackendCommand.scenario,
        ],
      };
    }
    // 优先级：本次显式参数 > 配置项 backends.opencode.executable（v2 规范化为 null）。
    const executable = this.options.executable ?? this.opencodeConfig?.executable ?? undefined;
    if (executable === undefined || !executable.startsWith("/")) {
      throw new ZBridgeError("INVALID_ARGUMENT", "缺少 OpenCode 可执行文件绝对路径（--opencode 或 backends.opencode.executable）");
    }
    return pinnedServeCommand(executable);
  }

  /**
   * 供应商配置解析：显式传入对象优先；否则读配置项 providerConfigFile。
   * 两处都没有时按历史行为报错——缺失 default 供应商配置的 daemon 无法服务模型请求。
   */
  private resolveProviderEntries(): Readonly<Record<string, unknown>> {
    if (this.options.providerConfig !== undefined) {
      return parseProviderConfigFile(this.options.providerConfig);
    }
    const file = this.opencodeConfig?.providerConfigFile ?? null;
    if (file !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new ZBridgeError("BACKEND_UNAVAILABLE", "backends.opencode.providerConfigFile 不是可解析的 JSON", {
          details: { reason: error instanceof Error ? error.message : String(error) },
        });
      }
      return parseProviderConfigFile(parsed);
    }
    throw new ZBridgeError("BACKEND_UNAVAILABLE", "缺少 OpenCode 供应商配置（显式参数或 backends.opencode.providerConfigFile）");
  }

  /**
   * OC-09：backend 可选性裁决。已配置、enabled、支持 review 才可选；
   * 未注册运行时工厂的后端在 ensureRuntime 阶段仍会明确失败（受理成功但派发失败
   * 不是本阶段交付语义，因此工厂未接入时这里直接拒绝受理）。
   */
  /**
   * OC-09-05：为配置启用且可执行的 SDK 后端注册运行时工厂（每产品会话一个
   * adapter 实例）。生产路径使用真实 SDK；测试路径经 testSdkModuleIds 注入
   * fake 模块。未启用/未登记的后端不注册——受理与派发路径都会明确拒绝。
   */
  private registerSdkBackendRuntimes(): void {
    const stateRoot = join(this.paths.dataRoot, "backends");
    for (const backendId of ["codebuddy", "qoder"] as const) {
      const entry = this.options.config.backends[backendId];
      if (entry === undefined || !entry.enabled) continue;
      if (hasBackendRuntime(backendId)) continue;
      const testSdkModuleId = this.options.testSdkModuleIds?.[backendId];
      const stateDir = join(stateRoot, backendId);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      if (backendId === "codebuddy") {
        const executable = entry.adapter === "codebuddy-sdk" ? entry.executable : "";
        registerBackendRuntime("codebuddy", async (context) => {
          const server = this.requireStore().beginServerInstance({
            serviceEpoch: this.serviceEpoch,
            backendId: "codebuddy",
            runDir: null,
          });
          const adapter = new CodebuddyAdapter({
            executable,
            stateRoot: join(stateDir, `ses-${context.sessionId}`),
            workspaceRoot: this.workspaceRootFor(context.workspaceId),
            serverEpoch: server.serverEpoch,
            approvalTimeoutMs: this.options.config.limits.approvalTimeoutMs,
            ...(testSdkModuleId === undefined ? {} : { sdkModuleId: testSdkModuleId }),
            ...(this.options.testSdkDeadlineGraceMs === undefined ? {} : { deadlineGraceMs: this.options.testSdkDeadlineGraceMs }),
            onWorkerSpawned: (info) => {
              this.requireStore().recordWorkerStart({
                serverEpoch: server.serverEpoch,
                serviceEpoch: this.serviceEpoch,
                pid: info.pid,
                pgid: info.pgid,
                processIdentity: info.processIdentity,
                executable,
                runDir: stateDir,
                backendId: "codebuddy",
              });
            },
            onWorkerExited: (info) => {
              try {
                this.requireStore().markWorkerStatus(
                  server.serverEpoch,
                  info.expected ? "stopped" : info.remaining === 0 ? "crashed" : "unknown",
                  {
                    note: info.expected
                      ? "sdk worker exited after shutdown"
                      : `sdk worker exited unexpectedly (owned=${info.remaining})`,
                  },
                );
              } catch {
                // 状态回落失败只影响恢复报告，不影响 run 终态。
              }
            },
          });
          const store = this.requireStore();
          return {
            adapter,
            coordinator: new SdkRunCoordinator(adapter, store, this.approvals, "oc09-sdk-v1", (message) => this.options.onEvent?.(message)),
            serverEpoch: server.serverEpoch,
          };
        });
      } else {
        const qoderEntry = entry.adapter === "qoder-sdk" ? entry : null;
        const executable = qoderEntry?.executable ?? "";
        const authFile = qoderEntry !== null && qoderEntry.auth.mode === "credential-file" ? qoderEntry.auth.file : null;
        registerBackendRuntime("qoder", async (context) => {
          const server = this.requireStore().beginServerInstance({
            serviceEpoch: this.serviceEpoch,
            backendId: "qoder",
            runDir: null,
          });
          const adapter = new QoderAdapter({
            executable,
            stateRoot: join(stateDir, `ses-${context.sessionId}`),
            workspaceRoot: this.workspaceRootFor(context.workspaceId),
            serverEpoch: server.serverEpoch,
            authFile,
            authMode: qoderEntry?.auth.mode ?? "credential-file",
            approvalTimeoutMs: this.options.config.limits.approvalTimeoutMs,
            ...(testSdkModuleId === undefined ? {} : { sdkModuleId: testSdkModuleId }),
            ...(this.options.testSdkDeadlineGraceMs === undefined ? {} : { deadlineGraceMs: this.options.testSdkDeadlineGraceMs }),
            onWorkerSpawned: (info) => {
              this.requireStore().recordWorkerStart({
                serverEpoch: server.serverEpoch,
                serviceEpoch: this.serviceEpoch,
                pid: info.pid,
                pgid: info.pgid,
                processIdentity: info.processIdentity,
                executable,
                runDir: stateDir,
                backendId: "qoder",
              });
            },
            onWorkerExited: (info) => {
              try {
                this.requireStore().markWorkerStatus(
                  server.serverEpoch,
                  info.expected ? "stopped" : info.remaining === 0 ? "crashed" : "unknown",
                  {
                    note: info.expected
                      ? "sdk worker exited after shutdown"
                      : `sdk worker exited unexpectedly (owned=${info.remaining})`,
                  },
                );
              } catch {
                // 状态回落失败只影响恢复报告，不影响 run 终态。
              }
            },
          });
          const store = this.requireStore();
          return {
            adapter,
            coordinator: new SdkRunCoordinator(adapter, store, this.approvals, "oc09-sdk-v1", (message) => this.options.onEvent?.(message)),
            serverEpoch: server.serverEpoch,
          };
        });
      }
    }
  }

  /** 登记工作副本根（SDK worker 的 cwd）。 */
  private workspaceRootFor(workspaceId: string): string {
    const runtime = [...this.runtimes.values()].find((candidate) => candidate.workspaceId === workspaceId);
    const copyRoot = runtime?.copyRoot ?? null;
    if (copyRoot === null) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "工作副本缺失，无法创建 SDK worker");
    }
    return copyRoot;
  }

  private assertBackendSelectable(backendId: BackendId): void {
    const entry = this.options.config.backends[backendId];
    if (entry === undefined) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", `后端 ${backendId} 未在配置中登记`, {
        details: { backendId },
      });
    }
    if (!entry.enabled) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", `后端 ${backendId} 处于禁用状态`, {
        details: { backendId },
      });
    }
    // opencode 的运行时是 daemon 内置路径（ensureOpencodeRuntime 按工作区缓存）；
    // SDK 后端必须已在启动期注册工厂，否则受理成功也无法派发，直接拒绝。
    if (backendId !== "opencode" && !hasBackendRuntime(backendId)) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", `后端 ${backendId} 的执行链路尚未接入本 daemon`, {
        details: { backendId },
      });
    }
  }

  private async ensureRuntime(backendId: BackendId, workspaceId: WorkspaceId, workspaceGeneration: number, sessionId: SessionId): Promise<RuntimeHandle> {
    if (backendId === "opencode") {
      if (this.opencodeConfig === null || this.modelGate === null) {
        throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode 未在配置中登记", { details: { backendId } });
      }
      return this.ensureOpencodeRuntime(workspaceId, workspaceGeneration);
    }
    return this.ensureSdkRuntime(backendId, workspaceId, workspaceGeneration, sessionId);
  }

  /**
   * OC-09-05：SDK 后端运行时按产品会话独占（key = backendId:sessionId）。
   * 同会话复用存活 worker（原生上下文本就在 worker/SDK 会话里）；worker 已死
   * 则关闭旧 adapter 并重建。厂商工厂未注册时明确失败，不改投其它后端。
   */
  private async ensureSdkRuntime(backendId: BackendId, workspaceId: WorkspaceId, workspaceGeneration: number, sessionId: SessionId): Promise<RuntimeHandle> {
    const key = `${backendId}:${sessionId}`;
    const cached = this.sdkRuntimes.get(key);
    if (cached !== undefined) {
      if (cached.workspaceId === workspaceId && cached.generation === workspaceGeneration && cached.handle.adapter.isWorkerAlive) {
        return cached.handle;
      }
      this.sdkRuntimes.delete(key);
      try {
        await cached.handle.adapter.close();
      } catch {
        // 旧 worker 已退出：close 可能报 STOP_UNCONFIRMED；新实例继续。
      }
      try {
        this.requireStore().markWorkerStatus(cached.handle.serverEpoch, "stopped", { note: "sdk runtime replaced" });
      } catch {
        // 状态标记失败不阻塞新运行时。
      }
    }
    if (!hasBackendRuntime(backendId)) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", `后端 ${backendId} 的运行时工厂未注册`, { details: { backendId } });
    }
    let runtime;
    try {
      runtime = await ensureBackendRuntime({ backendId, workspaceId, workspaceGeneration, sessionId });
    } catch (error) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", `后端 ${backendId} 运行时创建失败`, {
        cause: error instanceof Error ? error : undefined,
        details: { backendId, reason: error instanceof Error ? error.message : String(error) },
      });
    }
    const handle: RuntimeHandle = {
      backendId,
      adapter: runtime.adapter,
      coordinator: runtime.coordinator,
      serverEpoch: runtime.serverEpoch,
      workspaceId,
      workspaceGeneration,
    };
    this.sdkRuntimes.set(key, { handle, workspaceId, generation: workspaceGeneration });
    return handle;
  }

  private async ensureOpencodeRuntime(workspaceId: WorkspaceId, workspaceGeneration: number): Promise<RuntimeHandle> {
    const store = this.requireStore();
    const opencodeConfig = this.opencodeConfig;
    if (opencodeConfig === null) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "OpenCode 未在配置中登记", { details: { backendId: "opencode" } });
    }
    const workspace = store.workspaces.require(workspaceId);
    if (workspace.copyRoot === null) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "工作副本缺失，拒绝启动 worker");
    }
    const runtime = this.runtimes.get(workspaceId);
    if (runtime === undefined) {
      throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", "workspace 未在本次 daemon 生命周期内登记");
    }
    if (runtime.handle !== null && runtime.generation === workspaceGeneration && runtime.handle.adapter.isWorkerAlive) {
      return runtime.handle;
    }
    if (runtime.handle !== null) {
      // worker 退出或 workspace 重新登记：换新代际。scheduler 保证此刻无活动 run。
      try {
        await runtime.handle.adapter.close();
      } catch {
        // 旧 worker 已退出的场景 close 可能报 STOP_UNCONFIRMED；新代际继续。
      }
      runtime.handle = null;
    }
    runtime.generation = workspaceGeneration;
    const server = store.beginServerInstance({ serviceEpoch: this.serviceEpoch, backendId: "opencode", runDir: null });
    const serverEpoch = server.serverEpoch;
    const runDir = this.runDirFor(workspaceId);
    const executable = this.backendCommand().executable;
    const adapter = new OpenCodeHttpAdapter({
      executable,
      workspaceRoot: workspace.copyRoot,
      runDir,
      providerConfigs: this.registeredProviderConfigs(),
      modelProfiles: opencodeConfig.modelProfiles,
      policyProfile: "review",
      serverEpoch,
      pinnedVersion: OPENCODE_PINNED_VERSION,
      approvalTimeoutMs: this.options.config.limits.approvalTimeoutMs,
      startupTimeoutMs: 20_000,
      testCommand: this.options.testBackendCommand === undefined ? undefined : this.backendCommand(),
      ...(this.options.testProcessTable === undefined ? {} : { testProcessTable: this.options.testProcessTable }),
      // spawn 之后、健康检查之前先落身份：daemon 在这个窗口被杀也能安全回收。
      onSpawned: (spawned) => {
        // 持久化失败必须抛回 worker 启动路径；adapter 会清理刚 spawn 的进程。
        // 没有归属记录的 worker 不能进入健康检查、建会话或发送模型请求。
        store.recordWorkerStart({
          serverEpoch,
          serviceEpoch: this.serviceEpoch,
          pid: spawned.pid,
          pgid: spawned.processGroupId > 1 ? spawned.processGroupId : spawned.pid,
          processIdentity: processIdentity(spawned.pid),
          executable,
          runDir,
        });
      },
    });
    const coordinator = new OpenCodeRunCoordinator(store, adapter, {
      onApprovalRecorded: (approval, request) => this.approvals?.approvalRecorded(approval, request),
      onApproval: (request) =>
        this.approvals?.waitForDecision(request) ?? Promise.resolve({ decision: "channel_lost", actor: "channel_lost" }),
      policyVersion: "oc04-controlled-v1",
      onWarning: (message) => this.options.onEvent?.(`coordinator: ${message}`),
    });
    const handle: RuntimeHandle = { backendId: "opencode", adapter, coordinator, serverEpoch, workspaceId, workspaceGeneration };
    runtime.handle = handle;
    return handle;
  }

  /**
   * OC-09：codebuddy/qoder 的原生模型解析。显式值必须在对应后端 allowed 内；
   * 继承沿用会话 lastSelectedModel / run 历史（该后端的 run）；新会话用该后端 default。
   * 原生 ID 允许列表来自 v3 配置 models.allowed；格式由 admitRun 二次收紧。
   */
  private resolveNativeModelForNewRequest(backendId: BackendId, explicit: string | undefined, sessionId: SessionId | undefined): string {
    const entry = this.options.config.backends[backendId];
    if (entry === undefined || entry.adapter === OPENCODE_ADAPTER_ID) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", `后端 ${backendId} 未配置或不是 SDK 后端`, { details: { backendId } });
    }
    if (!entry.enabled) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", `后端 ${backendId} 处于禁用状态`, { details: { backendId } });
    }
    const allowed = entry.models.allowed;
    const assertAllowed = (model: string): string => {
      if (!allowed.includes(model)) {
        throw new ZBridgeError("PROFILE_NOT_ALLOWED", `model 不在 ${backendId} 的允许列表内`, {
          details: { backendId, requested: model, allowed },
        });
      }
      return model;
    };
    if (explicit !== undefined) return assertAllowed(explicit);
    if (sessionId !== undefined) {
      const store = this.requireStore();
      const session = store.sessions.get(sessionId);
      const inherited =
        session?.lastSelectedModel ??
        (session === null
          ? null
          : (() => {
              const lastRun = store.runs.lastBySession(sessionId);
              return lastRun === null || lastRun.backendId !== backendId ? null : lastRun.selectedModel;
            })());
      if (inherited !== null) return assertAllowed(inherited);
    }
    return entry.models.default;
  }

  private async prepareSession(handle: RuntimeHandle, sessionId: SessionId, model: BackendModelSelection): Promise<void> {
    const store = this.requireStore();
    const session = store.sessions.require(sessionId);
    if (session.backendId !== handle.backendId) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "session 后端归属与运行时不一致，拒绝派发", {
        details: { sessionBackend: session.backendId, runtimeBackend: handle.backendId },
      });
    }
    if (session.backendSessionId !== null && session.serverEpoch === handle.serverEpoch) return;
    const workspace = store.workspaces.require(session.workspaceId);
    if (workspace.copyRoot === null) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "工作副本缺失，无法创建后端会话");
    }
    if (session.backendSessionId !== null) {
      // 已有绑定：同一产品 session 换代后必须在**同一受控数据目录**里加载旧
      // backendSessionId（OC-03/OC-09 已验证 load 可用），绝不静默新建空会话顶替上下文。
      let ref: BackendSessionRef;
      try {
        ref = await handle.adapter.loadSession({
          backendSessionId: session.backendSessionId,
          serverEpoch: handle.serverEpoch,
          backendVersion: null,
        });
      } catch (error) {
        // 明确失败并保持原绑定：不静默换空会话假装续接。
        throw new ZBridgeError(
          "BACKEND_UNAVAILABLE",
          "旧后端会话加载失败；产品 session 保持原绑定不阻塞式换新，请新建 session 或人工核对受控数据目录",
          error instanceof Error ? { cause: error } : {},
        );
      }
      const rebound = store.bindSessionBackend(sessionId, ref.backendSessionId, ref.serverEpoch);
      if (rebound.backendSessionId !== session.backendSessionId || rebound.serverEpoch !== handle.serverEpoch) {
        throw new ZBridgeError("EPOCH_MISMATCH", "后端会话重绑定结果与预期不一致，拒绝继续");
      }
      return;
    }
    const ref = await handle.adapter.createSession({
      workspaceRoot: workspace.copyRoot,
      profile: session.profile,
      policyProfile: "review",
      // OpenCode 需要双段选择并做允许列表校验；SDK 适配器的 createSession
      // 不消费模型（首轮 execute 才携带），给一个中立的占位选择即可。
      model: model.opencode ?? { providerID: handle.backendId, modelID: model.modelRef },
      runDir: this.runDirFor(handle.workspaceId),
    });
    store.bindSessionBackend(sessionId, ref.backendSessionId, ref.serverEpoch);
  }

  private onRunSettled(handle: RuntimeHandle, runId: RunId): void {
    const store = this.requireStore();
    // OC-09：SDK 的原生会话 ID 首轮后才由 worker 上报。把产品会话绑定从
    // 占位值改成真实 ID，重启后才能在同目录 resume 而非新建空会话。
    if (handle.backendId !== "opencode") {
      const liveId = handle.adapter.backendSessionId;
      if (typeof liveId === "string" && liveId.length > 0) {
        try {
          const run = store.runs.require(runId);
          const session = store.sessions.require(run.sessionId);
          if (liveId !== session.backendSessionId) {
            store.bindSessionBackend(session.sessionId, liveId, handle.serverEpoch);
          }
        } catch (error) {
          this.options.onEvent?.(`sdk session rebind failed (run ${runId}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    // 归属证据落库：每个后代连同观察时刻的 lstart 身份一起保存；
    // 恢复时逐个核对，PID 复用不会导致误杀。
    const observations = handle.adapter.ownedProcessIds().map((pid) => ({ pid, identity: processIdentity(pid) }));
    try {
      store.recordWorkerDescendants(handle.serverEpoch, observations);
    } catch {
      // 记录失败只影响恢复的精细度；worker 主记录仍在。
    }
    // OC-05：结果/事件/diff 工件。异步执行，失败只记日志，不改 run 终态。
    void this.captureArtifacts(runId);
  }

  private requireArtifacts(): ArtifactManager {
    if (this.artifacts === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return this.artifacts;
  }

  /** 派发前基线：diff 工件的对照点，排除登记前已有改动。 */
  private captureRunBaseline(runId: RunId): void {
    try {
      const store = this.requireStore();
      const run = store.runs.require(runId);
      const session = store.sessions.require(run.sessionId);
      const workspace = store.workspaces.require(session.workspaceId);
      if (workspace.copyRoot !== null) {
        this.requireArtifacts().captureBaseline(runId, workspace.copyRoot);
      }
    } catch (error) {
      this.options.onEvent?.(`baseline capture failed (run ${runId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async captureArtifacts(runId: RunId): Promise<void> {
    try {
      const store = this.requireStore();
      const run = store.runs.require(runId);
      const session = store.sessions.require(run.sessionId);
      const workspace = store.workspaces.require(session.workspaceId);
      const report = this.requireArtifacts().captureRunArtifacts({
        runId,
        state: run.state,
        ownerId: session.ownerId as PrincipalId,
        copyRoot: workspace.copyRoot,
      });
      for (const note of report.notes) this.options.onEvent?.(`artifacts: ${note}`);
    } catch (error) {
      this.options.onEvent?.(`artifact capture failed (run ${runId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async closeRuntimes(): Promise<void> {
    const store = this.requireStore();
    for (const runtime of this.runtimes.values()) {
      const handle = runtime.handle;
      if (handle === null) continue;
      try {
        await handle.adapter.close();
        store.markWorkerStatus(handle.serverEpoch, "stopped", { note: "daemon shutdown" });
        store.stopServer(handle.serverEpoch, store.now(), "stopped");
      } catch (error) {
        try {
          store.markWorkerStatus(handle.serverEpoch, "unknown", {
            note: `close 未确认: ${error instanceof ZBridgeError ? error.code : "unknown"}`,
          });
        } catch {
          // 状态标记失败不阻塞退出。
        }
      }
      runtime.handle = null;
    }
    for (const [key, cached] of this.sdkRuntimes) {
      const wasAlive = cached.handle.adapter.isWorkerAlive;
      try {
        await cached.handle.adapter.close();
        // worker 早已异常退出时，exit 回调已把它落成 crashed/unknown；关停不应改写成 stopped。
        if (wasAlive) {
          store.markWorkerStatus(cached.handle.serverEpoch, "stopped", { note: "daemon shutdown (sdk)" });
        }
        store.stopServer(cached.handle.serverEpoch, store.now(), "stopped");
      } catch (error) {
        try {
          store.markWorkerStatus(cached.handle.serverEpoch, "unknown", {
            note: `sdk close 未确认: ${error instanceof ZBridgeError ? error.code : "unknown"}`,
          });
        } catch {
          // 状态标记失败不阻塞退出。
        }
      }
      this.sdkRuntimes.delete(key);
    }
  }

  // ---------------------------------------------------------------- IPC

  private requireStore(): BridgeStore {
    if (this.store === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return this.store;
  }

  private requireScheduler(): Scheduler {
    if (this.scheduler === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return this.scheduler;
  }

  private requireApprovals(): DaemonApprovalQueue {
    if (this.approvals === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return this.approvals;
  }

  private workspaceSummaries(): readonly WorkspaceSummary[] {
    return this.requireStore().workspaces.list().filter((workspace) => this.runtimes.has(workspace.workspaceId)).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      profiles: workspace.profiles,
      generation: workspace.generation,
    }));
  }

  private runByClientRequestId(clientRequestId: string): RunId | null {
    const receipt = this.requireStore().findReceiptByClientRequest(this.principalIdValue ?? "", "agent_start", clientRequestId);
    return receipt?.runId ?? null;
  }

  private async handleClient(kind: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const store = this.requireStore();
    const scheduler = this.requireScheduler();
    const principal = this.principal();
    switch (kind) {
      case "ping":
        return this.statusPayload();
      case "workspace.list":
        return { workspaces: this.workspaceSummaries() };
      case "session.create": {
        const workspaceSlug = payload["workspaceSlug"] as string;
        const workspace = store.workspaces.list().find((candidate) => candidate.name === workspaceSlug);
        if (workspace === undefined) throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", "workspace 未登记");
        assertWorkspaceAllowed(principal, workspace.workspaceId);
        const backendId = typeof payload["backend"] === "string" ? (payload["backend"] as BackendId) : "opencode";
        this.assertBackendSelectable(backendId);
        const session = store.createSession({
          ownerId: principal.principalId,
          workspaceId: workspace.workspaceId,
          profile: "review",
          backendId,
          ...(typeof payload["sessionId"] === "string" ? { sessionId: payload["sessionId"] as SessionId } : {}),
        });
        return {
          contractVersion: CONTRACT_VERSION,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          backendId: session.backendId,
          profile: session.profile,
        };
      }
      case "run.start": {
        const sessionId = typeof payload["sessionId"] === "string" ? (payload["sessionId"] as SessionId) : undefined;
        const workspaceSlug = typeof payload["workspaceSlug"] === "string" ? (payload["workspaceSlug"] as string) : undefined;
        // MCP agent_start 复用 session 的前提：workspace 必须与 session 一致，
        // 且该 workspace 仍在主体当前允许列表里（配置移除后旧实体一律不可见）。
        if (sessionId !== undefined) {
          const session = store.sessions.get(sessionId);
          if (session === null || session.ownerId !== principal.principalId) {
            throw new ZBridgeError("NOT_FOUND", "session 不存在");
          }
          assertWorkspaceAllowed(principal, session.workspaceId);
          if (workspaceSlug !== undefined) {
            const workspace = store.workspaces.list().find((candidate) => candidate.name === workspaceSlug);
            if (workspace === undefined || workspace.workspaceId !== session.workspaceId) {
              throw new ZBridgeError("INVALID_ARGUMENT", "sessionId 与 workspaceSlug 不匹配，拒绝受理");
            }
          }
        } else if (workspaceSlug !== undefined) {
          const workspace = store.workspaces.list().find((candidate) => candidate.name === workspaceSlug);
          if (workspace === undefined) {
            throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", `workspace ${workspaceSlug} 未登记`);
          }
          assertWorkspaceAllowed(principal, workspace.workspaceId);
        }
        // OC-08 模型解析：
        // - 已有同 key 回执 → 重试。不重新解析（防「此刻默认值/会话当前选择」漂移），
        //   只透传显式值，由 scheduler 对照原 run 的持久化选择判冲突；
        // - 新请求 → 显式（格式 + 允许列表）> 会话上次已受理选择 > default。
        const explicitModel = typeof payload["model"] === "string" ? (payload["model"] as string) : undefined;
        const hasReceipt =
          store.findReceiptByClientRequest(principal.principalId, "agent_start", payload["clientRequestId"] as string) !== null;
        // OC-09 backend：重试不重新解析（显式值交 scheduler 对原归属判冲突）；
        // 新请求显式值原样透传，省略时 scheduler 按会话归属/加载的默认后端解析。
        const explicitBackend = typeof payload["backend"] === "string" ? (payload["backend"] as BackendId) : undefined;
        const backend = explicitBackend;
        // 已有会话显式换后端必须在模型解析前拒绝：否则会先按另一后端的
        // 允许列表报模型错误，掩盖规格要求的 backend_session_mismatch。
        if (!hasReceipt && sessionId !== undefined && explicitBackend !== undefined) {
          const session = store.sessions.get(sessionId);
          if (session !== null && session.backendId !== explicitBackend) {
            throw new ZBridgeError("INVALID_ARGUMENT", "session 固定归属另一后端；跨 CLI 不复用会话", {
              details: { reason: "backend_session_mismatch", sessionBackend: session.backendId, requested: explicitBackend },
            });
          }
        }
        const model = hasReceipt ? explicitModel : this.resolveModelForNewRequest(explicitModel, sessionId, backend);
        const outcome = scheduler.submit({
          prompt: payload["prompt"] as string,
          clientRequestId: payload["clientRequestId"] as string,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
          ...(typeof payload["serviceEpoch"] === "number" ? { serviceEpoch: payload["serviceEpoch"] as number } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(backend !== undefined ? { backend } : {}),
        });
        const waitMs = typeof payload["waitMs"] === "number" ? (payload["waitMs"] as number) : 0;
        if (waitMs > 0) {
          const state = await scheduler.waitForCompletion(outcome.runId, waitMs);
          return { ...outcome, queued: !isTerminal(state), state };
        }
        return outcome;
      }
      case "run.get": {
        const runId =
          typeof payload["runId"] === "string"
            ? (payload["runId"] as RunId)
            : this.runByClientRequestId(payload["clientRequestId"] as string);
        if (runId === null) {
          return {
            contractVersion: CONTRACT_VERSION,
            runId: null,
            state: "not_found",
            revision: 0,
            lastEventSeq: 0,
            earliestSeq: 0,
            nextAction: "none",
            resultReady: false,
            warnings: [],
            backendId: null,
            selectedModel: null,
            observedModel: null,
          };
        }
        this.requireRunAccessible(store, principal, runId);
        const snapshot = store.getRunSnapshot(runId, principal);
        return { ...snapshot, deadlineAt: store.getRun(runId).deadlineAt };
      }
      case "run.events": {
        const runId = payload["runId"] as RunId;
        const run = this.requireRunAccessible(store, principal, runId);
        return {
          ...store.readEvents(runId, {
            ...(typeof payload["afterSeq"] === "number" ? { afterSeq: payload["afterSeq"] as number } : {}),
            ...(typeof payload["limit"] === "number" ? { limit: payload["limit"] as number } : {}),
          }),
          backendId: run.backendId,
        };
      }
      case "run.result": {
        const runId = payload["runId"] as RunId;
        this.requireRunAccessible(store, principal, runId);
        const manifest = store.getResultManifest(runId, principal);
        const runRow = store.runs.require(runId);
        // 工件元数据随结果返回（MCP 侧没有 artifact_list 工具）；
        // 只含 artifactId/label/sha256/bytes/provenance，不含 internalPath。
        // label 缺失 = 该类工件被配额跳过；truncated=true = 被截断——
        // 配额限制从返回值即可发现，不依赖 daemon stderr。
        return {
          ...projectManifest(manifest),
          // OC-09：结果可追溯到执行它的后端；OC-08：选定值与实际观测值分开。
          backendId: runRow.backendId,
          selectedModel: runRow.selectedModel,
          observedModel: runRow.observedModel,
          artifacts: store.artifacts.listByRun(runId).map((artifact) => ({
            artifactId: artifact.artifactId,
            runId: artifact.runId,
            mediaType: artifact.mediaType,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
            provenance: artifact.provenance,
            createdAt: artifact.createdAt,
            ...(artifact.label === undefined ? {} : { label: artifact.label }),
            ...(artifact.truncated === undefined ? {} : { truncated: artifact.truncated }),
          })),
          artifactPlan: ["result", "events", "workspace-diff"],
        };
      }
      case "run.stop": {
        // 旧 CLI 路径与新 MCP cancel 走同一套归属/当前工作区校验：
        // 不论 runId 还是 clientRequestId 定位，都先过 requireRunAccessible。
        let stopRunId = typeof payload["runId"] === "string" ? (payload["runId"] as RunId) : null;
        if (stopRunId === null && typeof payload["clientRequestId"] === "string") {
          const receipt = store.findReceiptByClientRequest(
            principal.principalId,
            "agent_start",
            payload["clientRequestId"] as string,
          );
          stopRunId = receipt?.runId ?? null;
        }
        if (stopRunId !== null) {
          this.requireRunAccessible(store, principal, stopRunId);
        }
        return scheduler.stop({
          ...(typeof payload["runId"] === "string" ? { runId: payload["runId"] as RunId } : {}),
          ...(typeof payload["clientRequestId"] === "string" ? { clientRequestId: payload["clientRequestId"] as string } : {}),
          intent: payload["intent"] === "interrupt" ? "interrupt" : "cancel",
        });
      }
      case "run.wait":
        return this.waitRuns(payload, signal);
      case "run.interrupt":
        return this.stopWithReceipt("agent_interrupt", payload, "interrupt");
      case "run.cancel":
        return this.stopWithReceipt("agent_cancel", payload, "cancel");
      case "session.list":
        return this.listSessions(payload);
      case "session.close":
        return this.closeWithReceipt(payload);
      case "artifact.read":
        return this.artifactRead(payload);
      default:
        throw new ZBridgeError("INVALID_ARGUMENT", `未知请求类型 ${kind}`);
    }
  }

  // ---------------------------------------------------------------- OC-05 处理器

  private requirePrincipalId(): PrincipalId {
    if (this.principalIdValue === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    return this.principalIdValue;
  }

  /**
   * 统一的 run 可见性检查：owner **加** workspace 当前访问权。
   * 同 owner 的旧 workspace 从配置移除后，get/wait/events/result/stop 都不得返回
   * 或修改旧实体（对外一律 NOT_FOUND，不区分「不存在」与「无权」）。
   */
  private requireRunAccessible(store: BridgeStore, principal: Principal, runId: RunId): Run {
    const run = store.getRun(runId, principal);
    const session = store.sessions.require(run.sessionId);
    assertWorkspaceAllowed(principal, session.workspaceId);
    return run;
  }

  /**
   * OC-08：新请求的模型解析（显式 → 会话继承 → default），只在**没有既有回执**时调用。
   * - 显式：格式错误 INVALID_ARGUMENT；不在允许列表 PROFILE_NOT_ALLOWED；
   * - 继承：会话最近一次已受理选择。优先 `sessions.last_selected_model`；
   *   v4 迁移前的旧会话该列为 NULL，但只要历史上有过受理（存在 run 行），
   *   就按迁移语义继承「固定 MiniMax」（selected_model NULL → LEGACY）——
   *   不能因为 default 配置变了就给旧会话换模型/换供应商；
   *   继承值已不在允许列表则报错，不自动替换；
   * - 默认：只有从未受理过任务的新会话才使用当前 `backend.modelProfiles.default`。
   * 解析结果随受理一起持久化；已有运行中任务不因后续配置修改改变执行身份。
   */
  private resolveModelForNewRequest(explicit: string | undefined, sessionId: SessionId | undefined, backend?: BackendId): string {
    // OC-09：省略 backend 的已有会话继承其持久化归属，不被当前 defaultBackend 改写。
    const session = sessionId === undefined ? null : this.requireStore().sessions.get(sessionId);
    const backendId = backend ?? session?.backendId ?? this.options.config.defaultBackend;
    if (backendId !== "opencode") {
      return this.resolveNativeModelForNewRequest(backendId, explicit, sessionId);
    }
    const modelGate = this.modelGate;
    if (modelGate === null) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "OpenCode 未在配置中登记", { details: { backendId } });
    }
    if (explicit !== undefined) {
      parseModelRef(explicit);
      if (!modelGate.allows(explicit)) {
        throw new ZBridgeError("PROFILE_NOT_ALLOWED", "model 不在本地配置允许列表内；允许值见 agent_capabilities.models.allowed", {
          details: { requested: explicit, allowed: [...modelGate.allowed] },
        });
      }
      return explicit;
    }
    if (sessionId !== undefined) {
      const store = this.requireStore();
      if (session === null) return modelGate.defaultRef;
      const inherited =
        session.lastSelectedModel ?? (() => {
          // 旧会话（v4 前受理过任务）：从 run 历史推导最近一次已受理选择。
          const lastRun = store.runs.lastBySession(sessionId);
          return lastRun === null ? null : (lastRun.selectedModel ?? LEGACY_MODEL_REF);
        })();
      if (inherited !== null) {
        if (!modelGate.allows(inherited)) {
          throw new ZBridgeError("PROFILE_NOT_ALLOWED", "会话上次选择的模型已不在允许列表；请显式选择仍允许的模型", {
            details: { lastSelectedModel: inherited, allowed: [...modelGate.allowed] },
          });
        }
        return inherited;
      }
    }
    return modelGate.defaultRef;
  }

  /**
   * agent_wait 的受控等待。每次读都是持久快照；超时只结束等待，不改 run 状态，
   * 也不取消任何任务。轮询有界（≤25s、150ms 间隔）；客户端断连（socket 关闭）
   * 会触发请求级 AbortSignal，等待循环立即收尾并清理计时器，不留无界循环。
   */
  private async waitRuns(payload: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
    const store = this.requireStore();
    const principal = this.principal();
    const returnWhen = (payload["returnWhen"] as "any_change" | "any_terminal" | "all_terminal" | undefined) ?? "any_change";
    const configuredWait = this.options.config.limits.waitTimeoutMs;
    const timeoutMs = Math.min(
      typeof payload["timeoutMs"] === "number" ? (payload["timeoutMs"] as number) : configuredWait,
      25_000,
    );
    const entries = (payload["runs"] as readonly { runId: RunId; afterRevision?: number }[]).map((entry) => {
      // owner + workspace 当前访问权校验：外来主体或已移除工作区的 run 统一 NOT_FOUND。
      const run = this.requireRunAccessible(store, principal, entry.runId);
      return { runId: run.runId, baseline: entry.afterRevision ?? run.revision };
    });
    const snapshot = (): RunWaitView[] =>
      entries.map((entry) => {
        const run = store.runs.require(entry.runId);
        return {
          runId: run.runId,
          state: run.state,
          revision: run.revision,
          terminal: isTerminalRunState(run.state),
          changed: run.revision > entry.baseline,
        };
      });
    const conditionMet = (views: readonly RunWaitView[]): boolean => {
      switch (returnWhen) {
        case "any_change":
          return views.some((view) => view.changed);
        case "any_terminal":
          return views.some((view) => view.terminal);
        case "all_terminal":
          return views.every((view) => view.terminal);
      }
    };
    let views = snapshot();
    const deadline = Date.now() + timeoutMs;
    while (!conditionMet(views) && Date.now() < deadline && !(signal?.aborted ?? false)) {
      await sleepWithAbort(150, signal);
      views = snapshot();
    }
    return {
      contractVersion: CONTRACT_VERSION,
      returnWhen,
      timeoutMs,
      waitTimedOut: !conditionMet(views),
      runs: views,
    };
  }

  /**
   * interrupt/cancel 的持久幂等执行。
   *
   * 并发串行：同 key 同时到达的请求共享同一个在途 Promise（参数哈希不同立即
   * IDEMPOTENCY_CONFLICT），完成后的重试凭落库回执重放原响应——daemon 重启
   * （serviceEpoch 已变）后同样成立。不能只靠完成后的唯一约束挡并发插入。
   */
  private readonly inflightStopCalls = new Map<string, { readonly requestHash: string; readonly pending: Promise<unknown> }>();

  private async stopWithReceipt(
    toolName: "agent_interrupt" | "agent_cancel",
    payload: Record<string, unknown>,
    intent: "interrupt" | "cancel",
  ): Promise<unknown> {
    const principalId = this.requirePrincipalId();
    const runId = payload["runId"] as RunId;
    const clientRequestId = payload["clientRequestId"] as string;
    const expectedRevision = payload["expectedRevision"] as number;
    const serviceEpoch = payload["serviceEpoch"] as number;
    const requestHash = payloadHash({ toolName, runId, expectedRevision, serviceEpoch });
    const key = `${principalId}|${toolName}|${clientRequestId}`;
    const inflight = this.inflightStopCalls.get(key);
    if (inflight !== undefined) {
      if (inflight.requestHash !== requestHash) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的停止请求参数不同，拒绝重试", {
          details: { toolName, clientRequestId },
        });
      }
      return inflight.pending;
    }
    const pending = this.executeStopWithReceipt(toolName, {
      principalId,
      runId,
      clientRequestId,
      expectedRevision,
      serviceEpoch,
      requestHash,
      intent,
    });
    this.inflightStopCalls.set(key, { requestHash, pending });
    try {
      return await pending;
    } finally {
      this.inflightStopCalls.delete(key);
    }
  }

  private async executeStopWithReceipt(
    toolName: "agent_interrupt" | "agent_cancel",
    input: {
      readonly principalId: PrincipalId;
      readonly runId: RunId;
      readonly clientRequestId: string;
      readonly expectedRevision: number;
      readonly serviceEpoch: number;
      readonly requestHash: string;
      readonly intent: "interrupt" | "cancel";
    },
  ): Promise<unknown> {
    const store = this.requireStore();
    // 回执命中也必须先核对实体归属与当前工作区访问权：撤销后的 workspace
    // 不能靠缓存回执绕开检查继续拿到响应。
    const receipt = store.findToolReceipt(input.principalId, toolName, input.clientRequestId);
    if (receipt !== null) {
      this.requireRunAccessible(store, this.principal(), input.runId);
      if (receipt.requestHash !== input.requestHash) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的停止请求参数不同，拒绝重试", {
          details: { toolName, clientRequestId: input.clientRequestId },
        });
      }
      return JSON.parse(receipt.responseJson) as unknown;
    }
    const currentEpoch = store.currentServiceEpoch();
    if (currentEpoch === null || input.serviceEpoch !== currentEpoch) {
      throw new ZBridgeError("EPOCH_MISMATCH", "停止请求携带的 serviceEpoch 不是当前活动代际", {
        details: { requested: input.serviceEpoch, current: currentEpoch },
      });
    }
    const run = this.requireRunAccessible(store, this.principal(), input.runId);
    if (run.revision !== input.expectedRevision) {
      throw new ZBridgeError("REVISION_CONFLICT", "expectedRevision 与当前 revision 不一致，请先 agent_get 刷新", {
        details: { expectedRevision: input.expectedRevision, revision: run.revision },
      });
    }
    const report = await this.requireScheduler().stop({ runId: input.runId, intent: input.intent });
    const after = store.runs.require(input.runId);
    const response = {
      contractVersion: CONTRACT_VERSION,
      runId: input.runId,
      intent: input.intent,
      state: after.state,
      revision: after.revision,
      confirmed: report.confirmed,
      method: report.method,
      found: report.found,
    };
    store.recordToolReceipt({
      principalId: input.principalId,
      toolName,
      clientRequestId: input.clientRequestId,
      serviceEpoch: input.serviceEpoch,
      requestHash: input.requestHash,
      targetId: input.runId,
      response,
    });
    return response;
  }

  /**
   * agent_close：只关闭产品 idle 会话；保留历史，不 DELETE 后端 session，不动 worker。
   * 关闭与回执在同一事务落库，重试不会出现「已关闭但回执缺失」的冲突状态。
   */
  private closeWithReceipt(payload: Record<string, unknown>): unknown {
    const store = this.requireStore();
    const principalId = this.requirePrincipalId();
    const sessionId = payload["sessionId"] as SessionId;
    const clientRequestId = payload["clientRequestId"] as string;
    const expectedRevision = payload["expectedRevision"] as number;
    const serviceEpoch = payload["serviceEpoch"] as number;
    const requestHash = payloadHash({ toolName: "agent_close", sessionId, expectedRevision, serviceEpoch });
    const receipt = store.findToolReceipt(principalId, "agent_close", clientRequestId);
    if (receipt !== null) {
      // 回执命中同样先核对归属与当前工作区访问权。
      const cached = store.sessions.get(sessionId);
      if (cached === null || cached.ownerId !== principalId) {
        throw new ZBridgeError("NOT_FOUND", "session 不存在");
      }
      assertWorkspaceAllowed(this.principal(), cached.workspaceId);
      if (receipt.requestHash !== requestHash) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的关闭请求参数不同，拒绝重试", {
          details: { toolName: "agent_close", clientRequestId },
        });
      }
      return JSON.parse(receipt.responseJson) as unknown;
    }
    const currentEpoch = store.currentServiceEpoch();
    if (currentEpoch === null || serviceEpoch !== currentEpoch) {
      throw new ZBridgeError("EPOCH_MISMATCH", "关闭请求携带的 serviceEpoch 不是当前活动代际", {
        details: { requested: serviceEpoch, current: currentEpoch },
      });
    }
    const session = store.sessions.get(sessionId);
    if (session === null || session.ownerId !== principalId) {
      throw new ZBridgeError("NOT_FOUND", "session 不存在");
    }
    assertWorkspaceAllowed(this.principal(), session.workspaceId);
    if (session.revision !== expectedRevision) {
      throw new ZBridgeError("REVISION_CONFLICT", "expectedRevision 与 session 当前 revision 不一致", {
        details: { expectedRevision, revision: session.revision },
      });
    }
    // 关闭与回执在同一事务：响应基于关闭后的最新状态构造，重试重放的
    // 响应与首次响应逐字段一致（含 revision）。
    const closed = store.closeIdleSession(sessionId, this.principal(), {
      receipt: {
        toolName: "agent_close",
        clientRequestId,
        serviceEpoch,
        requestHash,
        buildResponse: (session) => ({
          contractVersion: CONTRACT_VERSION,
          sessionId: session.sessionId,
          state: session.state,
          revision: session.revision,
        }),
      },
    });
    return closed.response;
  }

  private listSessions(payload: Record<string, unknown>): unknown {
    const store = this.requireStore();
    const principal = this.principal();
    const limit = typeof payload["limit"] === "number" ? (payload["limit"] as number) : 100;
    const cursor = typeof payload["cursor"] === "string" ? Number.parseInt(payload["cursor"], 10) : 0;
    const offset = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
    const workspaceFilter = typeof payload["workspaceId"] === "string" ? (payload["workspaceId"] as WorkspaceId) : undefined;
    const allowed = new Set<string>(principal.allowedWorkspaces);
    const all = store.sessions
      .listByOwner(principal.principalId)
      // 只返回主体**当前**允许工作区下的会话；配置移除后旧工作区会话不可见。
      .filter((session) => allowed.has(session.workspaceId))
      .filter((session) => workspaceFilter === undefined || session.workspaceId === workspaceFilter);
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      contractVersion: CONTRACT_VERSION,
      sessions: page.map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        backendId: session.backendId,
        profile: session.profile,
        state: session.state,
        recoveryVerification: session.recoveryVerification,
        blockedReason: session.blockedReason,
        revision: session.revision,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // OC-08：下一轮省略 model 时沿用的选择；未选择过为 null。
        lastSelectedModel: session.lastSelectedModel,
      })),
      nextCursor: nextOffset < all.length ? String(nextOffset) : null,
    };
  }

  private artifactRead(payload: Record<string, unknown>): unknown {
    const store = this.requireStore();
    const principal = this.principal();
    // 先做归属与 workspace 访问校验，再进入文件读取（hash/类型/symlink 检查在 manager 内）。
    const artifact = store.getArtifact(payload["artifactId"] as ArtifactId, principal);
    const artifactRun = this.requireRunAccessible(store, principal, artifact.runId);
    const result = this.requireArtifacts().read({
      artifactId: artifact.artifactId,
      principal,
      ...(typeof payload["offset"] === "number" ? { offset: payload["offset"] as number } : {}),
      ...(typeof payload["limitChars"] === "number" ? { limitChars: payload["limitChars"] as number } : {}),
    });
    return {
      contractVersion: CONTRACT_VERSION,
      artifactId: result.artifact.artifactId,
      runId: result.artifact.runId,
      backendId: artifactRun.backendId,
      mediaType: result.artifact.mediaType,
      sha256: result.artifact.sha256,
      bytes: result.artifact.bytes,
      provenance: result.artifact.provenance,
      createdAt: result.artifact.createdAt,
      page: result.page,
    };
  }

  private async handleOperator(kind: string, payload: Record<string, unknown>): Promise<unknown> {
    const store = this.requireStore();
    const principal = this.principal();
    switch (kind) {
      case "ping":
        return this.statusPayload();
      case "daemon.status":
        return this.statusPayload();
      case "management.status":
        return this.managementStatusPayload();
      case "workspace.list":
        return { workspaces: this.workspaceSummaries() };
      case "run.get": {
        const runId =
          typeof payload["runId"] === "string"
            ? (payload["runId"] as RunId)
            : this.runByClientRequestId(payload["clientRequestId"] as string);
        if (runId === null) {
          return { contractVersion: CONTRACT_VERSION, runId: null, state: "not_found", revision: 0, lastEventSeq: 0, earliestSeq: 0, nextAction: "none", resultReady: false, warnings: [] };
        }
        const snapshot = store.getRunSnapshot(runId, principal);
        return { ...snapshot, deadlineAt: store.getRun(runId).deadlineAt };
      }
      case "approval.list":
        return { approvals: this.requireApprovals().list() };
      case "approval.decide":
        return projectApproval(
          this.requireApprovals().decide({
            approvalId: payload["approvalId"] as string,
            decision: payload["decision"] === "allow_once" ? "allow_once" : "deny",
            payloadHash: payload["payloadHash"] as string,
            serverEpoch: payload["serverEpoch"] as number,
            attemptId: payload["attemptId"] as string,
          }),
        );
      case "session.release": {
        const sessionId = payload["sessionId"] as SessionId;
        const session = store.sessions.require(sessionId);
        if (session.ownerId !== principal.principalId) throw new ZBridgeError("NOT_FOUND", "session 不存在");
        const updated = store.releaseSessionBlock(sessionId);
        return {
          sessionId: updated.sessionId,
          state: updated.state,
          blockedReason: updated.blockedReason,
          note: typeof payload["note"] === "string" ? (payload["note"] as string) : null,
          warning: "release 只解除本地阻塞标记；recoveryVerification 不因此升级为 verified",
        };
      }
      case "daemon.shutdown": {
        // 先应答再关停：客户端能拿到确认，daemon 随后自行退出。
        setTimeout(() => {
          void this.shutdown("operator_request").catch(() => undefined);
        }, 0);
        return { shuttingDown: true };
      }
      default:
        throw new ZBridgeError("INVALID_ARGUMENT", `未知请求类型 ${kind}`);
    }
  }

  /** OC-09：已配置后端的稳定顺序摘要（查询不启动 worker、不调用模型）。 */
  private backendStatusSummaries(): readonly BackendStatusSummary[] {
    const summaries: BackendStatusSummary[] = [];
    for (const id of ["opencode", "codebuddy", "qoder"] as const) {
      const entry = this.options.config.backends[id];
      if (entry === undefined) continue;
      const handles: RuntimeHandle[] =
        id === "opencode"
          ? [...this.runtimes.values()]
              .map((runtime) => runtime.handle)
              .filter((handle): handle is RuntimeHandle => handle !== null && handle.backendId === id)
          : [...this.sdkRuntimes.values()].map((cached) => cached.handle).filter((handle) => handle.backendId === id);
      const runtimeState: BackendStatusSummary["runtimeState"] =
        handles.length === 0 ? "not_started" : handles.some((handle) => handle.adapter.isWorkerAlive) ? "running" : "stopped";
      const observedVersion =
        handles.map((handle) => handle.adapter.observedCliVersion ?? null).find((value): value is string => value !== null) ?? null;
      if (entry.adapter === OPENCODE_ADAPTER_ID) {
        summaries.push({
          id,
          adapter: entry.adapter,
          enabled: entry.enabled,
          loaded: true,
          runtimeState,
          defaultModel: this.modelGate?.defaultRef ?? null,
          allowedModels: this.modelGate?.allowed ?? [],
          configuredVersion: entry.pinnedVersion,
          observedVersion,
        });
      } else {
        summaries.push({
          id,
          adapter: entry.adapter,
          enabled: entry.enabled,
          loaded: true,
          runtimeState,
          defaultModel: entry.models.default,
          allowedModels: entry.models.allowed,
          configuredVersion: entry.pinnedVersion,
          observedVersion,
        });
      }
    }
    return summaries;
  }

  /**
   * 本机管理状态：operator 专用。比 client 可见摘要多出配置指纹与覆盖来源，
   * 但绝不返回供应商内容、token 或任何私有文件正文。
   */
  private managementStatusPayload(): ManagementStatus {
    const base = this.statusPayload();
    const details: BackendManagementStatus[] = [];
    for (const summary of this.backendStatusSummaries()) {
      const entry = this.options.config.backends[summary.id];
      if (entry === undefined) continue;
      if (entry.adapter === OPENCODE_ADAPTER_ID) {
        const executable = this.options.executable ?? entry.executable;
        details.push({
          ...summary,
          entryFingerprint: this.entryFingerprints.get(summary.id) ?? "",
          privateConfigDigest: null,
          executable,
          executableSource: this.options.executable !== undefined ? "cli_override" : entry.executable !== null ? "config" : "default",
          providerConfigFile: this.options.providerConfig !== undefined ? this.options.sourceProviderConfigPath ?? null : entry.providerConfigFile,
          providerConfigSource:
            this.options.providerConfig !== undefined ? "cli_override" : entry.providerConfigFile !== null ? "config" : null,
          providerConfigDigest: this.loadedProviderDigest,
          authMode: null,
          authFile: null,
        });
      } else {
        details.push({
          ...summary,
          entryFingerprint: this.entryFingerprints.get(summary.id) ?? "",
          privateConfigDigest: this.privateConfigDigests.get(summary.id) ?? null,
          executable: entry.executable,
          executableSource: "config",
          providerConfigFile: null,
          providerConfigSource: null,
          providerConfigDigest: null,
          authMode: entry.auth.mode,
          authFile: entry.auth.mode === "credential-file" ? entry.auth.file : null,
        });
      }
    }
    return {
      ...base,
      loadedConfigPath: this.options.sourceConfigPath ?? null,
      backendDetails: details,
      overrides: {
        executable: this.options.executable ?? null,
        providerConfigFile: this.options.sourceProviderConfigPath ?? (this.options.providerConfig !== undefined ? "explicit-object" : null),
      },
    };
  }

  private statusPayload(): DaemonStatus {
    const store = this.requireStore();
    const scheduler = this.requireScheduler();
    const principalId = this.principalIdValue;
    if (principalId === null) throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 尚未完成启动");
    const serverEpoch =
      [...this.runtimes.values()].map((runtime) => runtime.handle?.serverEpoch ?? null).find((epoch) => epoch !== null) ??
      [...this.sdkRuntimes.values()].map((cached) => cached.handle.serverEpoch).find((epoch) => epoch !== 0) ??
      null;
    return {
      contractVersion: CONTRACT_VERSION,
      running: this.running,
      pid: process.pid,
      serviceEpoch: this.serviceEpoch,
      serverEpoch,
      activeRunId: scheduler.activeRunId,
      queue: scheduler.queuedView(),
      pendingApprovals: this.requireApprovals().pendingCount(),
      workspaces: store.workspaces.list().length,
      sessions: store.sessions.listByOwner(principalId).length,
      editEnabled: false,
      controlChannelIsolation: "unverified",
      lastRecovery: this.lastRecovery,
      limits: {
        activeRuns: this.options.config.limits.activeRuns,
        runTimeoutMs: this.options.config.limits.runTimeoutMs,
        waitTimeoutMs: this.options.config.limits.waitTimeoutMs,
        queueTtlMs: this.options.config.limits.queueTtlMs,
        approvalTimeoutMs: this.options.config.limits.approvalTimeoutMs,
        artifactMaxBytes: this.options.config.limits.artifactMaxBytes,
      },
      models: this.modelGate === null ? null : { default: this.modelGate.defaultRef, allowed: this.modelGate.allowed },
      defaultBackend: this.options.config.defaultBackend,
      backends: this.backendStatusSummaries(),
    };
  }

  // ---------------------------------------------------------------- 后代观测

  private startObserver(): void {
    if (this.observerTimer !== null) return;
    this.observerTimer = setInterval(() => {
      void this.observeOnce();
    }, Daemon.OBSERVE_INTERVAL_MS);
  }

  private stopObserver(): void {
    if (this.observerTimer === null) return;
    clearInterval(this.observerTimer);
    this.observerTimer = null;
  }

  /**
   * 低频有界观测：
   * 1) 把当前 worker 后代的 PID+身份周期落库（否则 daemon 强退后无法安全回收
   *    已孤儿化的工具进程）；
   * 2) worker 已死且没有活动 run 时，有界回收其记录的后代（adapter.close 的
   *    exited 路径逐个补刀并验证）；无法确认 → 标 unknown。
   */
  private async observeOnce(): Promise<void> {
    if (this.observerBusy || this.shuttingDown || !this.running) return;
    this.observerBusy = true;
    try {
      const store = this.requireStore();
      for (const runtime of this.runtimes.values()) {
        const handle = runtime.handle;
        if (handle === null) continue;
        const observed = handle.adapter.ownedProcessIds().map((pid) => ({ pid, identity: processIdentity(pid) }));
        if (observed.length > 0) {
          try {
            store.recordWorkerDescendants(handle.serverEpoch, observed);
          } catch {
            // 记录失败不阻塞观测循环。
          }
        }
        if (!handle.adapter.isWorkerAlive && handle.adapter.workerPid !== null && this.requireScheduler().activeRunId === null) {
          // 服务已死、无在途 run：现在回收它的后代最安全（run 在途时交给 run 自己的
          // 停止/期限路径，避免与 coordinator 竞争）。
          try {
            await handle.adapter.close();
            store.markWorkerStatus(handle.serverEpoch, "stopped", { note: "worker exited; descendants reclaimed by observer" });
            store.stopServer(handle.serverEpoch, store.now(), "stopped");
          } catch (error) {
            try {
              store.markWorkerStatus(handle.serverEpoch, "unknown", {
                note: `observer close 未确认: ${error instanceof ZBridgeError ? error.code : "unknown"}`,
              });
            } catch {
              // 状态标记失败不阻塞循环。
            }
          }
          runtime.handle = null;
        }
      }
    } finally {
      this.observerBusy = false;
    }
  }

  // ---------------------------------------------------------------- 关停

  private writeRunInfo(): void {
    const info = {
      pid: process.pid,
      serviceEpoch: this.serviceEpoch,
      startedAt: new Date().toISOString(),
      editEnabled: false,
      controlChannelIsolation: "unverified",
    };
    writeFileSync(this.paths.runInfoFile, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.options.onEvent?.(`daemon shutdown: ${reason}`);
    this.stopObserver();
    try {
      await this.requireScheduler().shutdown();
    } catch {
      // 关停路径不互相掩盖。
    }
    try {
      await this.clientServer.close();
      await this.operatorServer.close();
    } catch {
      // socket 清理失败不阻塞退出。
    }
    try {
      this.requireStore().close();
    } catch {
      // 已关闭。
    }
    this.lock.release();
    try {
      rmSync(this.paths.runInfoFile, { force: true });
    } catch {
      // 清理失败不阻塞退出。
    }
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function isTerminal(state: RunSnapshot["state"]): boolean {
  return ["completed", "failed", "cancelled", "interrupted", "timed_out", "unknown"].includes(state);
}

/** agent_wait 的单 run 视图；changed 以调用方给定的 afterRevision（或缺省受理时水位）为基准。 */
interface RunWaitView {
  readonly runId: RunId;
  readonly state: RunSnapshot["state"];
  readonly revision: number;
  readonly terminal: boolean;
  readonly changed: boolean;
}

/** 可被 abort 提前唤醒的睡眠：触发时清理计时器与监听器，不留悬挂句柄。 */
function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function projectManifest(manifest: ResultManifest): Record<string, unknown> {
  return {
    manifestId: manifest.manifestId,
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    agentReported: manifest.agentReported,
    observed: manifest.observed,
    verification: manifest.verification,
    verified: manifest.verified,
  };
}

function projectApproval(approval: {
  approvalId: string;
  state: string;
  decisionActor: string | null;
  decidedAt: string | null;
  summary: { expiresAt: string };
}): Record<string, unknown> {
  return {
    approvalId: approval.approvalId,
    state: approval.state,
    decisionActor: approval.decisionActor,
    decidedAt: approval.decidedAt,
    expiresAt: approval.summary.expiresAt,
  };
}

export type { ApprovalListItem, RunSnapshot, StopReport, QueuedView, RegistrationResult };
