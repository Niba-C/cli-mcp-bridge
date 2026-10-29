/**
 * 持久化门面：受理、状态/事件事务、dispatch 证据、审批、工件、结果与恢复。
 *
 * 边界（OC-02）：
 * - 只使用 `node:sqlite`；不启动 OpenCode，不发 HTTP，不调用模型；
 * - 所有写操作都是本地事务；发送外部请求的调用点在 `prepareDispatch` 提交之后，
 *   由 OC-03 的 adapter 负责；
 * - 恢复入口只读写数据库并返回待核对信息，不声称检查或终止了任何进程。
 */
import type { IsoTimestamp, Principal } from "../contracts/common.ts";
import { assertIsoTimestamp, assertOwned, assertWorkspaceAllowed } from "../contracts/common.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import type { ApprovalId, ArtifactId, PrincipalId, RunId, SessionId, WorkspaceId } from "../contracts/ids.ts";
import { payloadHash } from "../contracts/json.ts";
import { CONTRACT_VERSION } from "../contracts/version.ts";
import {
  isTerminalRunState,
  nextActionFor,
  LEGACY_MODEL_REF,
  type Approval,
  type ApprovalDecision,
  type ApprovalRequestKind,
  type ArtifactMeta,
  type ArtifactProvenance,
  type EventType,
  type Run,
  type RunEvent,
  type RunSnapshot,
  type RunState,
  type WorkspaceProfile,
} from "../contracts/index.ts";
import { reduceRunState } from "../core/run-machine.ts";
import { SqliteConnection, openSqlite } from "./db.ts";
import { defaultIdFactory, type IdFactory } from "./ids.ts";
import { migrate } from "./migrations.ts";
import { ApprovalRepository, type InsertApprovalInput } from "./repositories/approval.ts";
import { ArtifactRepository, toArtifactMeta } from "./repositories/artifact.ts";
import { DispatchRepository } from "./repositories/dispatch.ts";
import { EventRepository } from "./repositories/event.ts";
import { ReceiptRepository, type ReceiptKey } from "./repositories/receipt.ts";
import { ResultRepository, type InsertClaimInput, type ResultChannel } from "./repositories/result.ts";
import { RunRepository } from "./repositories/run.ts";
import { ServiceRepository } from "./repositories/service.ts";
import { SessionRepository } from "./repositories/session.ts";
import { ToolReceiptRepository, type ToolReceipt } from "./repositories/toolreceipt.ts";
import { WorkspaceRepository } from "./repositories/workspace.ts";
import {
  WorkerProcessRepository,
  type WorkerProcessRecord,
  type WorkerProcessStatus,
} from "./repositories/worker.ts";
import type {
  DispatchIntent,
  EventPageResult,
  RecoveryDisposition,
  RecoveryReport,
  RecoveryRunReport,
  RequestReceipt,
  ResultInput,
  ResultManifest,
  RunTransitionResult,
  ServerInstance,
  ServiceInstance,
  SessionRecord,
} from "./types.ts";

export interface BridgeStoreOptions {
  readonly now?: () => IsoTimestamp;
  readonly ids?: IdFactory;
  /** 默认打开即迁移；只读检查可传 false。 */
  readonly migrate?: boolean;
}

export interface AdmitRunInput {
  readonly principal: Principal;
  readonly sessionId: SessionId;
  readonly toolName: string;
  readonly clientRequestId: string;
  readonly serviceEpoch: number;
  readonly prompt: string;
  readonly profile?: WorkspaceProfile;
  readonly deadlineAt: IsoTimestamp;
  /**
   * OC-08：受理时已解析的完整模型标识（`providerID/modelID`；新后端为原生 ID）。
   * 重放既有回执时必须传原 run 持久化的值（历史 NULL 行按固定 MiniMax 解释），
   * 不能按「此刻默认值」重新解析。
   */
  readonly model: string;
  /**
   * OC-09：本 run 解析后的后端归属。重放旧回执时传原 run 的 backendId
   * （migration v5 前的行确定为 opencode），不能按当前 defaultBackend 重解析。
   */
  readonly backend: import("../contracts/version.ts").BackendId;
}

export interface AdmitRunResult {
  readonly run: Run;
  readonly receipt: RequestReceipt;
  readonly reused: boolean;
}

export interface PrepareDispatchInput {
  readonly runId: RunId;
  readonly backendSessionId: string;
  readonly serverEpoch: number;
  readonly attemptId?: string;
  readonly at?: IsoTimestamp;
}

export interface PrepareDispatchResult {
  readonly intent: DispatchIntent;
  readonly run: Run;
  readonly event: RunEvent | null;
}

export interface CreateApprovalInput {
  readonly approvalId?: ApprovalId;
  readonly runId: RunId;
  readonly attemptId: string;
  readonly serverEpoch: number;
  readonly requestKind: ApprovalRequestKind;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly argumentsText: string;
  readonly targetPaths: readonly string[];
  readonly payloadHash: string;
  readonly policyVersion: string;
  readonly expiresAt: IsoTimestamp;
  readonly repeatCount?: number;
  readonly at?: IsoTimestamp;
}

export interface CompleteRunResult {
  readonly run: Run;
  readonly event: RunEvent;
  readonly manifest: ResultManifest;
}

const EVENT_TYPE_BY_STATE: Readonly<Record<RunState, EventType>> = Object.freeze({
  queued: "run.queued",
  starting: "run.started",
  running: "run.state",
  waiting_approval: "run.approval_required",
  waiting_input: "run.input_required",
  draining: "run.draining",
  stopping: "run.stop_requested",
  completed: "run.terminal",
  failed: "run.terminal",
  cancelled: "run.terminal",
  interrupted: "run.terminal",
  timed_out: "run.terminal",
  unknown: "run.unknown",
});

const PAYLOAD_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_EVENT_PAGE = 500;

function clampDetail(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function requireText(value: string, field: string, max = 256): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ZBridgeError("INVALID_ARGUMENT", `${field} 必须为 1–${max} 字符`, { details: { field } });
  }
  return trimmed;
}

export class BridgeStore {
  /** 原始连接：仓库与迁移共用；测试可做受控的行级模拟（如迁移前数据形状）。 */
  readonly connection: SqliteConnection;
  private readonly clock: () => IsoTimestamp;
  readonly ids: IdFactory;

  readonly workspaces: WorkspaceRepository;
  readonly services: ServiceRepository;
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly receipts: ReceiptRepository;
  readonly dispatches: DispatchRepository;
  readonly approvals: ApprovalRepository;
  readonly artifacts: ArtifactRepository;
  readonly results: ResultRepository;
  readonly workers: WorkerProcessRepository;
  readonly toolReceipts: ToolReceiptRepository;

