/**
 * Qoder SDK 适配器（OC-09-04）。
 *
 * 与 CodebuddyAdapter 平行的 ManagedAdapter 实现，方言独立：
 * - 认证：credential-file（配置的私有 PAT 文件路径直接传 worker；token 不经
 *   daemon/adapter 进程）；cli-login 经 SDK daemon 账号面复用本机浏览器登录；
 * - 会话续接：resume 首轮后端会话 ID；
 * - stop 证据：interrupt_ack 的排队消息 UUID 进 detail。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ApprovalAnswer,
  BackendApprovalRequest,
  BackendCapabilities,
  BackendEventSink,
  BackendSessionRef,
  StopOutcome,
  StopSpec,
  TurnOutcome,
  TurnSpec,
  SessionSpec,
} from "../../contracts/backend.ts";
import { QODER_SDK_VERSION } from "../../contracts/version.ts";
import { isProcessAlive, ownedProcesses, processIdentity, readProcessTable } from "../../core/proc.ts";
import type { ManagedAdapter } from "../registry.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import { sdkApprovalExpiresAt } from "../sdk-approval.ts";
import { decodeQoderReport, type QoderWorkerCommand, type QoderWorkerReport } from "./protocol.ts";

const WORKER_ENTRY = fileURLToPath(new URL("./worker-main.ts", import.meta.url));
const WORKER_STARTUP_TIMEOUT_MS = 20_000;
/** outcome 之后留给 SDK/CLI 自然退出的窗口；超窗即视为仍有执行，必须回收。 */
const QUIESCE_WINDOW_MS = 500;
/** 单轮后代回收后的静止确认窗口。 */
const REAP_SETTLE_MS = 400;
const PROCESS_POLL_MS = 50;

export interface QoderAdapterOptions {
  /** 配置锁定版本的本机 qodercli 绝对路径。 */
  readonly executable: string;
  /** 桥接受控状态根目录（CLI --config-dir）。 */
  readonly stateRoot: string;
  /** 已 realpath 的工作副本根（worker cwd）。 */
  readonly workspaceRoot: string;
  readonly serverEpoch: number;
  /** credential-file 认证文件绝对路径；cli-login 为 null。 */
  readonly authFile: string | null;
  /** cli-login 经 SDK daemon 复用浏览器登录；会话配置仍独立。 */
  readonly authMode?: "cli-login" | "credential-file";
  readonly sdkModuleId?: string;
  /** 本地审批有效期；同时受 run deadline 约束。 */
  readonly approvalTimeoutMs?: number;
  /** deadline 之后的终态宽限（默认 worker 启动超时）；测试可缩短。 */
  readonly deadlineGraceMs?: number;
  readonly onWorkerSpawned?: (info: { pid: number; pgid: number; processIdentity: string | null }) => void;
  /** worker 退出后回调：daemon 据此把 worker 记录从 active 收敛（不依赖 daemon 关停）。 */
  readonly onWorkerExited?: (info: { pid: number; expected: boolean; remaining: number }) => void;
}

interface PendingRun {
  readonly spec: TurnSpec;
  readonly sink: BackendEventSink;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  observedModel: string | null;
}

export class QoderAdapter implements ManagedAdapter {
  readonly backendId = "qoder" as const;
  private worker: ChildProcess | null = null;
  private workerReady: Promise<void> | null = null;
  /** 本代 worker 的进程组（detached，pgid == pid）；worker 退出后保留给残留下代回收。 */
  private workerGroupId: number | null = null;
  private shutdownRequested = false;
  private ownedPids = new Set<number>();
  private nativeSessionId: string | null = null;
  private cliVersionObserved: string | null = null;
  private readonly pending = new Map<string, PendingRun>();
  /** 已发往 worker、尚未收到终态 report 的 run；停止确认不能只看 pending。 */
  private readonly activeRuns = new Set<string>();
  private lastInterruptUuids: readonly string[] = [];
  private closed = false;

  private readonly options: QoderAdapterOptions;

  constructor(options: QoderAdapterOptions) {
    this.options = options;
  }

  get isWorkerAlive(): boolean {
    return this.worker !== null && this.worker.exitCode === null && this.worker.signalCode === null && isProcessAlive(this.worker.pid ?? 0);
  }

  get workerPid(): number | null {
    return this.worker?.pid ?? null;
  }

  /** OC-09：worker 上报的原生会话 ID；首轮前为 null。 */
  get backendSessionId(): string | null {
    return this.nativeSessionId;
  }

