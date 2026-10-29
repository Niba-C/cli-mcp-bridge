/**
 * daemon 调度（OC-04 §3，验收 A12；复核修正版）。
 *
 * - **受理即持久化**：submit 时就调用 `store.admitRun`——run、回执、绝对期限
 *   同事务落库，响应携带稳定 runId。客户端断连/daemon 崩溃后都能凭 runId 查询，
 *   重试凭回执拿回原 run（原期限、原代际），不会重新执行。
 * - 幂等重试**必须过存储层哈希校验**：按原 session／原 profile／原 deadline 重建
 *   受理参数再调用 admitRun；改参报 IDEMPOTENCY_CONFLICT，不比较内存。
 * - 全局活动任务上限 1；**同 session 忙碌直接拒绝**（SESSION_BUSY），不自动追加。
 * - 排队是跨 session 的资源排队（内存只存已持久化 run 的引用；数据库才是事实）。
 *   队列到期/取消都落库终态，绝不留下只有内存知道的 queued run。
 * - 待批计入总期限：deadlineAt 在受理时固定，adapter 在期限处有界停止。
 * - 派发过程中的每个外部 await 之后都重新核对：run 仍活跃、无取消意图、未过期；
 *   条件不再满足就阻止晚派发。执行前失败（未提交发送意图）落 cancelled；
 *   任何「可能已发出」的异常保持/落 unknown 并阻塞，绝不宣称 cancelled。
 */
import type { ManagedAdapter, RunCoordinator } from "../backend/registry.ts";
import type { IsoTimestamp, Principal } from "../contracts/common.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import type { BackendModelSelection } from "../contracts/backend.ts";
import { parseBackendModelRef } from "../contracts/backend.ts";
import { LEGACY_MODEL_REF } from "../contracts/run.ts";
import type { BackendId } from "../contracts/version.ts";
import type { PrincipalId, RunId, SessionId, WorkspaceId } from "../contracts/ids.ts";
import { isTerminalRunState, type RunState } from "../contracts/run.ts";
import type { BridgeStore, SessionRecord } from "../storage/index.ts";
import type { DaemonApprovalQueue } from "./approvals.ts";

export interface SchedulerLimits {
  readonly activeRuns: number;
  readonly queueTtlMs: number;
  readonly runTimeoutMs: number;
  readonly queueCapacity: number;
  readonly stopGraceMs: number;
}