  private constructor(connection: SqliteConnection, options: BridgeStoreOptions) {
    this.connection = connection;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.ids = options.ids ?? defaultIdFactory;
    this.workspaces = new WorkspaceRepository(connection, this.ids);
    this.services = new ServiceRepository(connection);
    this.sessions = new SessionRepository(connection, this.ids, this.workspaces, this.services);
    this.runs = new RunRepository(connection);
    this.events = new EventRepository(connection);
    this.receipts = new ReceiptRepository(connection);
    this.dispatches = new DispatchRepository(connection);
    this.approvals = new ApprovalRepository(connection);
    this.artifacts = new ArtifactRepository(connection, this.ids);
    this.results = new ResultRepository(connection);
    this.workers = new WorkerProcessRepository(connection);
    this.toolReceipts = new ToolReceiptRepository(connection);
  }

  static open(path: string, options: BridgeStoreOptions = {}): BridgeStore {
    const store = new BridgeStore(openSqlite({ path }), options);
    if (options.migrate !== false) store.migrate();
    return store;
  }

  static openMemory(options: BridgeStoreOptions = {}): BridgeStore {
    return BridgeStore.open(":memory:", options);
  }

  migrate(): number {
    return migrate(this.connection, this.now());
  }

  /** 已应用迁移，供 doctor/测试核对；只读。 */
  appliedMigrations(): readonly { version: number; name: string; appliedAt: string }[] {
    const exists = this.connection.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (exists === undefined) return [];
    const rows = this.connection.raw
      .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
      .all();
    return rows.map((row) => ({
      version: Number(row["version"]),
      name: String(row["name"]),
      appliedAt: String(row["applied_at"]),
    }));
  }