  /** 本轮实际观测到的 CLI 版本；未观测时为 null，不用配置值冒充。 */
  get observedCliVersion(): string | null {
    return this.cliVersionObserved;
  }

  ownedProcessIds(): readonly number[] {
    const live: number[] = [];
    if (this.workerPid !== null && isProcessAlive(this.workerPid)) live.push(this.workerPid);
    for (const pid of this.ownedPids) {
      if (isProcessAlive(pid)) live.push(pid);
    }
    return live;
  }

  async probe(): Promise<BackendCapabilities> {
    return {
      adapterId: "qoder-sdk",
      policyProfile: "review",
      runDirRef: "qoder-sdk-worker",
      versions: {
        adapter: { support: "supported", verifiedAt: null, evidenceRef: null, version: QODER_SDK_VERSION },
        backendServer: { support: "unknown", verifiedAt: null, evidenceRef: null, version: this.cliVersionObserved },
        apiSchema: { support: "unknown", verifiedAt: null, evidenceRef: null, version: null, sourceRef: null },
      },
      methods: {
        health: { support: "supported", verifiedAt: null, evidenceRef: null },
        createSession: { support: "supported", verifiedAt: null, evidenceRef: null },
        loadSession: { support: "supported", verifiedAt: null, evidenceRef: null },
        execute: { support: "supported", verifiedAt: null, evidenceRef: null },
        stop: { support: "supported", verifiedAt: null, evidenceRef: null },
        close: { support: "supported", verifiedAt: null, evidenceRef: null },
        events: { support: "not_applicable", verifiedAt: null, evidenceRef: null },
        resolvePermission: { support: "supported", verifiedAt: null, evidenceRef: null },
      },
      reviewWriteBlocked: { support: "unknown", verifiedAt: null, evidenceRef: null },
      writeSandbox: { support: "unsupported", verifiedAt: null, evidenceRef: null },
      controlChannelIsolation: { support: "unknown", verifiedAt: null, evidenceRef: null },
      usageSource: "backend",
      hardBudget: { support: "supported", verifiedAt: null, evidenceRef: null },
      internalRetry: { support: "unknown", verifiedAt: null, evidenceRef: null },
      sessionResume: { support: "unknown", verifiedAt: null, evidenceRef: null },
      probedAt: new Date().toISOString(),
    };
  }

  async createSession(_spec: SessionSpec): Promise<BackendSessionRef> {
    await this.ensureWorker();
    return { backendSessionId: `qd-${randomUUID()}`, serverEpoch: this.options.serverEpoch, backendVersion: null };
  }

  async loadSession(ref: BackendSessionRef): Promise<BackendSessionRef> {
    await this.ensureWorker();
    this.nativeSessionId = ref.backendSessionId;
    return ref;
  }