/** 排队项：只是已持久化 run 的内存引用；崩溃后由恢复入口收敛数据库状态。 */
export interface QueueItem {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly clientRequestId: string;
  readonly prompt: string;
  readonly enqueuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/**
 * OC-09：运行时句柄中立化。adapter/coordinator 只暴露公共生命周期面；
 * backendId 记录归属（恢复、回收与状态输出使用）。OpenCode 的协议细节
 * 全部封闭在其适配器内。
 */
export interface RuntimeHandle {
  readonly backendId: BackendId;
  readonly adapter: ManagedAdapter;
  readonly coordinator: RunCoordinator;
  readonly serverEpoch: number;
  readonly workspaceId: WorkspaceId;
  readonly workspaceGeneration: number;
}

/** Daemon 提供的运行时供给：worker 的生命周期由 daemon 统一持有与回收。
 * OC-09：ensure 接收 backendId 与 sessionId——各适配器自行决定粒度
 * （OpenCode 按工作区复用；SDK worker 按产品会话独立）。 */
export interface RuntimeProvider {
  ensure(backendId: BackendId, workspaceId: WorkspaceId, workspaceGeneration: number, sessionId: SessionId): Promise<RuntimeHandle>;
  /** model：本次 run 受理时持久化的模型选择（创建后端会话时使用；已绑定时忽略）。 */
  prepareSession(handle: RuntimeHandle, sessionId: SessionId, model: BackendModelSelection): Promise<void>;
  /**
   * OC-05：派发前最后一刻（session 已绑定、即将发送前）回调；
   * daemon 用它捕获工作副本基线，保证 diff 工件排除本轮之前的改动。
   */
  beforeDispatch?(handle: RuntimeHandle, runId: RunId): Promise<void> | void;
  onRunSettled(handle: RuntimeHandle, runId: RunId): void;
  closeAll(): Promise<void>;
}

export interface StartOutcome {
  readonly clientRequestId: string;
  readonly runId: RunId;
  readonly queued: boolean;
  readonly reused: boolean;
  readonly state: RunState;
  readonly queuePosition: number;
  readonly deadlineAt: IsoTimestamp;
  /** OC-08：本次受理解析并持久化的完整模型标识（重放时为原 run 的选择）。 */
  readonly selectedModel: string;
  /** OC-09：本次受理固定归属的后端（重放时为原 run 的归属）。 */
  readonly backendId: BackendId;
}

export interface QueuedView {
  readonly runId: RunId;
  readonly clientRequestId: string;
  readonly sessionId: SessionId;
  readonly position: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface StopReport {
  readonly found: "queued" | "run" | "not_found";
  readonly confirmed: boolean | null;
  readonly method: string | null;
  readonly state: RunState;
}

export interface SchedulerOptions {
  readonly store: BridgeStore;
  readonly limits: SchedulerLimits;
  readonly approvals: DaemonApprovalQueue;
  readonly principalId: PrincipalId;
  readonly runtime: RuntimeProvider;
  /**
   * OC-09：daemon 提供的 backend 可选性裁决。
   * - defaultBackendId：当前加载配置的默认后端（新会话省略 backend 时）；
   * - assertBackendSelectable：已配置、启用、允许 review；违规 PROFILE_NOT_ALLOWED。
   */
  readonly backendSelection: {
    readonly defaultBackendId: () => BackendId;
    readonly assertBackendSelectable: (backendId: BackendId) => void;
  };
  readonly now?: () => IsoTimestamp;
  readonly onEvent?: (message: string) => void;
}

interface ActiveExecution {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly clientRequestId: string;
  readonly prompt: string;
  execution: Promise<void>;
  /** 后端 outcome 可以先到；全局活动位置还必须等待所有停止请求收尾。 */
  stopExecution: Promise<void> | null;
  handle: RuntimeHandle | null;
  /** stop()/shutdown() 置位；派发路径在每个 await 后检查，阻止晚派发。 */
  cancelRequested: boolean;
}

interface CompletionWaiter {
  readonly resolve: (state: RunState) => void;
  readonly timer: NodeJS.Timeout;
}

const TOOL_NAME = "agent_start";

export class Scheduler {
  private readonly store: BridgeStore;
  private readonly limits: SchedulerLimits;
  private readonly approvals: DaemonApprovalQueue;
  private readonly principalId: PrincipalId;
  private readonly runtime: RuntimeProvider;
  private readonly clock: () => IsoTimestamp;
  private readonly onEvent: (message: string) => void;
  private readonly options: SchedulerOptions;

  private readonly items: QueueItem[] = [];
  private readonly completionWaiters = new Map<RunId, Array<CompletionWaiter>>();
  private active: ActiveExecution | null = null;
  private dispatching = false;
  private draining = false;
  /** 实际执行未确认停止时，不能只阻塞原会话后继续全局派发。 */
  private stopUnconfirmedRunId: RunId | null = null;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.store = options.store;
    this.limits = options.limits;
    this.approvals = options.approvals;
    this.principalId = options.principalId;
    this.runtime = options.runtime;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent ?? (() => undefined);
    if (options.limits.activeRuns !== 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "OC-04 的全局活动任务上限固定为 1");
    }
  }

  private now(): IsoTimestamp {
    return this.clock();
  }

  // ---------------------------------------------------------------- 查询

  get activeRunId(): RunId | null {
    return this.active?.runId ?? null;
  }

  get queueDepth(): number {
    return this.items.length;
  }

  queuedView(): readonly QueuedView[] {
    return this.items.map((item, index) => ({
      runId: item.runId,
      clientRequestId: item.clientRequestId,
      sessionId: item.sessionId,
      position: index,
      enqueuedAt: item.enqueuedAt,
      expiresAt: item.expiresAt,
    }));
  }

  // ---------------------------------------------------------------- 提交