  close(): void {
    this.connection.close();
  }

  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn);
  }

  now(): IsoTimestamp {
    return this.clock();
  }

  private at(input?: IsoTimestamp): IsoTimestamp {
    const at = input ?? this.clock();
    return assertIsoTimestamp(at, "at");
  }

  // ---------------------------------------------------------------- 代际与绑定

  beginService(input: { pid?: number | null; at?: IsoTimestamp } = {}): ServiceInstance {
    return this.services.beginService({ pid: input.pid ?? null, at: this.at(input.at) });
  }

  beginServerInstance(input: {
    serviceEpoch: number;
    /** OC-09：该运行时归属的后端；省略时按历史行为登记 opencode。 */
    backendId?: import("../contracts/version.ts").BackendId;
    pid?: number | null;
    runDir?: string | null;
    backendVersion?: string | null;
    at?: IsoTimestamp;
  }): ServerInstance {
    return this.services.beginServer({
      serviceEpoch: input.serviceEpoch,
      backendId: input.backendId,
      pid: input.pid ?? null,
      runDir: input.runDir ?? null,
      backendVersion: input.backendVersion ?? null,
      at: this.at(input.at),
    });
  }

  currentServiceEpoch(): number | null {
    return this.services.currentServiceEpoch();
  }

  /** OC-09：读取一个后端运行时代际（含 backendId 归属）；不存在返回 null。 */
  getServerInstance(serverEpoch: number): ServerInstance | null {
    return this.services.getServer(serverEpoch);
  }

  createWorkspace(input: {
    workspaceId?: WorkspaceId;
    name: string;
    canonicalRoot: string;
    profiles: readonly WorkspaceProfile[];
    copyRoot?: string | null;
    generation?: number;
    at?: IsoTimestamp;
  }) {
    return this.workspaces.create({ ...input, at: this.at(input.at) });
  }

  createSession(input: {
    sessionId?: SessionId;
    ownerId: Principal["principalId"];
    workspaceId: WorkspaceId;
    profile: WorkspaceProfile;
    /** OC-09：会话固定归属的后端；省略时按历史行为创建 opencode 会话。 */
    backendId?: import("../contracts/version.ts").BackendId;
    at?: IsoTimestamp;
  }): SessionRecord {
    return this.sessions.create({ ...input, at: this.at(input.at) });
  }

  bindSessionBackend(
    sessionId: SessionId,
    backendSessionId: string | null,
    serverEpoch: number | null,
    at?: IsoTimestamp,
  ): SessionRecord {
    return this.sessions.bind(sessionId, backendSessionId, serverEpoch, this.at(at));
  }

  /**
   * 本地核对后解除 unknown 阻塞。只改数据库标记，不做后端探活，
   * 也不把 recoveryVerification 升成 verified。
   */
  releaseSessionBlock(sessionId: SessionId, at?: IsoTimestamp): SessionRecord {
    return this.sessions.unblock(sessionId, this.at(at));
  }

  // ---------------------------------------------------------------- worker 归属

  /**
   * 记录 daemon 自己启动的 worker 身份。PID 只是线索，`processIdentity`
   * （`ps lstart` 串）用于防 PID 复用误判；daemon 崩溃后恢复逻辑凭这条记录行事。
   */
  recordWorkerStart(input: {
    readonly serverEpoch: number;
    readonly serviceEpoch: number;
    /** OC-09：worker 归属后端；省略按 opencode 登记。 */
    readonly backendId?: import("../contracts/version.ts").BackendId;
    readonly pid: number;
    readonly pgid: number;
    readonly processIdentity: string | null;
    readonly executable: string;
    readonly runDir: string;
    readonly at?: IsoTimestamp;
  }): WorkerProcessRecord {
    return this.workers.record({ ...input, at: this.at(input.at) });
  }

  getWorker(serverEpoch: number): WorkerProcessRecord | null {
    return this.workers.get(serverEpoch);
  }

  listWorkersByStatus(status: WorkerProcessStatus): readonly WorkerProcessRecord[] {
    return this.workers.listByStatus(status);
  }

  listWorkerRecords(): readonly WorkerProcessRecord[] {
    return this.workers.list();
  }

  recordWorkerDescendants(
    serverEpoch: number,
    descendants: readonly { readonly pid: number; readonly identity: string | null }[],
    at?: IsoTimestamp,
  ): WorkerProcessRecord {
    return this.workers.setDescendants(serverEpoch, descendants, this.at(at));
  }

  markWorkerStatus(
    serverEpoch: number,
    status: WorkerProcessStatus,
    options: { at?: IsoTimestamp; note?: string | null } = {},
  ): WorkerProcessRecord {
    return this.workers.setStatus(serverEpoch, status, this.at(options.at), options.note);
  }

  /** 服务代际收敛为已停止（daemon 恢复/关停路径使用）。 */
  stopServer(serverEpoch: number, at?: IsoTimestamp, status: "stopped" | "crashed" = "stopped"): ServerInstance {
    return this.services.stopServer(serverEpoch, this.at(at), status);
  }

  // ---------------------------------------------------------------- 受理

  /**
   * OC-04：daemon 重启后 serviceEpoch 已变，重试方只有 clientRequestId。
   * 幂等要求重试沿用原 run（原期限、原回执），不得再次执行；查不到才允许新受理。
   */
  findReceiptByClientRequest(principalId: string, toolName: string, clientRequestId: string): RequestReceipt | null {
    return this.receipts.findLatestByClientRequest(principalId, toolName, clientRequestId);
  }

  /**
   * 受理 run：回执 + run（含模型选择）+ 会话占用 + 初始事件在同一事务。
   *
   * 幂等：key 由 principalId + toolName + clientRequestId + serviceEpoch 组成。
   * 参数哈希由本函数按规范化 JSON 计算，调用方没有提供 requestHash 的入口。
   * OC-08 起哈希包含解析后的 model；迁移前的旧回执按不含 model 的旧形状匹配，
   * 匹配上即重放原回执（旧 run 的模型固定 MiniMax，不重新解析）。
   */
  admitRun(input: AdmitRunInput): AdmitRunResult {
    const at = this.at();
    const toolName = requireText(input.toolName, "toolName", 64);
    const clientRequestId = requireText(input.clientRequestId, "clientRequestId", 200);
    if (!Number.isInteger(input.serviceEpoch) || input.serviceEpoch < 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "serviceEpoch 必须是 ≥1 的整数");
    }
    if (input.prompt.trim().length === 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "prompt 不能为空");
    }
    if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new ZBridgeError("INVALID_ARGUMENT", "prompt 超过 64KiB 上限");
    }
    if (typeof input.model !== "string" || input.model.length === 0 || input.model.length > 257) {
      throw new ZBridgeError("INVALID_ARGUMENT", "OC-08 起 admitRun 必须携带已解析的完整模型标识");
    }
    if (input.backend !== "opencode" && input.backend !== "codebuddy" && input.backend !== "qoder") {
      throw new ZBridgeError("INVALID_ARGUMENT", "OC-09 起 admitRun 必须携带已解析的后端 ID");
    }
    // 模型格式按后端区分：opencode 是 provider/model 双段；新后端是原生单段 ID。
    // 单段格式与 contracts/config.ts 的 nativeModelIdSchema 一致。
    if (input.backend === "opencode") {
      const slash = input.model.indexOf("/");
      if (slash <= 0 || slash === input.model.length - 1 || input.model.indexOf("/", slash + 1) !== -1) {
        throw new ZBridgeError("INVALID_ARGUMENT", "opencode 后端的模型标识必须是 provider/model 双段");
      }
    } else if (input.model.includes("/") || /\s/.test(input.model) || input.model.startsWith("/")) {
      throw new ZBridgeError("INVALID_ARGUMENT", `${input.backend} 后端的模型标识必须是原生单段 ID`);
    }
    assertIsoTimestamp(input.deadlineAt, "deadlineAt");

    const key: ReceiptKey = {
      principalId: input.principal.principalId,
      toolName,
      clientRequestId,
      serviceEpoch: input.serviceEpoch,
    };
    // OC-09 起哈希包含解析后的 backend；OC-08 形状（含 model 无 backend）与
    // 迁移前形状（无 model）只用于旧回执重放匹配，且仅当本次请求解析为
    // opencode 时启用——旧回执全部归属 opencode，显式 codebuddy/qoder 请求
    // 不能在删掉 backend 字段后误命中旧 OpenCode 回执。
    const requestHash = payloadHash({
      toolName,
      sessionId: input.sessionId,
      profile: input.profile ?? null,
      prompt: input.prompt,
      deadlineAt: input.deadlineAt,
      model: input.model,
      backend: input.backend,
    });
    const oc08RequestHash =
      input.backend === "opencode"
        ? payloadHash({
            toolName,
            sessionId: input.sessionId,
            profile: input.profile ?? null,
            prompt: input.prompt,
            deadlineAt: input.deadlineAt,
            model: input.model,
          })
        : null;
    const legacyRequestHash =
      input.backend === "opencode"
        ? payloadHash({
            toolName,
            sessionId: input.sessionId,
            profile: input.profile ?? null,
            prompt: input.prompt,
            deadlineAt: input.deadlineAt,
          })
        : null;

    return this.transaction(() => {
      const existing = this.receipts.get(key);
      if (existing !== null) {
        // 幂等重试仍要过当前身份与资源访问检查；但不重做 busy/代际检查，
        // 否则重启或占用状态会破坏「同 key 返回原回执」。
        const existingRun = this.runs.require(existing.runId);
        const existingSession = this.sessions.require(existingRun.sessionId);
        assertOwned(input.principal, existingSession.ownerId as PrincipalId, "session");
        assertWorkspaceAllowed(input.principal, existingSession.workspaceId);
        this.workspaces.require(existingSession.workspaceId);
        if (existing.requestHash !== requestHash) {
          if (legacyRequestHash !== null && existing.requestHash === legacyRequestHash) {
            // 迁移前的旧格式回执：哈希不含 model，那时实现固定 MiniMax。
            // 重放必须携带这一历史解释值；其它 model 一律按参数变化冲突（纵深防御：
            // 经 daemon/scheduler 的路径本会在调度层被拦，这里保护直连 admitRun 的调用方）。
            if (input.model !== LEGACY_MODEL_REF) {
              throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的参数不同，拒绝第二次执行", {
                details: { tool: toolName, clientRequestId, serviceEpoch: input.serviceEpoch },
              });
            }
          } else if (oc08RequestHash !== null && existing.requestHash === oc08RequestHash) {
            // OC-08 时期的回执：哈希含 model 无 backend。只有解析为 opencode 的
            // 请求才允许这样匹配（见上方哈希构造），且 run 归属必须一致。
            const existingRunForHash = this.runs.require(existing.runId);
            if (existingRunForHash.backendId !== "opencode") {
              throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的参数不同，拒绝第二次执行", {
                details: { tool: toolName, clientRequestId, serviceEpoch: input.serviceEpoch },
              });
            }
          } else {
            throw new ZBridgeError("IDEMPOTENCY_CONFLICT", "同一 clientRequestId 的参数不同，拒绝第二次执行", {
              details: { tool: toolName, clientRequestId, serviceEpoch: input.serviceEpoch },
            });
          }
        }
        // 旧 epoch 的同一 key 重试也只返回原回执，不重新执行。
        return { run: existingRun, receipt: existing, reused: true };
      }

      const currentEpoch = this.services.currentServiceEpoch();
      if (currentEpoch === null || input.serviceEpoch !== currentEpoch) {
        throw new ZBridgeError("EPOCH_MISMATCH", "请求携带的 serviceEpoch 不是当前活动代际，拒绝执行", {
          details: { requested: input.serviceEpoch, current: currentEpoch },
        });
      }

      const session = this.sessions.require(input.sessionId);
      assertOwned(input.principal, session.ownerId as PrincipalId, "session");
      assertWorkspaceAllowed(input.principal, session.workspaceId);
      // OC-09 不变量：run 归属会话固定的后端。受理路径必须先解析后端、再按它
      // 创建/选择会话；这里拦截路由错误，防止把 run 写成与会话不同的后端。
      if (input.backend !== session.backendId) {
        throw new ZBridgeError("INVALID_ARGUMENT", "受理后端与会话归属不一致", {
          details: { sessionBackend: session.backendId, requested: input.backend },
        });
      }
      const workspace = this.workspaces.require(session.workspaceId);

      const profile = input.profile ?? session.profile;
      if (profile !== session.profile) {
        throw new ZBridgeError("PROFILE_NOT_ALLOWED", "session 的 profile 不能在本轮改变", {
          details: { sessionProfile: session.profile, requested: profile },
        });
      }
      if (!workspace.profiles.includes(profile)) {
        throw new ZBridgeError("POLICY_REVOKED", "workspace 已不再开放该 profile");
      }
      if (session.workspaceGeneration !== workspace.generation) {
        throw new ZBridgeError("POLICY_REVOKED", "workspace generation 已变化，旧 session 不自动扩权", {
          details: { sessionGeneration: session.workspaceGeneration, workspaceGeneration: workspace.generation },
        });
      }
      if (session.state === "closed") {
        throw new ZBridgeError("SESSION_CLOSED", "session 已关闭");
      }
      if (session.blockedReason !== null) {
        throw new ZBridgeError("SESSION_BUSY", "session 有未核对的 unknown 结果，后续任务受阻", {
          details: { reason: session.blockedReason, blockedRunId: session.blockedRunId },
        });
      }
      if (session.state !== "idle" || this.sessions.countActiveRuns(session.sessionId) > 0) {
        throw new ZBridgeError("SESSION_BUSY", "session 正在执行其它任务");
      }

      const runId = this.ids.run();
      const run = this.runs.insert({
        runId,
        sessionId: session.sessionId,
        ownerId: session.ownerId,
        workspaceId: session.workspaceId,
        requestId: clientRequestId,
        requestHash,
        requestTool: toolName,
        profile,
        /** OC-09：run 归属会话固定后端；受理后不改写。 */
        backendId: session.backendId,
        state: "queued",
        revision: 1,
        lastEventSeq: 1,
        selectedModel: input.model,
        deadlineAt: input.deadlineAt,
        createdAt: at,
        updatedAt: at,
      });
      this.events.insert({
        runId,
        seq: 1,
        type: "run.queued",
        at,
        state: "queued",
        payload: { tool: toolName, clientRequestId, profile, model: input.model },
      });
      this.sessions.setState(session.sessionId, "busy", at);
      // 会话记住本次受理的模型选择；后续省略 model 的请求沿用它（同事务，崩溃不落半条）。
      this.sessions.setLastSelectedModel(session.sessionId, input.model, at);
      const receipt = this.receipts.insert(key, requestHash, runId, at);
      return { run, receipt, reused: false };
    });
  }

  // ---------------------------------------------------------------- 状态与事件

  /**
   * 通用状态迁移入口。`completed` 例外：它必须通过 `completeRunWithResult()`
   * 与结果清单一起原子写入，不能从通用入口绕过。
   */
  transitionRun(
    runId: RunId,
    to: RunState,
    options: { at?: IsoTimestamp; type?: EventType; payload?: Record<string, string | number | boolean | null> } = {},
  ): RunTransitionResult {
    const at = this.at(options.at);
    return this.transaction(() => {
      const run = this.runs.require(runId);
      if (to === "completed" && run.state !== "completed") {
        return {
          run,
          event: null,
          accepted: false,
          reason: isTerminalRunState(run.state) ? "terminal_immutable" : "illegal_transition",
        };
      }
      return this.transitionInTx(run, to, at, options);
    });
  }

  private transitionInTx(
    run: Run,
    to: RunState,
    at: IsoTimestamp,
    options: { type?: EventType; payload?: Record<string, string | number | boolean | null> } = {},
  ): RunTransitionResult {
    const step = reduceRunState(run.state, to);
    if (!step.accepted) {
      return { run, event: null, accepted: false, reason: step.reason };
    }
    if (run.state === to) {
      return { run, event: null, accepted: true, reason: null };
    }
    const seq = run.lastEventSeq + 1;
    const event = this.events.insert({
      runId: run.runId,
      seq,
      type: options.type ?? EVENT_TYPE_BY_STATE[to],
      at,
      state: to,
      payload: options.payload ?? {},
    });
    const updated = this.runs.updateState(run.runId, to, seq, at);
    this.applySessionOccupancyInTx(updated, at);
    return { run: updated, event, accepted: true, reason: null };
  }

  private applySessionOccupancyInTx(run: Run, at: IsoTimestamp): void {
    if (!isTerminalRunState(run.state)) {
      this.sessions.setState(run.sessionId, "busy", at);
      return;
    }
    if (run.state === "unknown") {
      // 结果不明：终态但持续阻塞，直到本地核对后显式解除。
      this.sessions.block(run.sessionId, run.runId, "unknown_outcome", at);
      return;
    }
    const session = this.sessions.require(run.sessionId);
    if (session.blockedReason === null && this.sessions.countActiveRuns(run.sessionId) === 0) {
      this.sessions.setState(run.sessionId, "idle", at);
    }
  }

  /**
   * 追加一条不改变状态的业务事件（`run.progress`／`run.tool`／`run.warning`）。
   *
   * 状态迁移与事件必须共用同一个水位：这里把 `revision` 与 `last_event_seq`
   * 一起推进到新 `seq`，因此 `seq === revision` 仍然成立。终态 run 不再追加，
   * 避免晚到的进度事件把已完成任务的水位抬高。
   */
  appendRunEvent(
    runId: RunId,
    input: { readonly type: EventType; readonly payload?: Record<string, string | number | boolean | null>; readonly at?: IsoTimestamp },
  ): RunEvent {
    const at = this.at(input.at);
    return this.transaction(() => {
      const run = this.runs.require(runId);
      if (isTerminalRunState(run.state)) {
        throw new ZBridgeError("INVALID_ARGUMENT", "终态 run 不能再追加业务事件", {
          details: { state: run.state },
        });
      }
      const seq = run.lastEventSeq + 1;
      const event = this.events.insert({
        runId: run.runId,
        seq,
        type: input.type,
        at,
        state: run.state,
        payload: input.payload ?? {},
      });
      this.runs.updateState(run.runId, run.state, seq, at);
      return event;
    });
  }

  /**
   * 读取事件页。游标早于保留水位时明确 CURSOR_EXPIRED；
   * 游标超前于任务水位时 REVISION_CONFLICT，不静默截断。
   */
  readEvents(runId: RunId, options: { afterSeq?: number; limit?: number } = {}): EventPageResult {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "afterSeq 必须是 ≥0 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
      throw new ZBridgeError("INVALID_ARGUMENT", `limit 必须是 1–${MAX_EVENT_PAGE} 的整数`);
    }
    return this.connection.readTransaction(() => {
      const run = this.runs.require(runId);
      if (afterSeq > run.lastEventSeq) {
        throw new ZBridgeError("REVISION_CONFLICT", "事件游标超前于当前水位", {
          details: { afterSeq, lastEventSeq: run.lastEventSeq },
        });
      }
      const earliestSeq = this.runs.getEarliestSeq(runId);
      if (afterSeq + 1 < earliestSeq) {
        throw new ZBridgeError("CURSOR_EXPIRED", "事件游标已早于保留起点", {
          details: { afterSeq, earliestSeq },
        });
      }
      const rows = this.events.list(runId, afterSeq, limit);
      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;
      const nextSeq = events.length === 0 ? afterSeq : (events[events.length - 1]?.seq ?? afterSeq);
      return {
        runId,
        events,
        nextSeq,
        earliestSeq,
        hasMore,
        snapshotRevision: run.revision,
        runState: run.state,
      };
    });
  }

  /** 仅用于保留策略与游标过期测试；不会改 revision。 */
  pruneEvents(runId: RunId, throughSeq: number): number {
    if (!Number.isInteger(throughSeq) || throughSeq < 0) {
      throw new ZBridgeError("INVALID_ARGUMENT", "throughSeq 必须是 ≥0 的整数");
    }
    return this.transaction(() => {
      const run = this.runs.require(runId);
      const through = Math.min(throughSeq, run.lastEventSeq);
      const deleted = this.events.deleteThrough(runId, through);
      if (through > 0) this.runs.raiseEarliestSeq(runId, through + 1);
      return deleted;
    });
  }

  getRun(runId: RunId, principal?: Principal): Run {
    const run = this.runs.require(runId);
    if (principal !== undefined) assertOwned(principal, this.ownerOfRun(run), "run");
    return run;
  }

  private ownerOfRun(run: Run): PrincipalId {
    const row = this.connection.raw.prepare("SELECT owner_id FROM runs WHERE run_id = ?").get(run.runId);
    if (row === undefined) throw new ZBridgeError("NOT_FOUND", "run 不存在");
    return String(row["owner_id"]) as PrincipalId;
  }

  getRunSnapshot(runId: RunId, principal?: Principal): RunSnapshot {
    return this.connection.readTransaction(() => {
      const run = this.getRun(runId, principal);
      const manifest = this.results.getByRun(runId);
      return {
        contractVersion: CONTRACT_VERSION,
        runId: run.runId,
        sessionId: run.sessionId,
        backendId: run.backendId,
        state: run.state,
        revision: run.revision,
        lastEventSeq: run.lastEventSeq,
        earliestSeq: this.runs.getEarliestSeq(runId),
        nextAction: nextActionFor(run.state, manifest !== null),
        resultReady: manifest !== null,
        warnings: [],
        selectedModel: run.selectedModel,
        observedModel: run.observedModel,
      };
    });
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * 提交发送意图。这个方法返回后，调用方才可以发外部请求。
   * 意图以 `possibly_sent` 落库：即使进程在发送前死亡，也会被恢复流程判为
   * 「可能已执行」而不是「未派发」。
   */
  prepareDispatch(input: PrepareDispatchInput): PrepareDispatchResult {
    const at = this.at(input.at);
    return this.transaction(() => {
      const run = this.runs.require(input.runId);
      if (isTerminalRunState(run.state)) {
        throw new ZBridgeError("INVALID_ARGUMENT", "终态 run 不能再提交发送意图", {
          details: { state: run.state },
        });
      }
      if (run.state !== "queued" && run.state !== "starting") {
        throw new ZBridgeError("INVALID_ARGUMENT", "只有 queued/starting 的 run 可以提交发送意图", {
          details: { state: run.state },
        });
      }
      if (run.backendAttemptId !== null || this.dispatches.findByRun(run.runId) !== null) {
        throw new ZBridgeError("INVALID_ARGUMENT", "该 run 已有发送意图，禁止自动重发");
      }
      const session = this.sessions.require(run.sessionId);
      if (
        session.backendSessionId === null ||
        session.serverEpoch === null ||
        session.backendSessionId !== input.backendSessionId ||
        session.serverEpoch !== input.serverEpoch
      ) {
        throw new ZBridgeError("EPOCH_MISMATCH", "dispatch 的后端会话/代际与 session 绑定不一致", {
          details: { serverEpoch: input.serverEpoch, sessionServerEpoch: session.serverEpoch },
        });
      }
      this.services.requireActiveServer(input.serverEpoch);

      const attemptId = input.attemptId ?? this.ids.attempt();
      const intent = this.dispatches.insert({
        attemptId,
        runId: run.runId,
        sessionId: session.sessionId,
        backendSessionId: input.backendSessionId,
        serverEpoch: input.serverEpoch,
        at,
      });
      this.runs.setBackendAttempt(run.runId, attemptId, at);

      let updated = this.runs.require(run.runId);
      let event: RunEvent | null = null;
      if (updated.state === "queued") {
        const transition = this.transitionInTx(updated, "starting", at, {
          type: "run.started",
          payload: { attemptId },
        });
        updated = transition.run;
        event = transition.event;
      }
      return { intent, run: updated, event };
    });
  }

  getDispatchIntent(attemptId: string): DispatchIntent | null {
    return this.dispatches.get(attemptId);
  }

  /**
   * 发送前就确定 messageID 时立即落库（阶段仍是 possibly_sent）。
   *
   * 目的：任务挂起或崩溃时，数据库里也有「这一次可能用了哪个消息」的证据，
   * 不必等到整轮结束再补记。
   */
  setDispatchMessageId(
    attemptId: string,
    input: { backendMessageId: string; at?: IsoTimestamp },
  ): DispatchIntent {
    const at = this.at(input.at);
    const messageId = requireText(input.backendMessageId, "backendMessageId", 128);
    return this.transaction(() => {
      const intent = this.dispatches.require(attemptId);
      if (intent.phase === "not_sent") {
        throw new ZBridgeError("INVALID_ARGUMENT", "已证明未派发的意图不能记录消息 ID", {
          details: { phase: intent.phase },
        });
      }
      if (intent.backendMessageId !== null && intent.backendMessageId !== messageId) {
        throw new ZBridgeError("INVALID_ARGUMENT", "backendMessageId 与已记录的不一致");
      }
      return this.dispatches.setMessageId(attemptId, at, messageId);
    });
  }

  markDispatchSent(
    attemptId: string,
    input: { at?: IsoTimestamp; backendMessageId?: string | null } = {},
  ): DispatchIntent {
    const at = this.at(input.at);
    const messageId = input.backendMessageId === undefined || input.backendMessageId === null
      ? null
      : requireText(input.backendMessageId, "backendMessageId", 128);
    return this.transaction(() => {
      const intent = this.dispatches.require(attemptId);
      if (intent.phase === "sent" || intent.phase === "confirmed") {
        if (messageId !== null && intent.backendMessageId !== null && messageId !== intent.backendMessageId) {
          throw new ZBridgeError("INVALID_ARGUMENT", "backendMessageId 与已记录的不一致");
        }
        return intent;
      }
      if (intent.phase !== "possibly_sent") {
        throw new ZBridgeError("INVALID_ARGUMENT", "只有 possibly_sent 的意图可以标记为已发出", {
          details: { phase: intent.phase },
        });
      }
      return this.dispatches.markSent(attemptId, at, messageId);
    });
  }

  /**
   * 记录后端历史里已确认本 run 的消息。确认不等于完成：
   * 没有终态证据时 run 仍是活跃任务，重启恢复也不能凭确认报成功。
   */
  markDispatchConfirmed(
    attemptId: string,
    input: { at?: IsoTimestamp; backendMessageId: string },
  ): DispatchIntent {
    const at = this.at(input.at);
    const messageId = requireText(input.backendMessageId, "backendMessageId", 128);
    return this.transaction(() => {
      const intent = this.dispatches.require(attemptId);
      if (intent.phase === "confirmed") {
        if (intent.backendMessageId !== null && intent.backendMessageId !== messageId) {
          throw new ZBridgeError("INVALID_ARGUMENT", "backendMessageId 与已确认的不一致");
        }
        return intent;
      }
      if (intent.phase !== "sent") {
        throw new ZBridgeError("INVALID_ARGUMENT", "只有已发出（sent）的证据才能确认消息", {
          details: { phase: intent.phase },
        });
      }
      return this.dispatches.markConfirmed(attemptId, at, messageId);
    });
  }

  /** 发送在写出前被明确拒绝：这是唯一可以安全声明「未派发」的路径。 */
  markDispatchNotSent(
    attemptId: string,
    input: { at?: IsoTimestamp; detail?: string | null } = {},
  ): DispatchIntent {
    const at = this.at(input.at);
    return this.transaction(() => {
      const intent = this.dispatches.require(attemptId);
      if (intent.phase === "not_sent") return intent;
      if (intent.phase !== "possibly_sent") {
        throw new ZBridgeError("INVALID_ARGUMENT", "当前证据不允许声明未派发", {
          details: { phase: intent.phase },
        });
      }
      return this.dispatches.markNotSent(attemptId, at, clampDetail(input.detail));
    });
  }

  /**
   * 记录发送结果不明：run 立刻变 unknown 并阻塞 session，不重发。
   * 已确认的消息保留 confirmed 证据，只把 run 收敛为 unknown。
   */
  recordDispatchUnknown(
    attemptId: string,
    input: { at?: IsoTimestamp; detail?: string | null } = {},
  ): { intent: DispatchIntent; run: Run; event: RunEvent | null } {
    const at = this.at(input.at);
    return this.transaction(() => {
      const intent = this.dispatches.require(attemptId);
      if (intent.phase === "not_sent") {
        throw new ZBridgeError("INVALID_ARGUMENT", "已证明未派发的意图不能标为 unknown");
      }
      let updatedIntent = intent;
      if (intent.phase === "possibly_sent" || intent.phase === "sent") {
        updatedIntent = this.dispatches.markUnknown(attemptId, at, clampDetail(input.detail));
      } else {
        updatedIntent = this.dispatches.setDetail(
          attemptId,
          clampDetail(input.detail) ?? "确认消息未收尾，恢复时保持 unknown",
          at,
        );
      }
      let run = this.runs.require(intent.runId);
      let event: RunEvent | null = null;
      if (!isTerminalRunState(run.state)) {
        if (run.state === "queued") {
          const starting = this.transitionInTx(run, "starting", at, { payload: { attemptId } });
          run = starting.run;
        }
        const transition = this.transitionInTx(run, "unknown", at, {
          payload: { attemptId, dispatchPhase: intent.phase },
        });
        run = transition.run;
        event = transition.event;
      }
      return { intent: updatedIntent, run, event };
    });
  }

  // ---------------------------------------------------------------- 结果

  /**
   * 完成 run 并写入结果清单：manifest + claims + 终态事件在同一事务。
   * completed 必须从 draining 进入，否则拒绝。
   */
  completeRunWithResult(
    runId: RunId,
    input: ResultInput,
    options: { at?: IsoTimestamp } = {},
  ): CompleteRunResult {
    const at = this.at(options.at);
    const claims = this.normalizeClaims(runId, input);
    return this.transaction(() => {
      const run = this.runs.require(runId);
      if (run.state !== "draining") {
        throw new ZBridgeError("INVALID_ARGUMENT", "completed 必须经过 draining，当前状态不允许写结果", {
          details: { state: run.state },
        });
      }
      const manifestId = this.ids.manifest();
      this.results.insertManifest(manifestId, runId, this.ownerOfRun(run), at);
      this.results.insertClaims(manifestId, claims);
      this.runs.setResultManifest(runId, manifestId, at);
      const transition = this.transitionInTx(this.runs.require(runId), "completed", at, {
        type: "run.terminal",
        payload: {
          resultManifestId: manifestId,
          agentReported: input.agentReported?.length ?? 0,
          observed: input.observed?.length ?? 0,
          verification: input.verification?.length ?? 0,
        },
      });
      if (transition.event === null) {
        throw new ZBridgeError("INVALID_ARGUMENT", "结果写入未能产生终态事件");
      }
      const manifest = this.results.get(manifestId);
      if (manifest === null) throw new ZBridgeError("INVALID_ARGUMENT", "结果清单写入后无法读回");
      return { run: transition.run, event: transition.event, manifest };
    });
  }

  private normalizeClaims(runId: RunId, input: ResultInput): readonly InsertClaimInput[] {
    const claims: InsertClaimInput[] = [];
    const push = (channel: ResultChannel, items: readonly { text: string; evidenceRef?: string | null }[] | undefined): void => {
      for (const item of items ?? []) {
        const text = item.text.trim();
        if (text.length === 0 || text.length > 16_000) {
          throw new ZBridgeError("INVALID_ARGUMENT", "结果条目文本必须为 1–16000 字符");
        }
        const evidenceRef = item.evidenceRef?.trim() ?? null;
        if (channel === "agentReported" && evidenceRef !== null) {
          throw new ZBridgeError("INVALID_ARGUMENT", "agentReported 是模型自述，不能附带证据引用");
        }
        if (channel === "verification" && (evidenceRef === null || evidenceRef.length === 0)) {
          throw new ZBridgeError("INVALID_ARGUMENT", "verification 必须有证据引用，不能只写“已验证”");
        }
        if (evidenceRef !== null && evidenceRef.startsWith("art_")) {
          const artifact = this.artifacts.get(evidenceRef as ArtifactId);
          if (artifact === null || artifact.runId !== runId) {
            throw new ZBridgeError("INVALID_ARGUMENT", "结果引用的工件不存在或不属于本 run");
          }
        }
        claims.push({ channel, text, evidenceRef });
      }
    };
    push("agentReported", input.agentReported);
    push("observed", input.observed);
    push("verification", input.verification);
    return claims;
  }

  getResultManifest(runId: RunId, principal?: Principal): ResultManifest {
    const run = this.getRun(runId, principal);
    const manifest = this.results.getByRun(run.runId);
    if (manifest === null) {
      throw new ZBridgeError("RESULT_NOT_READY", "结果清单尚未写入", { details: { runId } });
    }
    return manifest;
  }

  // ---------------------------------------------------------------- 审批

  createApproval(input: CreateApprovalInput, principal?: Principal): Approval {
    const at = this.at(input.at);
    return this.transaction(() => {
      const run = this.runs.require(input.runId);
      if (principal !== undefined) assertOwned(principal, this.ownerOfRun(run), "run");
      if (isTerminalRunState(run.state)) {
        throw new ZBridgeError("INVALID_ARGUMENT", "终态 run 不能再创建审批");
      }
      const session = this.sessions.require(run.sessionId);
      const intent = this.dispatches.require(input.attemptId);
      if (intent.runId !== run.runId || intent.sessionId !== session.sessionId) {
        throw new ZBridgeError("INVALID_ARGUMENT", "审批的 attempt 不属于该 run/session");
      }
      if (intent.serverEpoch !== input.serverEpoch || session.serverEpoch !== input.serverEpoch) {
        throw new ZBridgeError("EPOCH_MISMATCH", "审批的 serverEpoch 与 session/dispatch 不一致", {
          details: { approvalEpoch: input.serverEpoch, sessionEpoch: session.serverEpoch },
        });
      }
      this.services.requireActiveServer(input.serverEpoch);
      if (!PAYLOAD_HASH_RE.test(input.payloadHash)) {
        throw new ZBridgeError("INVALID_ARGUMENT", "approval.payloadHash 必须是 sha256:<64 hex>");
      }
      assertIsoTimestamp(input.expiresAt, "expiresAt");
      const repeatCount = input.repeatCount ?? 1;
      if (!Number.isInteger(repeatCount) || repeatCount < 1) {
        throw new ZBridgeError("INVALID_ARGUMENT", "approval.repeatCount 必须是 ≥1 的整数");
      }
      const row: InsertApprovalInput = {
        approvalId: input.approvalId ?? this.ids.approval(),
        ownerId: this.ownerOfRun(run),
        runId: run.runId,
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        attemptId: input.attemptId,
        serverEpoch: input.serverEpoch,
        requestKind: input.requestKind,
        toolName: requireText(input.toolName, "toolName", 128),
        toolCallId: requireText(input.toolCallId, "toolCallId", 128),
        argumentsText: input.argumentsText,
        targetPaths: input.targetPaths,
        payloadHash: input.payloadHash,
        policyVersion: requireText(input.policyVersion, "policyVersion", 64),
        expiresAt: input.expiresAt,
        repeatCount,
        createdAt: at,
      };
      return this.approvals.insert(row);
    });
  }

  /**
   * 本地可信决策的存储记录。**不发送** permission reply；OC-04 才有 operator 通道。
   * 过期后再决策会先落 expired，再报 APPROVAL_EXPIRED，避免留下一个可复用的 pending。
   */
  recordLocalApprovalDecision(
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    atInput?: IsoTimestamp,
  ): Approval {
    const at = this.at(atInput);
    const approval = this.approvals.require(approvalId);
    if (approval.state !== "pending") {
      const code = approval.state === "expired" || approval.state === "cancelled" ? "APPROVAL_EXPIRED" : "APPROVAL_DENIED";
      throw new ZBridgeError(code, "审批已不在 pending 状态", { details: { state: approval.state } });
    }
    if (Date.parse(at) > Date.parse(approval.summary.expiresAt)) {
      this.transaction(() => this.approvals.expire(approvalId, at, "expired", "product_expiry"));
      throw new ZBridgeError("APPROVAL_EXPIRED", "审批已超过期限，许可不可复用");
    }
    return this.transaction(() => this.approvals.decide(approvalId, decision, "operator", at));
  }

  expireApproval(
    approvalId: ApprovalId,
    input: { at?: IsoTimestamp; actor?: "product_expiry" | "channel_lost"; state?: "expired" | "cancelled" } = {},
  ): Approval {
    const at = this.at(input.at);
    const actor = input.actor ?? "product_expiry";
    const state = input.state ?? (actor === "channel_lost" ? "cancelled" : "expired");
    return this.transaction(() => this.approvals.expire(approvalId, at, state, actor));
  }

  listPendingApprovals(runId: RunId | null = null): readonly Approval[] {
    return this.approvals.listPending(runId);
  }

  // ---------------------------------------------------------------- 工件

  addArtifact(input: {
    artifactId?: ArtifactId;
    ownerId: Principal["principalId"];
    runId: RunId;
    mediaType: string;
    sha256: string;
    bytes: number;
    internalPath: string;
    provenance: ArtifactProvenance;
    label?: string | null;
    truncated?: boolean;
    at?: IsoTimestamp;
  }) {
    const at = this.at(input.at);
    return this.transaction(() => {
      const run = this.runs.require(input.runId);
      if (input.ownerId !== this.ownerOfRun(run)) {
        throw new ZBridgeError("NOT_FOUND", "run 不存在");
      }
      return this.artifacts.add({ ...input, at });
    });
  }

  getArtifact(artifactId: ArtifactId, principal: Principal) {
    const artifact = this.artifacts.require(artifactId);
    assertOwned(principal, artifact.ownerId, "artifact");
    return artifact;
  }

  getArtifactMeta(artifactId: ArtifactId, principal: Principal): ArtifactMeta {
    return toArtifactMeta(this.getArtifact(artifactId, principal));
  }

  // ---------------------------------------------------------------- 停止类工具回执（OC-05）

  /** 跨代际取同 key 最近一次回执；没有则 null。 */
  findToolReceipt(principalId: string, toolName: string, clientRequestId: string): ToolReceipt | null {
    return this.toolReceipts.findLatest(principalId, toolName, clientRequestId);
  }

  /** 回执与业务动作不要求同一事务（stop 面向外部进程），但写入本身是原子的。 */
  recordToolReceipt(input: {
    readonly principalId: string;
    readonly toolName: string;
    readonly clientRequestId: string;
    readonly serviceEpoch: number;
    readonly requestHash: string;
    readonly targetId: string;
    readonly response: Record<string, unknown>;
  }): ToolReceipt {
    return this.transaction(() =>
      this.toolReceipts.insert({
        principalId: input.principalId,
        toolName: input.toolName,
        clientRequestId: input.clientRequestId,
        serviceEpoch: input.serviceEpoch,
        requestHash: input.requestHash,
        targetId: input.targetId,
        responseJson: JSON.stringify(input.response),
        at: this.at(),
      }),
    );
  }

  /**
   * 关闭 idle 会话：owner 校验 + 忙碌拒绝 + state→closed 原子完成。
   * 保留历史与后端绑定（不 DELETE 后端 session，也不停止 worker）。
   * `receipt` 存在时与状态变更同一事务落库，且响应由 `buildResponse` 在
   * 事务内基于关闭后的最新状态构造，保证回执与响应完全一致。
   */
  closeIdleSession(
    sessionId: SessionId,
    principal: Principal,
    options: {
      readonly at?: IsoTimestamp;
      readonly receipt?: {
        readonly toolName: string;
        readonly clientRequestId: string;
        readonly serviceEpoch: number;
        readonly requestHash: string;
        readonly buildResponse: (closed: SessionRecord) => Record<string, unknown>;
      };
    } = {},
  ): { readonly session: SessionRecord; readonly response: Record<string, unknown> | null } {
    const closedAt = this.at(options.at);
    return this.transaction(() => {
      const session = this.sessions.require(sessionId);
      assertOwned(principal, session.ownerId as PrincipalId, "session");
      let response: Record<string, unknown> | null = null;
      if (session.state !== "closed") {
        if (session.state !== "idle" || this.sessions.countActiveRuns(sessionId) > 0) {
          throw new ZBridgeError("SESSION_BUSY", "session 不是 idle 状态，拒绝关闭", {
            details: { sessionId, state: session.state },
          });
        }
        this.sessions.setState(sessionId, "closed", closedAt);
      }
      const closed = this.sessions.require(sessionId);
      if (options.receipt !== undefined) {
        response = options.receipt.buildResponse(closed);
        this.toolReceipts.insert({
          principalId: principal.principalId,
          toolName: options.receipt.toolName,
          clientRequestId: options.receipt.clientRequestId,
          serviceEpoch: options.receipt.serviceEpoch,
          requestHash: options.receipt.requestHash,
          targetId: sessionId,
          responseJson: JSON.stringify(response),
          at: closedAt,
        });
      }
      return { session: closed, response };
    });
  }

  // ---------------------------------------------------------------- 恢复

  /**
   * 启动恢复：只读/更新数据库，不启动进程、不调用模型、不重发。
   *
   * - 有 dispatch 证据（possibly_sent/sent/confirmed/unknown）的活跃 run → unknown 并阻塞；
   * - confirmed 只说明消息存在，没有终态证据时不得报成功；
   * - 没有任何 dispatch 证据（或明确 not_sent）的 run → interrupted/cancelled；
   * - 不检查也不终止任何后代进程，报告中明确 `descendantsConfirmedStopped=false`。
   */
  recoverPendingRuns(atInput?: IsoTimestamp): RecoveryReport {
    const at = this.at(atInput);
    // 候选列表用一致读快照获取，但只作提示；每个 run 在独立写事务内重新读取
    // 当前状态后再决策，因此另一个连接在此期间完成的 run 不会被旧快照改写。
    const candidates = this.connection.readTransaction(() => this.runs.listNonTerminal());
    const reports: RecoveryRunReport[] = [];

    for (const candidate of candidates) {
      const report = this.transaction((): RecoveryRunReport | null => {
        const run = this.runs.get(candidate.runId);
        if (run === null || isTerminalRunState(run.state)) return null;

        const sessionBefore = this.sessions.require(run.sessionId);
        const intent = this.dispatches.findByRun(run.runId);
        let disposition: RecoveryDisposition;
        if (intent === null || intent.phase === "not_sent") disposition = "never_dispatched";
        else if (intent.phase === "confirmed") disposition = "confirmed_but_unsettled";
        else disposition = "possibly_executed";

        const notes: string[] = [];
        let stateAfter: RunState;
        if (intent !== null && intent.phase !== "not_sent") {
          notes.push("存在派发证据；无法确认外部执行是否完成，按 unknown 处理并阻塞会话");
          if (disposition === "confirmed_but_unsettled") {
            notes.push("后端消息已确认，但没有终态证据；不能凭消息存在报成功");
          }
          let current = run;
          if (current.state === "queued") {
            current = this.transitionInTx(current, "starting", at, { payload: { recovered: true } }).run;
          }
          const transition = this.transitionInTx(current, "unknown", at, {
            payload: {
              recovered: true,
              attemptId: intent.attemptId,
              dispatchPhase: intent.phase,
            },
          });
          if (!transition.accepted) {
            // 理论上所有活跃态都可到 unknown；数据损坏时不要伪造成功。
            notes.push(`状态机拒绝 ${current.state} → unknown（${transition.reason ?? "unknown"}）`);
            stateAfter = current.state;
          } else {
            stateAfter = transition.run.state;
          }
        } else {
          const chain: RunState[] =
            run.state === "queued"
              ? ["cancelled"]
              : run.state === "stopping"
                ? ["interrupted"]
                : ["stopping", "interrupted"];
          let current = run;
          for (const next of chain) {
            const transition = this.transitionInTx(current, next, at, { payload: { recovered: true } });
            if (!transition.accepted) break;
            current = transition.run;
          }
          stateAfter = current.state;
          notes.push(
            intent === null
              ? "没有派发意图：从未提交给后端"
              : "派发意图明确为 not_sent：可确认未写入后端",
          );
        }

        const sessionAfter = this.sessions.require(run.sessionId);
        return {
          runId: run.runId,
          sessionId: run.sessionId,
          stateBefore: run.state,
          stateAfter,
          disposition,
          attemptId: intent?.attemptId ?? null,
          dispatchPhase: intent?.phase ?? null,
          backendSessionId: intent?.backendSessionId ?? sessionBefore.backendSessionId,
          serverEpoch: intent?.serverEpoch ?? sessionBefore.serverEpoch,
          backendMessageId: intent?.backendMessageId ?? null,
          blocked: sessionAfter.blockedReason !== null,
          notes,
        };
      });
      if (report !== null) reports.push(report);
    }

    const pendingVerifications = reports.filter((report) => report.disposition !== "never_dispatched");
    return {
      at,
      serviceEpoch: this.services.currentServiceEpoch(),
      runs: reports,
      pendingVerifications,
      descendantsConfirmedStopped: false,
      notes: [
        "恢复入口只读写 SQLite；没有启动或停止 OpenCode，也没有调用模型",
        "数据库恢复不等于后端恢复验证：session.recoveryVerification 保持原值",
        "未检查或终止任何工具后代进程；unknown 会话需本地核对后显式解除",
      ],
    };
  }
}