  async execute(spec: TurnSpec, sink: BackendEventSink): Promise<TurnOutcome> {
    if (this.closed) throw new Error("adapter 已关闭");
    await this.ensureWorker();
    const resume = this.nativeSessionId;
    spec.onDispatch?.onMessageId?.(spec.attemptId ?? spec.runId);

    const outcomePromise = new Promise<TurnOutcome>((resolve, reject) => {
      const grace = this.options.deadlineGraceMs ?? WORKER_STARTUP_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(spec.runId);
        // 超时回收必须先完成再让调用方看到失败：调度器在这一步之后释放
        // 全局活动位置，异步回收会造成旧 run 与下一 run 重叠。
        void this.abortTimedOutRun(spec.runId).then(
          () => reject(new Error("worker 轮次超时未返回终态")),
          (error: unknown) => reject(error instanceof Error ? error : new Error("worker 超时回收失败")),
        );
      }, grace + Math.max(1, Date.parse(spec.deadlineAt) - Date.now()));
      this.pending.set(spec.runId, { spec, sink, resolve, reject, timer, observedModel: null });
    });

    this.activeRuns.add(spec.runId);
    this.send({
      kind: "run",
      runId: spec.runId,
      prompt: spec.prompt,
      model: spec.model.modelRef,
      deadlineAt: spec.deadlineAt,
      attemptId: spec.attemptId ?? spec.runId,
      resume,
      authFile: this.options.authFile,
    });

    try {
      return await outcomePromise;
    } finally {
      const pending = this.pending.get(spec.runId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(spec.runId);
      }
    }
  }

  async stop(spec: StopSpec): Promise<StopOutcome> {
    this.send({ kind: spec.intent === "cancel" ? "cancel" : "interrupt", runId: spec.runId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 先等终态 report：outcome 只说明迭代结束，不说明 SDK/CLI 已停止执行。
    const settled = await this.waitRunSettled(spec.runId, spec.graceMs);
    let confirmed = false;
    let method: "protocol" | "process_tree" | "none" = "none";
    let quiet = false;
    if (settled) {
      quiet = await this.waitRunProcessesGone(QUIESCE_WINDOW_MS);
      if (quiet) {
        confirmed = true;
        // worker 已被超时回收时，证据来自进程树而不是协议回执。
        method = this.isWorkerAlive ? "protocol" : "process_tree";
      } else {
        await this.reapRunProcesses();
        if (await this.waitRunProcessesGone(REAP_SETTLE_MS)) {
          confirmed = true;
          method = "process_tree";
        }
      }
    }
    if (!confirmed) {
      // 协议未收敛或本轮工具仍在执行：有界关停 worker 并回收整个归属进程树。
      this.send({ kind: "shutdown" });
      await this.waitWorkerStopped(2_000);
      this.reapOwnedProcesses();
      await this.waitRunProcessesGone(REAP_SETTLE_MS);
      this.reapOwnedProcesses();
      confirmed = !this.isWorkerAlive && this.liveRunProcesses()?.length === 0;
      method = "process_tree";
    }
    const uuids = this.lastInterruptUuids;
    this.lastInterruptUuids = [];
    return {
      confirmed,
      method,
      settledAt: confirmed ? new Date().toISOString() : null,
      detail: `qoder stop(${spec.intent}) settled=${settled} quiet=${quiet} owned=${this.liveRunProcesses()?.length ?? "unknown"} workerAlive=${this.isWorkerAlive}${uuids.length > 0 ? ` queued=${uuids.join(",")}` : ""}`,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker !== null && worker.exitCode === null) {
      this.send({ kind: "shutdown" });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      this.reapOwnedProcesses();
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    this.worker = null;
    this.workerReady = null;
    this.workerGroupId = null;
    this.shutdownRequested = false;
    this.ownedPids.clear();
    this.activeRuns.clear();
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady !== null) return this.workerReady;
    this.workerReady = this.startWorker();
    return this.workerReady;
  }

  private startWorker(): Promise<void> {
    const worker = spawn(
      process.execPath,
      [
        WORKER_ENTRY,
        "--executable",
        this.options.executable,
        "--state-dir",
        `${this.options.stateRoot}/config`,
        "--cwd",
        this.options.workspaceRoot,
        "--auth-mode",
        this.options.authMode ?? "credential-file",
        ...(this.options.authFile === null ? [] : ["--auth-file", this.options.authFile]),
        ...(this.options.sdkModuleId === undefined ? [] : ["--sdk-module", this.options.sdkModuleId]),
      ],
      // detached：worker 自成进程组（pgid == pid），恢复时的组级回收才指向它自己；
      // daemon 崩溃后 worker 仍凭 stdin EOF 自尽。
      { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, QODER_SKIP_DOWNLOAD: "1" } },
    );
    this.worker = worker;
    this.workerGroupId = worker.pid ?? null;
    this.shutdownRequested = false;
    this.ownedPids.clear();
    worker.stdin?.on("error", () => {
      /* EPIPE：worker 退出后写命令的正常竞态，由退出处理收敛 */
    });
    worker.on("exit", () => {
      // 旧代际的晚到 exit 不得清掉新代际状态。
      if (this.worker !== worker) return;
      this.worker = null;
      this.workerReady = null;
      this.activeRuns.clear();
      // 保留 ownedPids 与 workerGroupId：worker 异常退出时 CLI 可能仍是孤儿，
      // 先按最后归属回收，再让 stop/close 仍能把未死进程判为未确认。
      this.reapOwnedProcesses();
      this.options.onWorkerExited?.({
        pid: worker.pid ?? 0,
        expected: this.closed || this.shutdownRequested,
        remaining: this.ownedProcessIds().length,
      });
      for (const [runId, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.pending.delete(runId);
        pending.reject(new Error("worker 进程提前退出"));
      }
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker 启动超时")), WORKER_STARTUP_TIMEOUT_MS);
      const readline = createInterface({ input: worker.stdout!, crlfDelay: Infinity });
      readline.on("line", (line) => {
        const report = decodeQoderReport(line);
        if (report === null) return;
        if (report.kind === "ready") {
          if (this.options.onWorkerSpawned !== undefined && typeof worker.pid === "number") {
            // 与 daemon 恢复路径同一身份格式（ps lstart）；pgid=... 会与
            // verifyOwnership 的 current 永不相等，导致活 worker 被判 PID 复用。
            this.options.onWorkerSpawned({
              pid: worker.pid,
              pgid: worker.pid,
              processIdentity: processIdentity(worker.pid),
            });
          }
          clearTimeout(timer);
          resolve();
        }
        this.handleReport(report);
      });
    });
  }

  private handleReport(report: QoderWorkerReport): void {
    if (report.kind === "owned_pids") {
      this.ownedPids = new Set(report.pids);
      return;
    }
    if (report.kind === "session") {
      this.nativeSessionId = report.backendSessionId;
      if (report.cliVersion !== null) this.cliVersionObserved = report.cliVersion;
      return;
    }
    if (report.kind === "worker_error") return;
    const runId = (report as { runId?: string }).runId ?? "";
    // 终态以 worker 的 outcome report 为准：即使 pending 已被超时清掉，
    // 也必须把 run 从 activeRuns 移除，停止等待才能结束。
    if (report.kind === "outcome" && runId.length > 0) this.activeRuns.delete(runId);
    const pending = this.pending.get(runId);
    if (pending === undefined) return;

    switch (report.kind) {
      case "dispatch":
        if (report.accepted && report.messageId !== null) {
          pending.spec.onDispatch?.onAccepted?.(report.messageId);
        }
        return;
      case "interrupt_ack":
        this.lastInterruptUuids = report.queuedMessageUuids;
        return;
      case "observed_model":
        pending.observedModel = report.model;
        return;
      case "event": {
        if (report.type === "message") {
          pending.sink.emit({ type: "message", text: report.text, final: report.final === true });
        } else if (report.type === "tool" && report.tool !== undefined) {
          pending.sink.emit({ type: "tool", tool: report.tool });
        } else if (report.type === "stderr") {
          pending.sink.emit({ type: "stderr", tail: report.text.slice(-500) });
        }
        return;
      }
      case "approval_requested": {
        this.forwardApproval(pending, report).catch(() => {
          this.send({ kind: "approval_decision", approvalId: report.approvalId, decision: "channel_lost" });
        });
        return;
      }
      case "input_requested": {
        pending.sink.emit({ type: "input_requested", schema: report.schema });
        void pending.sink.requestInput(report.schema).catch(() => undefined);
        return;
      }
      case "outcome": {
        const stopReason =
          report.stopReason === "turn_complete" || report.stopReason === "output_limit" || report.stopReason === "backend_error" || report.stopReason === "aborted" || report.stopReason === "refusal" || report.stopReason === "tool_calls_pending"
            ? report.stopReason
            : report.stopReason === null
              ? null
              : (`unknown:${report.stopReason}` as const);
        const outcome: TurnOutcome = {
          kind: report.failureCode !== undefined ? "failed" : report.subtype === "success" && !report.isError ? "completed" : report.subtype === "unknown" ? "unknown" : "failed",
          stopReason,
          serverEpoch: this.options.serverEpoch,
          terminalObservedAfterStop: false,
          agentReported: report.resultText,
          observedModel: pending.observedModel,
          usage: report.usage === null
            ? { source: "unavailable", inputTokens: null, outputTokens: null }
            : { source: "backend", inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens },
          error: report.failureCode !== undefined
            ? { code: report.failureCode, message: report.failureMessage ?? report.errors.join("; ").slice(0, 500) }
            : report.isError && report.errors.length > 0
              ? { code: report.subtype === "unknown" ? "no_structured_result" : report.subtype, message: report.errors.join("; ").slice(0, 500) }
              : null,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        };
        pending.resolve(outcome);
        return;
      }
      default:
        return;
    }
  }

  private async forwardApproval(pending: PendingRun, report: Extract<QoderWorkerReport, { kind: "approval_requested" }>): Promise<void> {
    const request: BackendApprovalRequest = {
      requestKind: "tool_permission",
      toolName: report.toolName,
      toolCallId: report.toolCallId,
      attemptId: report.attemptId,
      serverEpoch: this.options.serverEpoch,
      backendRequestId: report.approvalId,
      argumentsText: report.argumentsText,
      targetPaths: report.targetPaths,
      expiresAt: sdkApprovalExpiresAt(
        pending.spec.deadlineAt,
        this.options.approvalTimeoutMs ?? 300_000,
      ),
    };
    const answer: ApprovalAnswer = await pending.sink.requestApproval(request);
    this.send({ kind: "approval_decision", approvalId: report.approvalId, decision: answer.decision });
  }

  private send(command: QoderWorkerCommand): void {
    if (command.kind === "shutdown") this.shutdownRequested = true;
    const worker = this.worker;
    const stdin = worker?.stdin ?? null;
    if (stdin === null || worker?.exitCode !== null || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      /* EPIPE：worker 已退出，命令无处可去 */
    }
  }

  private async waitRunSettled(runId: string, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(200, graceMs);
    while (Date.now() < deadline) {
      if (!this.activeRuns.has(runId)) return true;
      await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
    return !this.activeRuns.has(runId);
  }

  /** 超时后逐级停止：cancel → shutdown → 进程树回收；每级都有界。 */
  private async abortTimedOutRun(runId: string): Promise<void> {
    if (!this.activeRuns.has(runId)) return;
    this.send({ kind: "cancel", runId });
    if (await this.settleTimedOutExecution(runId, 1_000)) return;
    // worker 可能卡在 CLI 上：shutdown 让它中断并回收自己的子进程后退出。
    this.send({ kind: "shutdown" });
    if (await this.settleTimedOutExecution(runId, 1_500)) return;
    this.reapOwnedProcesses();
    await this.waitRunProcessesGone(REAP_SETTLE_MS);
    this.reapOwnedProcesses();
    // 回收后 worker 可能还没走完 exit 回调；下一轮派发必须看到旧 worker 已死。
    const workerStopped = await this.waitWorkerStopped(1_000);
    if (!workerStopped || !(await this.waitRunProcessesGone(0))) {
      throw new ZBridgeError("STOP_UNCONFIRMED", "超时执行尚未确认停止，暂停后续派发");
    }
  }

  /** 终态到达后仍要确认本轮工具静止：允许自然退出窗口，超窗即回收后代。 */
  private async settleTimedOutExecution(runId: string, budgetMs: number): Promise<boolean> {
    if (!(await this.waitRunSettled(runId, budgetMs))) return false;
    if (await this.waitRunProcessesGone(QUIESCE_WINDOW_MS)) return true;
    await this.reapRunProcesses();
    return this.waitRunProcessesGone(REAP_SETTLE_MS);
  }

  /**
   * 本轮执行拥有的子进程：优先用进程表按 worker 根的后代/同组枚举（比周期
   * 上报更及时）；不可读时返回 null，不能把未上报后代当作不存在。worker 自身不计入。
   */
  private liveRunProcesses(): number[] | null {
    const workerPid = this.workerPid;
    const group = this.workerGroupId;
    const pids = new Set<number>();
    if (group !== null && group > 1) {
      const read = readProcessTable();
      if (!read.ok) return null;
      if (read.ok) {
        // 组信号与后代枚举都覆盖；worker 已死时同组 CLI 仍在表里（pgid 不变）。
        for (const row of ownedProcesses(read.rows, workerPid ?? group, group)) pids.add(row.pid);
      }
    }
    for (const pid of this.ownedPids) {
      if (pid !== workerPid) pids.add(pid);
    }
    return [...pids].filter(isProcessAlive);
  }

  private async waitRunProcessesGone(budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (;;) {
      if (this.liveRunProcesses()?.length === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
  }

  /** 只回收 worker 的后代，保留已静止的常驻 worker 供下一轮复用。 */
  private async reapRunProcesses(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      const pids = this.liveRunProcesses();
      if (pids === null || pids.length === 0) return;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ESRCH 等忽略 */
        }
      }
      if (await this.waitRunProcessesGone(150)) return;
    }
  }

  private async waitWorkerStopped(budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    while (Date.now() < deadline) {
      if (!this.isWorkerAlive) return true;
      await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
    return !this.isWorkerAlive;
  }

  private reapOwnedProcesses(): void {
    for (const pid of this.ownedPids) {
      try {
        if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        /* ESRCH 等忽略 */
      }
    }
    // worker 以 detached 启动、自成进程组：组信号能在子进程尚未上报时
    // 也回收 SDK 启动的 CLI。worker 已死时组号仍保留，
    // 用于回收异常退出留下的孤儿；组已空时 kill(-pgid) 返回 ESRCH。
    const group = this.workerGroupId;
    if (group !== null && group > 1) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        /* 组不存在或已清空 */
      }
    }
    if (this.worker?.pid !== undefined && this.worker.exitCode === null) {
      try {
        this.worker.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
}