  /**
   * 受理一个 run。**同步完成受理**（run + 回执 + 期限落库），返回稳定 runId。
   *
   * 幂等：同 clientRequestId 的重试按「原 session + 原 profile + 原 deadline + 原模型」
   * 重建受理参数，交给 `store.admitRun` 做规范化哈希校验——同参数返回原 run，
   * 改参报 IDEMPOTENCY_CONFLICT，不比较内存。
   *
   * model 语义（OC-08）：新请求传 daemon 解析后的完整引用；重试命中原回执时传
   * 调用方显式给出的值（省略则沿用原 run 的持久化选择），显式换模型在此判冲突。
   */
  submit(input: {
    readonly sessionId?: SessionId;
    readonly workspaceSlug?: string;
    readonly prompt: string;
    readonly clientRequestId: string;
    /** MCP agent_start 必带；新请求传给 admitRun 做代际校验，重试重放回执。 */
    readonly serviceEpoch?: number;
    /** 见上：新请求为解析结果；重试为调用方显式值或省略。 */
    readonly model?: string;
    /** OC-09：MCP 显式 backend（省略=继承/默认）。重试时为显式值或省略。 */
    readonly backend?: BackendId;
  }): StartOutcome {
    if (this.draining) {
      throw new ZBridgeError("DAEMON_UNAVAILABLE", "daemon 正在关停，不再受理新任务");
    }
    const store = this.store;
    const principal = this.principal();

    // ---- 幂等：跨代际查回执，然后用存储层校验原参数 ----
    const receipt = store.findReceiptByClientRequest(principal.principalId, TOOL_NAME, input.clientRequestId);
    if (receipt !== undefined && receipt !== null) {
      const originalRun = store.runs.require(receipt.runId);
      const originalSession = store.sessions.require(originalRun.sessionId);
      if (input.sessionId !== undefined && input.sessionId !== originalRun.sessionId) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 已绑定其它 session，拒绝重试", {
          details: { originalSessionId: originalRun.sessionId },
        });
      }
      // 同 key 改 workspace 也必须冲突：原 session 的 workspace 才是原请求的一部分。
      if (input.workspaceSlug !== undefined) {
        const requested = store.workspaces.list().find((candidate) => candidate.name === input.workspaceSlug);
        if (requested === undefined || requested.workspaceId !== originalSession.workspaceId) {
          throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 已绑定其它 workspace，拒绝重试", {
            details: { originalWorkspaceId: originalSession.workspaceId },
          });
        }
      }
      // 模型以原 run 的持久化选择为准：历史 NULL 行来自固定 MiniMax 实现。
      // 重试不按「此刻默认值/会话当前选择」重新解析；显式改成别的模型必须冲突。
      const originalModel = originalRun.selectedModel ?? legacyModelRefFor(originalRun.backendId);
      if (input.model !== undefined && input.model !== originalModel) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 已绑定其它模型，拒绝重试", {
          details: { originalModel, requested: input.model },
        });
      }
      // OC-09：同 key 显式改 backend 必须 IDEMPOTENCY_CONFLICT；省略按原归属重放。
      if (input.backend !== undefined && input.backend !== originalRun.backendId) {
        throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 已绑定其它后端，拒绝重试", {
          details: { originalBackendId: originalRun.backendId, requested: input.backend },
        });
      }
      // 用原参数重放 admitRun：哈希含 sessionId/profile/prompt/deadlineAt/model。
      // prompt 改了 → 冲突；prompt 相同 → 返回原 run（绝不重新执行）。
      // profile 保持与首次调用一致（daemon IPC 不接受 profile，即 undefined→null）。
      const replayed = store.admitRun({
        principal,
        sessionId: originalRun.sessionId,
        toolName: TOOL_NAME,
        clientRequestId: input.clientRequestId,
        serviceEpoch: receipt.serviceEpoch,
        prompt: input.prompt,
        deadlineAt: originalRun.deadlineAt,
        model: originalModel,
        backend: originalRun.backendId,
      });
      return {
        clientRequestId: input.clientRequestId,
        runId: replayed.run.runId,
        queued: !isTerminalRunState(replayed.run.state) && this.findItem(replayed.run.runId) !== null,
        reused: true,
        state: replayed.run.state,
        queuePosition: this.positionOf(replayed.run.runId),
        deadlineAt: originalRun.deadlineAt,
        selectedModel: originalModel,
        backendId: originalRun.backendId,
      };
    }

    // ---- 新请求 ----
    if (this.stopUnconfirmedRunId !== null) {
      throw new ZBridgeError("STOP_UNCONFIRMED", "旧执行尚未确认停止，请本机核对并重启后台后再执行新任务", {
        details: { blockedRunId: this.stopUnconfirmedRunId },
      });
    }
    // OC-09 backend 解析（主规划 §4.1）：显式 > 会话归属 > daemon 加载的默认后端。
    // 已有会话显式指定另一后端：INVALID_ARGUMENT + details.reason=backend_session_mismatch，
    // 不建新会话、不派发、不静默迁移历史。
    let session: SessionRecord;
    if (input.sessionId !== undefined) {
      session = store.sessions.get(input.sessionId) ?? (() => {
        throw new ZBridgeError("NOT_FOUND", "session 不存在");
      })();
      if (session.ownerId !== principal.principalId) {
        throw new ZBridgeError("NOT_FOUND", "session 不存在");
      }
      if (session.state === "closed") throw new ZBridgeError("SESSION_CLOSED", "session 已关闭");
      if (session.blockedReason !== null) {
        throw new ZBridgeError("SESSION_BUSY", "session 有未核对的 unknown 结果，后续任务受阻", {
          details: { reason: session.blockedReason, blockedRunId: session.blockedRunId },
        });
      }
      if (input.backend !== undefined && input.backend !== session.backendId) {
        throw new ZBridgeError("INVALID_ARGUMENT", "session 固定归属另一后端；跨 CLI 不复用会话", {
          details: { reason: "backend_session_mismatch", sessionBackend: session.backendId, requested: input.backend },
        });
      }
    } else {
      const workspaceSlug = input.workspaceSlug ?? "";
      const workspace = store.workspaces.list().find((candidate) => candidate.name === workspaceSlug);
      if (workspace === undefined) {
        throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", `workspace ${workspaceSlug} 未登记`);
      }
      const backend = input.backend ?? this.defaultBackendId();
      this.assertBackendSelectable(backend);
      session = store.createSession({
        ownerId: principal.principalId,
        workspaceId: workspace.workspaceId,
        profile: "review",
        backendId: backend,
      });
    }

    // 同 session 忙碌拒绝（规格：忙碌不能追加 prompt；不自动排队）。
    if (session.state === "busy" || store.sessions.countActiveRuns(session.sessionId) > 0) {
      throw new ZBridgeError("SESSION_BUSY", "session 正在执行其它任务；忙碌会话不接受新 prompt", {
        details: { sessionId: session.sessionId },
      });
    }

    if (this.items.length >= this.limits.queueCapacity) {
      throw new ZBridgeError("RESOURCE_EXHAUSTED", `队列已满（${this.limits.queueCapacity}）`);
    }

    // 绝对期限在受理时固定并落库；排队/待批都计入这个总期限。
    const deadlineAt = new Date(Date.parse(this.now()) + this.limits.runTimeoutMs).toISOString();
    const serviceEpoch = store.currentServiceEpoch();
    if (serviceEpoch === null) {
      throw new ZBridgeError("DAEMON_UNAVAILABLE", "缺少活动服务代际");
    }
    if (input.model === undefined) {
      // daemon 受理路径负责解析（显式/继承/默认）并校验允许列表；直连 submit 必须自带。
      throw new ZBridgeError("INVALID_ARGUMENT", "新受理缺少已解析的 model（OC-08）");
    }
    const admitted = store.admitRun({
      principal,
      sessionId: session.sessionId,
      toolName: TOOL_NAME,
      clientRequestId: input.clientRequestId,
      serviceEpoch: input.serviceEpoch ?? serviceEpoch,
      prompt: input.prompt,
      deadlineAt,
      model: input.model,
      backend: session.backendId,
    });
    const runId = admitted.run.runId;
    this.onEvent(`run admitted: ${runId} (session ${session.sessionId}, model ${input.model}, deadline ${deadlineAt})`);

    if (admitted.reused) {
      // 极端竞态：查回执时没有、admit 时有了（并发同 key）。按幂等返回。
      return {
        clientRequestId: input.clientRequestId,
        runId,
        queued: this.findItem(runId) !== null || this.active?.runId === runId,
        reused: true,
        state: admitted.run.state,
        queuePosition: this.positionOf(runId),
        deadlineAt: admitted.run.deadlineAt,
        selectedModel: admitted.run.selectedModel ?? legacyModelRefFor(admitted.run.backendId),
        backendId: admitted.run.backendId,
      };
    }

    if (this.active === null && !this.dispatching) {
      this.startDispatch(runId, session.sessionId, input.clientRequestId, input.prompt);
      return {
        clientRequestId: input.clientRequestId,
        runId,
        queued: false,
        reused: false,
        state: store.runs.require(runId).state,
        queuePosition: -1,
        deadlineAt,
        selectedModel: input.model,
        backendId: session.backendId,
      };
    }

    const enqueuedAt = this.now();
    this.items.push({
      runId,
      sessionId: session.sessionId,
      clientRequestId: input.clientRequestId,
      prompt: input.prompt,
      enqueuedAt,
      expiresAt: new Date(Date.parse(enqueuedAt) + this.limits.queueTtlMs).toISOString(),
    });
    return {
      clientRequestId: input.clientRequestId,
      runId,
      queued: true,
      reused: false,
      state: store.runs.require(runId).state,
      queuePosition: this.items.length - 1,
      deadlineAt,
      selectedModel: input.model,
      backendId: session.backendId,
    };
  }

  private principal(): Principal {
    return {
      principalId: this.principalId,
      // 单用户 v1：daemon 服务端持有全部已登记 workspace 的访问权。
      allowedWorkspaces: this.store.workspaces.list().map((workspace) => workspace.workspaceId),
      role: "owner",
    };
  }

  private findItem(runId: RunId): QueueItem | null {
    return this.items.find((item) => item.runId === runId) ?? null;
  }

  private positionOf(runId: RunId): number {
    const index = this.items.findIndex((item) => item.runId === runId);
    return index;
  }

  // ---------------------------------------------------------------- 等待

  /** run.start 的 waitMs：最多等到终态/超时；只结束等待，不取消任务。 */
  waitForCompletion(runId: RunId, waitMs: number): Promise<RunState> {
    const run = this.store.runs.get(runId);
    if (run !== null && isTerminalRunState(run.state)) return Promise.resolve(run.state);
    return new Promise<RunState>((resolve) => {
      const waiter: CompletionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeCompletionWaiter(runId, waiter);
          resolve(this.store.runs.get(runId)?.state ?? "unknown");
        }, waitMs),
      };
      const list = this.completionWaiters.get(runId);
      if (list === undefined) this.completionWaiters.set(runId, [waiter]);
      else list.push(waiter);
    });
  }

  private removeCompletionWaiter(runId: RunId, waiter: CompletionWaiter): void {
    clearTimeout(waiter.timer);
    const list = this.completionWaiters.get(runId);
    if (list === undefined) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.completionWaiters.delete(runId);
  }

  private settleRun(runId: RunId, state: RunState): void {
    const list = this.completionWaiters.get(runId);
    if (list === undefined) return;
    this.completionWaiters.delete(runId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      waiter.resolve(state);
    }
  }

  // ---------------------------------------------------------------- 派发

  private startDispatch(runId: RunId, sessionId: SessionId, clientRequestId: string, prompt: string): void {
    this.dispatching = true;
    const active: ActiveExecution = {
      runId,
      sessionId,
      clientRequestId,
      prompt,
      execution: Promise.resolve(),
      stopExecution: null,
      handle: null,
      cancelRequested: false,
    };
    this.active = active;
    active.execution = (async () => {
      try {
        await this.runItem(active);
      } finally {
        // stop() 收到 outcome 后仍可能在核对/回收工具。并发停止请求会扩展
        // gate；直到最后一个收尾结束前，都不允许 pump 派发下一会话。
        for (;;) {
          const stopping = active.stopExecution;
          if (stopping === null) break;
          await stopping;
          if (stopping === active.stopExecution) break;
        }
      }
    })();
    void active.execution.then(
      () => {
        if (this.active === active) this.active = null;
        this.dispatching = false;
        this.pump();
      },
      () => {
        if (this.active === active) this.active = null;
        this.dispatching = false;
        this.pump();
      },
    );
  }

  private pump(): void {
    if (this.active !== null || this.dispatching || this.draining || this.stopUnconfirmedRunId !== null) return;
    this.dropExpired();
    const item = this.items[0];
    if (item === undefined) return;
    const run = this.store.runs.get(item.runId);
    if (run === null || isTerminalRunState(run.state)) {
      this.items.shift();
      if (run !== null) this.settleRun(run.runId, run.state);
      this.pump();
      return;
    }
    this.items.shift();
    this.startDispatch(item.runId, item.sessionId, item.clientRequestId, item.prompt);
  }

  /** 队列到期：落库 cancelled（未派发），重试凭回执只会看到原 run 的终态。 */
  private dropExpired(): void {
    const nowMs = Date.parse(this.now());
    for (;;) {
      const head = this.items[0];
      if (head === undefined || Date.parse(head.expiresAt) > nowMs) break;
      this.items.shift();
      this.cancelUndispatched(head.runId, "QUEUE_EXPIRED");
      this.onEvent(`queue item expired: ${head.runId}`);
    }
  }

  /** 未派发（无发送意图）的 run 落 cancelled；这是唯一诚实的「未执行」收敛。 */
  private cancelUndispatched(runId: RunId, reason: string): void {
    const run = this.store.runs.get(runId);
    if (run === null || isTerminalRunState(run.state)) {
      if (run !== null) this.settleRun(runId, run.state);
      return;
    }
    if (run.backendAttemptId !== null || run.state !== "queued") {
      // 已经提交过发送意图或离开 queued：不能宣称「未派发」，保守落 unknown。
      const attempt = run.backendAttemptId;
      if (attempt !== null) {
        this.store.recordDispatchUnknown(attempt, { detail: `调度取消时已有发送意图: ${reason}` });
      } else {
        this.convergeUnknown(runId, reason);
      }
      this.settleRun(runId, this.store.runs.require(runId).state);
      return;
    }
    const transition = this.store.transitionRun(runId, "cancelled", { payload: { reason } });
    this.approvals.sweepRun(runId);
    this.settleRun(runId, transition.run.state);
  }

  private convergeUnknown(runId: RunId, reason: string): void {
    let run = this.store.runs.require(runId);
    if (isTerminalRunState(run.state)) return;
    if (run.state === "queued") {
      run = this.store.transitionRun(runId, "starting", { payload: { reason } }).run;
    }
    this.store.transitionRun(runId, "unknown", { payload: { reason } });
  }

  private async runItem(active: ActiveExecution): Promise<void> {
    const runId = active.runId;
    try {
      const run = this.store.runs.require(runId);
      const session = this.store.sessions.require(run.sessionId);
      const workspace = this.store.workspaces.require(session.workspaceId);
      if (workspace.copyRoot === null) {
        throw new ZBridgeError("BACKEND_UNAVAILABLE", "工作副本缺失，无法执行（登记不完整）");
      }

      const guard = (): "ok" | "cancelled" => {
        if (active.cancelRequested) return "cancelled";
        const current = this.store.runs.get(runId);
        if (current === null || isTerminalRunState(current.state)) return "cancelled";
        return "ok";
      };

      const handle = await this.runtime.ensure(run.backendId, workspace.workspaceId, workspace.generation, session.sessionId);
      active.handle = handle;
      if (guard() === "cancelled") {
        this.cancelUndispatched(runId, "CANCELLED_BEFORE_DISPATCH");
        return;
      }
      // 模型选择以 run 行的持久化值为准（重启后派发也保持受理时的选择）；
      // 历史 NULL 行只属于 opencode（固定 MiniMax 时期的事实解释）；
      // 新后端的 run 必然持久化了原生模型 ID，NULL 即数据违规。
      const model = requireRunModel(run.backendId, run.selectedModel);
      await this.runtime.prepareSession(handle, session.sessionId, model);
      if (guard() === "cancelled") {
        this.cancelUndispatched(runId, "CANCELLED_BEFORE_DISPATCH");
        return;
      }
      // 派发前最后一刻：daemon 在这里捕获工作副本基线（diff 工件的对照点）。
      if (this.runtime.beforeDispatch !== undefined) {
        await this.runtime.beforeDispatch(handle, runId);
        if (guard() === "cancelled") {
          this.cancelUndispatched(runId, "CANCELLED_BEFORE_DISPATCH");
          return;
        }
      }
      // coordinator.run 内部：prepareDispatch（possibly_sent 边界）→ HTTP → 终态。
      // 它自己负责 pre-send 过期检查、发送证据落库与 unknown 收敛。
      await handle.coordinator.run({ runId, prompt: active.prompt, deadlineAt: run.deadlineAt, model });
      this.runtime.onRunSettled(handle, runId);
      this.approvals.sweepRun(runId);
      const snapshot = this.store.getRunSnapshot(runId);
      this.settleRun(runId, snapshot.state);
      this.onEvent(`run settled: ${runId} -> ${snapshot.state}`);
    } catch (error) {
      this.handleExecutionFailure(active, error);
    }
  }

  /** 新会话省略 backend 时的默认后端（daemon 加载配置的 defaultBackend）。 */
  private defaultBackendId(): BackendId {
    return this.options.backendSelection.defaultBackendId();
  }

  /** 新会话/显式 backend 的可选性检查：未配置、禁用或 review 未开放即拒绝。 */
  private assertBackendSelectable(backendId: BackendId): void {
    this.options.backendSelection.assertBackendSelectable(backendId);
  }

  private handleExecutionFailure(active: ActiveExecution, error: unknown): void {
    const runId = active.runId;
    const code = error instanceof ZBridgeError ? error.code : "UNKNOWN";
    if (code === "STOP_UNCONFIRMED") this.stopUnconfirmedRunId = runId;
    const detail = error instanceof Error ? error.message : String(error);
    this.onEvent(`run dispatch failed: ${runId} (${code}): ${detail}`);
    const run = this.store.runs.get(runId);
    if (run === null) return;
    if (isTerminalRunState(run.state)) {
      this.settleRun(runId, run.state);
      return;
    }
    if (run.backendAttemptId !== null) {
      // 可能已发出：一律 unknown 并阻塞，绝不改报 cancelled。
      this.store.recordDispatchUnknown(run.backendAttemptId, {
        detail: `派发后异常: ${code}`,
      });
      this.approvals.sweepRun(runId);
      this.settleRun(runId, this.store.runs.require(runId).state);
      return;
    }
    if (run.state === "queued") {
      // 未提交发送意图：可以诚实地声明「未执行」。
      const transition = this.store.transitionRun(runId, "cancelled", { payload: { reason: `DISPATCH_FAILED_${code}`.slice(0, 64) } });
      this.approvals.sweepRun(runId);
      this.settleRun(runId, transition.run.state);
      return;
    }
    this.convergeUnknown(runId, `DISPATCH_FAILED_${code}`.slice(0, 64));
    this.approvals.sweepRun(runId);
    this.settleRun(runId, this.store.runs.require(runId).state);
  }

  // ---------------------------------------------------------------- 停止与关停

  async stop(input: { readonly runId?: RunId; readonly clientRequestId?: string; readonly intent: "interrupt" | "cancel" }): Promise<StopReport> {
    let runId = input.runId ?? null;
    if (runId === null && input.clientRequestId !== undefined) {
      const item = this.items.find((candidate) => candidate.clientRequestId === input.clientRequestId);
      if (item !== undefined) {
        this.items.splice(this.items.indexOf(item), 1);
        this.cancelUndispatched(item.runId, "CANCELLED_BY_OPERATOR");
        return { found: "queued", confirmed: true, method: "queue_cancel", state: "cancelled" };
      }
      const receipt = this.store.findReceiptByClientRequest(this.principalId, TOOL_NAME, input.clientRequestId);
      runId = receipt?.runId ?? null;
      if (runId === null) {
        return { found: "not_found", confirmed: null, method: "none", state: "unknown" };
      }
    }
    if (runId === null) {
      return { found: "not_found", confirmed: null, method: "none", state: "unknown" };
    }
    const queuedItem = this.items.find((candidate) => candidate.runId === runId);
    if (queuedItem !== undefined) {
      this.items.splice(this.items.indexOf(queuedItem), 1);
      this.cancelUndispatched(queuedItem.runId, "CANCELLED_BY_OPERATOR");
      return { found: "queued", confirmed: true, method: "queue_cancel", state: "cancelled" };
    }
    const run = this.store.runs.get(runId);
    if (run === null) {
      return { found: "not_found", confirmed: null, method: "none", state: "unknown" };
    }
    if (isTerminalRunState(run.state)) {
      return { found: "run", confirmed: false, method: "none", state: run.state };
    }

    const active = this.active;
    if (active !== null && active.runId === runId) {
      // 先置取消意图：派发路径在每个 await 后检查，阻止晚派发。
      active.cancelRequested = true;
      if (active.handle !== null) {
        const stopping = active.handle.coordinator.stop({ runId, intent: input.intent, graceMs: this.limits.stopGraceMs });
        const tracked = stopping.then(
          (outcome) => { if (!outcome.confirmed) this.stopUnconfirmedRunId = runId; },
          () => { this.stopUnconfirmedRunId = runId; },
        );
        active.stopExecution = Promise.all([active.stopExecution, tracked]).then(() => undefined);
        const outcome = await stopping;
        this.approvals.sweepRun(runId);
        const state = this.store.runs.require(runId).state;
        this.settleRun(runId, state);
        return { found: "run", confirmed: outcome.confirmed, method: outcome.method, state };
      }
      // handle 尚未建立（还在 ensure/prepareSession 阶段）：guard 会阻止派发，
      // 这里同步收敛为「未派发即取消」。
      this.cancelUndispatched(runId, "CANCELLED_BEFORE_DISPATCH");
      return { found: "run", confirmed: true, method: "queue_cancel", state: this.store.runs.require(runId).state };
    }
    // 非活动非终态（恢复残留等）：按状态收敛，不重发。
    this.cancelUndispatched(runId, "CANCELLED_BY_OPERATOR");
    const finalState = this.store.runs.require(runId).state;
    return {
      found: "run",
      confirmed: finalState === "cancelled" ? true : finalState === "unknown" ? false : null,
      method: finalState === "cancelled" ? "queue_cancel" : "none",
      state: finalState,
    };
  }

  /** 关停：取消队列（落库）、有界停止活动 run、清空待批。 */
  async shutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) break;
      this.cancelUndispatched(item.runId, "DAEMON_SHUTDOWN");
    }
    this.approvals.sweepAll();
    const active = this.active;
    if (active !== null) {
      active.cancelRequested = true;
      if (active.handle !== null) {
        try {
          await active.handle.coordinator.stop({
            runId: active.runId,
            intent: "cancel",
            graceMs: this.limits.stopGraceMs,
          });
        } catch {
          // 停止失败保持 unknown 语义，不在关停路径里掩盖。
        }
      } else {
        this.cancelUndispatched(active.runId, "DAEMON_SHUTDOWN");
      }
      this.approvals.sweepRun(active.runId);
      const state = this.store.runs.get(active.runId)?.state;
      if (state !== undefined) this.settleRun(active.runId, state);
      // 停止回执可先于 adapter 的观察循环结束。等它释放 active，再关闭
      // worker，否则 close() 会报 SESSION_BUSY 并留下独占后端进程。
      // 启动或停止路径异常时也只等一个有界窗口，不阻塞 daemon 关停。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.limits.stopGraceMs + 1_000);
        void active.execution.then(
          () => { clearTimeout(timer); resolve(); },
          () => { clearTimeout(timer); resolve(); },
        );
      });
    }
    await this.runtime.closeAll();
  }
}

/** opencode 历史 NULL selectedModel 的固定解释；其它后端的 NULL 是数据违规。 */
function legacyModelRefFor(backendId: BackendId): string {
  if (backendId === "opencode") return LEGACY_MODEL_REF;
  throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", `${backendId} run 缺少持久化模型选择，拒绝派发`);
}

/** 派发前把持久化 modelRef 解析为后端中立选择；格式不符即协议错误。 */
function requireRunModel(backendId: BackendId, selectedModel: string | null): BackendModelSelection {
  if (selectedModel === null) {
    if (backendId === "opencode") {
      return { backendId, modelRef: LEGACY_MODEL_REF, opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } };
    }
    throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", `${backendId} run 缺少持久化模型选择，拒绝派发`);
  }
  const parsed = parseBackendModelRef(backendId, selectedModel);
  if (parsed === null) {
    throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", `run 模型选择 ${selectedModel} 与后端 ${backendId} 的格式不符`);
  }
  return parsed;
}
