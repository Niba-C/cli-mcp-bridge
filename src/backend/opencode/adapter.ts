/**
 * OpenCode 1.18.32 HTTP adapter（技术规格 §5～§7）。
 *
 * 分层：本文件只做编排（worker + API + 事件流 + 归属 + 终态判定），
 * URL／JSON 形状在 `protocol.ts`，SSE 解码在 `sse.ts`，HTTP 三态在 `http.ts`，
 * 进程与进程组在 `worker.ts`，文本累积在 `text-tracker.ts`，审批在 `approvals.ts`。
 *
 * 六条硬规则：
 * 1. 每次 execute 都显式生成用户 messageID，归属靠 messageID + parentID + sessionID；
 * 2. `prompt_async` 的 2xx 只表示受理：必须再从历史确认同一 messageID 才叫 confirmed；
 * 3. `session.idle`、`session/status` 缺项、SSE 断开、HTTP 204 都不能单独判完成；
 * 4. 终态一律经 `core/backend-result.ts` 的纯映射；`tool-calls` 不是终态；
 * 5. 写请求只发一次，没有重试；传输不明一律保守（unknown），不猜成功；
 * 6. 停止只有「匹配终态 + 工具结束 + 无待批」或「独占进程树已退出」才算 confirmed。
 */
import { randomBytes } from "node:crypto";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendEventSink,
  BackendSessionRef,
  BackendPolicyProfile,
  ModelSelection,
  SessionSpec,
  StopOutcome,
  StopSpec,
  TurnOutcome,
  TurnSpec,
  TurnUsage,
} from "../../contracts/backend.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { TerminalRunState } from "../../contracts/run.ts";
import { OPENCODE_PINNED_VERSION } from "../../contracts/version.ts";
import { mapOpencodeTurn, type BackendTurnResult } from "../../core/backend-result.ts";
import { terminalStateForStop } from "../../core/run-machine.ts";
import { ApprovalCoordinator, type ApprovalContext } from "./approvals.ts";
import { OpenCodeApi, type ProviderSummary } from "./client.ts";
import { TurnEventStream, type EventStreamStats } from "./event-stream.ts";
import { OpencodeHttpClient } from "./http.ts";
import {
  assertResponseIdentity,
  buildModelGate,
  collectSecretValues,
  modelRef,
  permissionRules,
  redactSecrets,
  type ModelGate,
} from "./profile.ts";
import {
  attributeRun,
  collectTools,
  lastAssistantFields,
  newUserMessageId,
  type Attribution,
  type OpencodeMessage,
  type SessionStatusKind,
  type ToolObservation,
} from "./protocol.ts";
import { TextTracker } from "./text-tracker.ts";
import {
  OpenCodeWorker,
  pinnedServeCommand,
  type ProcessTableRead,
  type WorkerCommand,
  type WorkerSpawnInfo,
  type WorkerStartResult,
} from "./worker.ts";
import { requireOpencodeSelection } from "../registry.ts";

export type { WorkerSpawnInfo } from "./worker.ts";

export interface OpenCodeAdapterOptions {
  /** OpenCode 可执行文件绝对路径；默认由 live 入口传入 Homebrew 安装路径。 */
  readonly executable: string;
  readonly workspaceRoot: string;
  /** 本产品独占运行目录（独立 HOME／XDG／config／data）。 */
  readonly runDir: string;
  /** 已过滤到登记供应商的配置（providerID → OpenCode 配置对象）；不读取用户全局配置。 */
  readonly providerConfigs: Readonly<Record<string, unknown>>;
  /** 产品配置 `backend.modelProfiles`：允许列表与 default 的来源。 */
  readonly modelProfiles: Readonly<Record<string, ModelSelection>>;
  readonly policyProfile: BackendPolicyProfile;
  readonly pinnedVersion?: string;
  /** worker 代际；由 store 的 beginServerInstance 分配，离线测试可省略。 */
  readonly serverEpoch?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly permissionPollMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly stopSettleMs?: number;
  readonly confirmTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly onServerStarted?: (info: WorkerStartResult) => void;
  /** spawn 之后、健康检查之前立即回调（daemon 据此先行落库 worker 身份）。 */
  readonly onSpawned?: (info: WorkerSpawnInfo) => void;
  /**
   * **仅供离线测试**注入模拟服务命令。生产入口不要传：默认使用
   * `pinnedServeCommand(executable)`，参数固定且 hostname 只能是 loopback。
   */
  readonly testCommand?: WorkerCommand;
  /** **仅供离线测试**模拟进程表不可读（验证保守分支）。 */
  readonly testProcessTable?: () => ProcessTableRead;
}

export type RequestOutcome = "accepted" | "rejected" | "unknown";

export interface OpenCodeDispatchObservation {
  readonly requestOutcome: RequestOutcome;
  readonly httpStatus: number | null;
  /** 历史里确实存在本 run 的用户消息。 */
  readonly messageConfirmed: boolean;
  readonly backendMessageId: string;
}

export type TurnStopCause =
  | "stop_intent"
  | "deadline"
  | "approval_timeout"
  | "channel_lost"
  | "input_unsupported"
  | "worker_exit"
  | null;

export interface TurnObservations {
  readonly assistantMessages: number;
  readonly toolCalls: readonly ToolObservation[];
  readonly progressEvents: number;
  readonly firstTextMs: number | null;
  readonly sessionStatus: SessionStatusKind;
  readonly requestedProviderID: string;
  readonly requestedModelID: string;
  readonly reportedProviderID: string | null;
  readonly reportedModelID: string | null;
  readonly sse: EventStreamStats;
  readonly warnings: readonly string[];
}

export interface OpenCodeTurnResult {
  readonly outcome: TurnOutcome;
  readonly dispatch: OpenCodeDispatchObservation;
  readonly stopCause: TurnStopCause;
  readonly stopIntent: "interrupt" | "cancel" | "close" | null;
  readonly mapped: BackendTurnResult;
  readonly observations: TurnObservations;
}

interface ActiveTurn {
  readonly runId: RunId;
  readonly userMessageId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  /** 本 run 选定的模型；身份校验与 prompt 都用它，不是 adapter 级常量。 */
  readonly requestedModel: ModelSelection;
  stopping: boolean;
  stopIntent: "interrupt" | "cancel" | "close" | null;
  stopRequestedAtMs: number | null;
  readonly assistantIds: Set<string>;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PERMISSION_POLL_MS = 1_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_STOP_SETTLE_MS = 5_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 30_000;

export class OpenCodeHttpAdapter implements BackendAdapter {
  private readonly options: OpenCodeAdapterOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: ModelGate;
  private readonly warnings: string[] = [];
  private worker: OpenCodeWorker | null = null;
  private api: OpenCodeApi | null = null;
  private startPromise: Promise<void> | null = null;
  private serverEpoch: number | null = null;
  private active: ActiveTurn | null = null;
  /** 启动时观测到的供应商摘要；每轮派发前用它核对选定模型的可用性。 */
  private providerSummary: ProviderSummary | null = null;
  private closed = false;

  constructor(options: OpenCodeAdapterOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.serverEpoch = options.serverEpoch ?? null;
    this.gate = buildModelGate(options.modelProfiles);
  }

  // ------------------------------------------------------------------ 生命周期

  get baseUrl(): string | null {
    return this.worker?.url ?? null;
  }

  get workerPid(): number | null {
    return this.worker?.pid ?? null;
  }

  get currentServerEpoch(): number | null {
    return this.serverEpoch;
  }

  get diagnostics(): readonly string[] {
    return this.warnings;
  }

  private log(line: string): void {
    const secrets = collectSecretValues(this.options.providerConfigs);
    this.options.log?.(redactSecrets(line, secrets));
  }

  private command(): WorkerCommand {
    if (this.options.testCommand !== undefined) return this.options.testCommand;
    return pinnedServeCommand(this.options.executable);
  }

  private async startWorker(epoch: number): Promise<void> {
    const worker = new OpenCodeWorker({
      command: this.command(),
      runDir: this.options.runDir,
      workspaceRoot: this.options.workspaceRoot,
      providerConfigs: this.options.providerConfigs,
      registeredProviderIDs: this.gate.providerIDs,
      defaultModelRef: this.gate.defaultRef,
      policyProfile: this.options.policyProfile,
      pinnedVersion: this.options.pinnedVersion ?? OPENCODE_PINNED_VERSION,
      ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      ...(this.options.stopGraceMs === undefined ? {} : { stopGraceMs: this.options.stopGraceMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      ...(this.options.testProcessTable === undefined ? {} : { testProcessTable: this.options.testProcessTable }),
      ...(this.options.onSpawned === undefined ? {} : { onSpawned: this.options.onSpawned }),
      log: (line) => this.log(line),
    });
    let started: WorkerStartResult;
    try {
      started = await worker.start();
    } catch (error) {
      // 启动失败也要清理自身资源：worker 可能已经 spawn 但没就绪。
      await worker.stop("SIGKILL", 2_000).catch(() => undefined);
      throw error;
    }
    const httpClient = new OpencodeHttpClient({
      baseUrl: started.baseUrl,
      authorization: worker.authorization,
      ...(this.options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.options.requestTimeoutMs }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    this.worker = worker;
    this.api = new OpenCodeApi(httpClient);
    this.serverEpoch = epoch;
    this.options.onServerStarted?.(started);
    try {
      await this.verifyRegisteredProviders();
    } catch (error) {
      // 启动校验失败也必须清理自身资源，不能留下一个「看起来就绪」的 worker。
      await worker.stop("SIGKILL", 2_000).catch(() => undefined);
      this.worker = null;
      this.api = null;
      throw error;
    }
    this.log(`worker ready epoch=${epoch} pid=${started.pid}`);
  }

  /**
   * 启动即核对供应商集合：
   * - 已连接的供应商必须是本产品登记的集合（不允许未登记供应商混入运行）；
   * - default 模型必须被其供应商声明（配置接线问题在启动时失败，不是派发时才失败）。
   */
  private async verifyRegisteredProviders(): Promise<void> {
    const api = this.requireApi();
    const model = this.gate.defaultModel;
    const providers = await api.providers();
    if (!providers.ok) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "无法读取供应商列表，不能证明只启用了登记供应商", {
        details: { reason: providers.message },
      });
    }
    const registered = new Set(this.gate.providerIDs);
    const foreignConnected = providers.value.connected.filter((id) => !registered.has(id));
    if (foreignConnected.length > 0) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "存在未登记的已连接供应商，拒绝启动受控运行", {
        details: { foreignConnected, registered: [...this.gate.providerIDs] },
      });
    }
    const models = providers.value.models[model.providerID] ?? [];
    if (!models.includes(model.modelID)) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "登记供应商没有声明 default 模型", {
        details: { providerID: model.providerID, modelID: model.modelID, modelCount: models.length },
      });
    }
    if (!providers.value.connected.includes(model.providerID)) {
      this.warn("provider_not_connected: default 供应商未被标记为已连接，真实调用可能失败");
    }
    this.providerSummary = providers.value;
  }

  /**
   * 每轮派发前核对选定模型：未连接（缺凭据）或未声明（后端不支持）都明确失败，
   * 不静默改用 default 或其它模型。依据是启动时观测到的供应商摘要。
   * 两类失败都发生在任何 HTTP 发出之前，标记 pre_send 让协调层按「确定未派发」收敛。
   */
  private assertModelAvailable(model: ModelSelection): void {
    const summary = this.providerSummary;
    if (summary === null) return;
    if (!summary.connected.includes(model.providerID)) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "选定供应商未连接（可能缺少凭据），拒绝派发", {
        details: { providerID: model.providerID, connected: [...summary.connected], phase: "pre_send" },
      });
    }
    const models = summary.models[model.providerID] ?? [];
    if (!models.includes(model.modelID)) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "选定供应商没有声明该模型（后端不支持）", {
        details: { providerID: model.providerID, modelID: model.modelID, phase: "pre_send" },
      });
    }
  }

  private warn(message: string): void {
    if (this.warnings.length < 32 && !this.warnings.includes(message)) this.warnings.push(message);
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new ZBridgeError("BACKEND_UNAVAILABLE", "adapter 已关闭");
    if (this.worker !== null) {
      if (this.worker.hasExited) {
        throw new ZBridgeError("EPOCH_MISMATCH", "worker 已退出；必须用新的 serverEpoch 重启，不能复用旧代际", {
          details: { serverEpoch: this.serverEpoch },
        });
      }
      return;
    }
    if (this.startPromise !== null) {
      await this.startPromise;
      return;
    }
    const epoch = this.serverEpoch;
    if (epoch === null) {
      throw new ZBridgeError("INVALID_ARGUMENT", "缺少 serverEpoch：必须由 store 的 beginServerInstance 分配");
    }
    this.startPromise = this.startWorker(epoch);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * 换一个 worker 代际重启（服务重启续接）。旧 worker 必须确认退出，否则拒绝。
   */
  async restartWorker(epoch: number): Promise<WorkerStartResult> {
    if (!Number.isInteger(epoch) || epoch < 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "serverEpoch 必须是 ≥1 的整数");
    }
    if (this.active !== null) {
      throw new ZBridgeError("SESSION_BUSY", "有进行中的 run，不能重启 worker");
    }
    if (this.worker !== null) {
      const report = await this.worker.stop("SIGTERM", this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
      if (!report.exited) {
        throw new ZBridgeError("STOP_UNCONFIRMED", "旧 worker 未确认退出，拒绝启动新代际", {
          details: { detail: report.detail },
        });
      }
    }
    this.worker = null;
    this.api = null;
    await this.startWorker(epoch);
    const worker = this.worker as OpenCodeWorker | null;
    return {
      baseUrl: worker?.url ?? "",
      pid: worker?.pid ?? 0,
      processGroupId: worker?.pid ?? 0,
      version: this.options.pinnedVersion ?? OPENCODE_PINNED_VERSION,
    };
  }

  private requireApi(): OpenCodeApi {
    if (this.api === null) throw new ZBridgeError("BACKEND_UNAVAILABLE", "worker 尚未就绪");
    return this.api;
  }

  private assertEpoch(serverEpoch: number): void {
    if (this.serverEpoch === null) {
      this.serverEpoch = serverEpoch;
      return;
    }
    if (this.serverEpoch !== serverEpoch) {
      throw new ZBridgeError("EPOCH_MISMATCH", "后端会话代际与当前 worker 不一致", {
        details: { expected: this.serverEpoch, actual: serverEpoch },
      });
    }
  }

  // ------------------------------------------------------------------ 能力

  /**
   * 能力声明。
   *
   * 这里刻意区分两件事：
   * - `support` 是「adapter 有这条代码路径」的实现声明；
   * - `verifiedAt/evidenceRef` 是「本次探测真的观测到了」的证据。
   * probe 只调用 health/version，因此只有 versions.health 能带证据；
   * execute／stop／events／permission 等都没有逐项验证记录，证据字段必须为 null，
   * 不能让一次健康检查冒充「执行／取消已验证」。
   */
  async probe(): Promise<BackendCapabilities> {
    await this.ensureStarted();
    const api = this.requireApi();
    const health = await api.health();
    const version = health.ok ? health.version : null;
    const probedAt = new Date(this.now()).toISOString();
    const observed = { support: "supported" as const, verifiedAt: probedAt, evidenceRef: "opencode:GET /global/health" };
    /** 有实现、但本次未逐项验证：不带任何证据。 */
    const declared = (limitation: string) => ({
      support: "supported" as const,
      verifiedAt: null,
      evidenceRef: null,
      limitation,
    });
    const unknown = (limitation: string) => ({
      support: "unknown" as const,
      verifiedAt: null,
      evidenceRef: null,
      limitation,
    });
    const capabilities: BackendCapabilities = {
      adapterId: "opencode-http",
      policyProfile: this.options.policyProfile,
      // 只给引用，不把绝对路径带进对外结构。
      runDirRef: "opencode:run-dir",
      versions: {
        // adapter 版本是构建常量，不是本次观测。
        adapter: { support: "supported", verifiedAt: null, evidenceRef: null, version: "oc03-1" },
        backendServer: {
          ...(version === null ? unknown("health 未返回版本") : observed),
          version,
        },
        // schema 标识来自安装版本的 /doc，不是本次调用观测；保留来源引用。
        apiSchema: {
          support: "supported",
          verifiedAt: null,
          evidenceRef: null,
          version: "1.0.0",
          sourceRef: "docs/COMPATIBILITY.md#opencode",
        },
      },
      methods: {
        // 只有健康检查是本次真正调用过的。
        health: observed,
        createSession: declared("实现存在；probe 不创建会话，未验证"),
        loadSession: declared("实现存在；probe 不读取会话，未验证"),
        execute: declared("实现存在；probe 不发起 turn，未验证"),
        stop: declared("实现存在；probe 不发起 abort，停止确认需运行期证据"),
        close: declared("实现存在；close 会验证进程树退出，未确认时抛 STOP_UNCONFIRMED"),
        events: declared("实现存在；probe 不建立 SSE，未验证"),
        resolvePermission: declared("只转发 once/reject；probe 不处理权限请求，未验证"),
      },
      reviewWriteBlocked: unknown("策略来自受控配置（edit=deny），但没有 OS 级只读证据"),
      writeSandbox: unknown("未验证操作系统级写入隔离"),
      controlChannelIsolation: unknown("未实现 operator 通道，未验证控制通道隔离"),
      usageSource: "backend",
      hardBudget: { support: "unsupported", verifiedAt: null, evidenceRef: null, limitation: "供应商不提供硬 token 预算" },
      internalRetry: declared("写请求单次发送，不做自动重试；只有启动就绪与消息快照是轮询读"),
      sessionResume: unknown("未在本项验证重启后同一 backendSessionId 续接"),
      probedAt,
    };
    return capabilities;
  }

  // ------------------------------------------------------------------ 会话

  private assertSessionSpec(spec: SessionSpec): ModelSelection {
    // 先校验 spec 的模型在允许列表内：配置错误必须在启动 worker 之前就拒绝。
    if (!this.gate.allows(modelRef(spec.model))) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "SessionSpec 的模型不在受控允许列表内", {
        details: { requested: modelRef(spec.model), allowed: [...this.gate.allowed] },
      });
    }
    if (spec.workspaceRoot !== this.options.workspaceRoot) {
      throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", "SessionSpec 的工作区与 adapter 的受控工作区不一致");
    }
    if (spec.runDir !== this.options.runDir) {
      throw new ZBridgeError("INVALID_ARGUMENT", "SessionSpec 的运行目录与 adapter 的独占目录不一致");
    }
    if (spec.policyProfile !== this.options.policyProfile) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "SessionSpec 的策略 profile 与 adapter 不一致", {
        details: { requested: spec.policyProfile, actual: this.options.policyProfile },
      });
    }
    return spec.model;
  }

  async createSession(spec: SessionSpec): Promise<BackendSessionRef> {
    const model = this.assertSessionSpec(spec);
    await this.ensureStarted();
    const api = this.requireApi();
    const created = await api.createSession({
      title: `OpenCode Bridge ${this.options.policyProfile}`,
      permission: permissionRules(this.options.policyProfile),
      providerID: model.providerID,
      modelID: model.modelID,
    });
    if (!created.ok) {
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "创建后端会话失败", {
        details: { reason: created.message, status: created.status },
      });
    }
    if (!created.sessionId.startsWith("ses")) {
      throw new ZBridgeError("BACKEND_PROTOCOL_MISMATCH", "后端会话 ID 形状不符合 OpenCode 约定");
    }
    const epoch = this.serverEpoch;
    if (epoch === null) {
      throw new ZBridgeError("EPOCH_MISMATCH", "缺少 serverEpoch：会话必须绑定到具体 worker 代际");
    }
    return {
      backendSessionId: created.sessionId,
      serverEpoch: epoch,
      backendVersion: this.options.pinnedVersion ?? OPENCODE_PINNED_VERSION,
    };
  }

  async loadSession(ref: BackendSessionRef): Promise<BackendSessionRef> {
    this.assertEpoch(ref.serverEpoch);
    await this.ensureStarted();
    const api = this.requireApi();
    const loaded = await api.getSession(ref.backendSessionId);
    if (!loaded.ok) {
      throw new ZBridgeError(loaded.status === 404 ? "NOT_FOUND" : "BACKEND_UNAVAILABLE", "读取后端会话失败", {
        details: { reason: loaded.message, status: loaded.status },
      });
    }
    return { ...ref, backendVersion: ref.backendVersion ?? (this.options.pinnedVersion ?? OPENCODE_PINNED_VERSION) };
  }

  // ------------------------------------------------------------------ 执行

  async execute(spec: TurnSpec, sink: BackendEventSink): Promise<TurnOutcome> {
    return (await this.executeTurn(spec, sink)).outcome;
  }

  async executeTurn(spec: TurnSpec, sink: BackendEventSink): Promise<OpenCodeTurnResult> {
    if (this.active !== null) {
      throw new ZBridgeError("SESSION_BUSY", "已有进行中的 run；本项串行执行");
    }
    if (spec.prompt.trim().length === 0) throw new ZBridgeError("INVALID_ARGUMENT", "prompt 不能为空");
    const deadlineMs = Date.parse(spec.deadlineAt);
    if (!Number.isFinite(deadlineMs)) throw new ZBridgeError("INVALID_ARGUMENT", "deadlineAt 不是合法时间");
    // 已经过期就不再启动 worker、不再发任何 HTTP：这是「发送前拒绝」而不是「结果不明」。
    if (deadlineMs <= this.now()) {
      throw new ZBridgeError("REQUEST_EXPIRED", "任务期限在发送前已经到达，未提交后端", {
        details: { phase: "pre_send" },
      });
    }
    const model = requireOpencodeSelection(spec.model);
    if (!this.gate.allows(modelRef(model))) {
      // 允许列表在受理后收缩：确定没有发出任何 HTTP，按发送前失败收敛（不能变 unknown 阻塞会话）。
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "本次 run 选定的模型不在受控允许列表内", {
        details: { requested: modelRef(model), allowed: [...this.gate.allowed], phase: "pre_send" },
      });
    }
    this.assertModelAvailable(model);
    this.assertEpoch(spec.session.serverEpoch);
    await this.ensureStarted();
    const api = this.requireApi();
    const sessionId = spec.session.backendSessionId;

    const startedAtMs = this.now();
    const userMessageId = newUserMessageId(startedAtMs, randomBytes(8).toString("hex"));
    // 发送前先把 messageID 交给调用方持久化；失败就不发送。
    try {
      await spec.onDispatch?.onMessageId?.(userMessageId);
    } catch (error) {
      throw preSendFailure("无法在发送前持久化消息 ID", error);
    }
    const active: ActiveTurn = {
      runId: spec.runId,
      userMessageId,
      attemptId: spec.attemptId ?? "att_unassigned",
      sessionId,
      requestedModel: model,
      stopping: false,
      stopIntent: null,
      stopRequestedAtMs: null,
      assistantIds: new Set<string>(),
    };
    this.active = active;

    const tracker = new TextTracker(() => this.now());
    const warnings: string[] = [];
    const stream = new TurnEventStream({
      api,
      sessionId,
      tracker,
      now: () => this.now(),
      ownsMessage: (messageId) => active.assistantIds.has(messageId),
    });

    let requestOutcome: RequestOutcome = "unknown";
    let httpStatus: number | null = null;
    let deadlineExpired = false;
    let assessmentStop: TurnStopCause = null;
    let mapped: BackendTurnResult = mapOpencodeTurn({
      finish: null,
      stopping: false,
      messageConfirmed: false,
    });
    let attribution: Attribution = { user: null, assistants: [], confirmed: false, conflict: false };
    let progressEvents = 0;
    let lastEmittedTools = new Map<string, string>();
    let sessionStatus: SessionStatusKind = "absent";
    const approval = new ApprovalCoordinator();
    const deniedCallIds = new Set<string>();
    let deniedAtMs: number | null = null;

    const emitProgress = (text: string): void => {
      if (text.length === 0) return;
      const bounded = text.length > 4096 ? `${text.slice(0, 4096)}…[truncated]` : text;
      progressEvents += 1;
      sink.emit({ type: "progress", text: bounded });
    };

    const reconcile = (attributed: Attribution): void => {
      for (const message of attributed.assistants) {
        active.assistantIds.add(message.id);
        for (const part of message.parts) {
          tracker.notePartType(part.id, message.id, part.type);
          if (part.type === "text" && part.text !== null) {
            tracker.upsertFromSnapshot(part.id, message.id, "text", part.text);
          }
        }
      }
      emitProgress(tracker.takePending((messageId) => active.assistantIds.has(messageId)));
    };

    const emitTools = (observations: readonly ToolObservation[]): void => {
      const next = new Map<string, string>();
      for (const item of observations) {
        const phase: "requested" | "started" | "completed" | "failed" =
          item.state === "pending"
            ? "requested"
            : item.state === "running"
              ? "started"
              : item.state === "completed"
                ? "completed"
                : "failed";
        next.set(item.callId, phase);
        const previous = lastEmittedTools.get(item.callId);
        if (previous === phase) continue;
        sink.emit({
          type: "tool",
          tool: { toolCallId: item.callId, toolName: item.toolName, phase, summary: `${item.toolName}:${item.state}` },
        });
      }
      lastEmittedTools = next;
    };

    // SSE 建连也吃预算：连接超时不能超过剩余时间，已无剩余就干脆不连。
    const remainingBeforeSse = deadlineMs - this.now();
    const sseStarted =
      remainingBeforeSse <= 0
        ? false
        : await stream.start(Math.min(this.options.startupTimeoutMs ?? 30_000, remainingBeforeSse));
    if (!sseStarted) {
      warnings.push(`SSE 未建立：${stream.stats.error ?? "unknown"}；仅使用消息快照观察`);
      sink.emit({ type: "warning", code: "SSE_UNAVAILABLE", message: "SSE 未建立，改用消息快照" });
    }

    // 真正的发送边界前再核对一次期限：启动 worker、建 SSE、写 dispatch 证据都可能耗时。
    if (this.now() >= deadlineMs) {
      stream.abort();
      await stream.waitClosed();
      this.active = null;
      throw new ZBridgeError("REQUEST_EXPIRED", "准备阶段已耗尽期限，未提交后端", {
        details: { phase: "pre_send" },
      });
    }

    try {
      const prompt = await api.promptAsync(sessionId, {
        messageID: userMessageId,
        providerID: model.providerID,
        modelID: model.modelID,
        text: spec.prompt,
      });
      httpStatus = prompt.ok ? prompt.status : prompt.status;
      if (prompt.ok) {
        requestOutcome = "accepted";
        try {
          await spec.onDispatch?.onAccepted?.(userMessageId);
        } catch (error) {
          // 已经发出去了，但调用方无法持久化「已发送」：不能报成功，也不能继续。
          await this.abortAndReclaim(sessionId, "dispatch accepted but persistence failed");
          throw postSendFailure("受理后无法持久化发送证据", error);
        }
      } else if (prompt.kind === "rejected") {
        requestOutcome = "rejected";
        try {
          await spec.onDispatch?.onRejected?.();
        } catch {
          // 未派发的证据写入失败：不影响「没有发送」这个事实，继续按拒绝处理。
        }
      } else {
        requestOutcome = "unknown";
      }

      const confirmDeadline = Math.min(deadlineMs, this.now() + (this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS));
      let snapshotOk = false;
      for (;;) {
        const messages = await api.messages(sessionId);
        if (messages.ok) {
          snapshotOk = true;
          attribution = attributeRun(messages.value.messages, { sessionId, userMessageId });
          if (attribution.confirmed) break;
        }
        if (!attribution.confirmed && this.now() >= confirmDeadline) break;
        if (this.worker?.hasExited === true) break;
        await this.sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }

      if (!attribution.confirmed) {
        assessmentStop = this.worker?.hasExited === true ? "worker_exit" : null;
        mapped = mapOpencodeTurn({
          finish: null,
          stopping: false,
          messageConfirmed: false,
          observationEnded: true,
        });
        if (requestOutcome !== "rejected" && assessmentStop === null) {
          // 已提交但历史里查不到：不能留着任务无限跑，明确有界回收。
          await this.abortAndReclaim(sessionId, "message not confirmable in history");
        }
        return this.buildResult({
          active,
          mapped,
          requestOutcome,
          httpStatus,
          messageConfirmed: false,
          stopCause: requestOutcome === "rejected" ? null : assessmentStop,
          stopIntent: null,
          deadlineExpired: false,
          attribution,
          tracker,
          stream,
          warnings,
          progressEvents,
          sessionStatus,
          firstTextMs: tracker.firstTextMs,
          startedAtMs,
          errorOverride:
            requestOutcome === "rejected"
              ? { code: "BACKEND_UNAVAILABLE", message: "后端拒绝了任务提交，未派发" }
              : { code: "BACKEND_UNAVAILABLE", message: "提交后无法在历史中确认本 run 的消息" },
          snapshotOk,
          ...(requestOutcome === "rejected" ? { forcedKind: "failed" as const } : {}),
        });
      }

      // 历史确认之后再回写一次：这是「消息真的存在」而不是「HTTP 说受理了」。
      try {
        await spec.onDispatch?.onConfirmed?.(userMessageId);
      } catch (error) {
        await this.abortAndReclaim(sessionId, "confirmed message but persistence failed");
        throw postSendFailure("确认消息后无法持久化", error);
      }

      // ---- 主观察循环
      const pollInterval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const permissionPoll = this.options.permissionPollMs ?? DEFAULT_PERMISSION_POLL_MS;
      let lastPermissionAt = 0;
      let lastOwnedPollAt = 0;
      let terminalStreak = 0;
      let observationEnded = false;
      let abortSent = false;

      const sendAbort = async (): Promise<void> => {
        if (abortSent) return;
        abortSent = true;
        const result = await api.abort(sessionId);
        if (!result.ok) {
          warnings.push(`abort 未被确认：${result.message}`);
          sink.emit({ type: "warning", code: "STOP_UNCONFIRMED", message: "abort 请求未得到确认" });
        }
      };

      for (;;) {
        const nowMs = this.now();
        const remaining = deadlineMs - nowMs;

        const messages = await api.messages(sessionId);
        if (messages.ok) {
          attribution = attributeRun(messages.value.messages, { sessionId, userMessageId });
          reconcile(attribution);
          if (attribution.conflict) {
            await this.abortAndReclaim(sessionId, "message attribution conflict");
            assessmentStop = null;
            mapped = mapOpencodeTurn({
              finish: null,
              stopping: false,
              messageConfirmed: false,
              observationEnded: true,
            });
            return this.buildResult({
              active,
              mapped,
              requestOutcome,
              httpStatus,
              messageConfirmed: false,
              stopCause: null,
              stopIntent: null,
              deadlineExpired: false,
              attribution,
              tracker,
              stream,
              warnings,
              progressEvents,
              sessionStatus,
              firstTextMs: tracker.firstTextMs,
              startedAtMs,
              errorOverride: { code: "BACKEND_PROTOCOL_MISMATCH", message: "消息归属冲突：同一 messageID 的角色或会话不符" },
              snapshotOk: true,
              forcedKind: "failed",
            });
          }
        } else {
          warnings.push(`消息快照读取失败：${messages.message}`);
        }

        const tools = collectTools(attribution.assistants);
        emitTools(tools.observations);
        // 执行期间持续记录「属于自己的后代」。不能只在工具 in-flight 时记，
        // 也不能依赖调用方事后调用 ownedProcessIds()；否则父进程一死就失去归属证据。
        const ownedPollMs = Math.max(pollInterval, 100);
        if (tools.pending || nowMs - lastOwnedPollAt >= ownedPollMs) {
          lastOwnedPollAt = nowMs;
          this.worker?.owned();
        }
        const fields = lastAssistantFields(attribution.assistants);
        // 身份必须覆盖本 run 的**全部**关联消息：只查末条会漏掉早先的异供应商消息。
        // 期望值绑定本轮 prompt 选定的模型；历史轮次的模型选择不参与本校验。
        const violation = this.identityViolation(attribution, active.requestedModel);
        if (violation !== null) {
          // 供应商/模型不匹配：立即停止本 worker，不再继续任何真实调用。
          await this.abortAndReclaim(sessionId, "provider/model identity mismatch");
          assessmentStop = null;
          mapped = mapOpencodeTurn({ finish: fields.finish, errorName: fields.errorName, stopping: false, messageConfirmed: true, messageCompleted: fields.messageCompleted, toolsPending: tools.pending, observationEnded: true });
          return this.buildResult({
            active, mapped, requestOutcome, httpStatus, messageConfirmed: true,
            stopCause: null, stopIntent: null, deadlineExpired: false, attribution, tracker, stream,
            warnings, progressEvents, sessionStatus, firstTextMs: tracker.firstTextMs, startedAtMs,
            errorOverride: { code: "BACKEND_PROTOCOL_MISMATCH", message: "后端响应的供应商/模型与本次 run 选定的不一致" },
            snapshotOk: true,
            forcedKind: "failed",
          });
        }

        // 真实 1.18.32 在拒绝后可能只保留 tool-calls + tool.error，不再生成最终正文。
        // 这是已确认的操作拒绝，不能当取消，也不应一直等到整轮超时。
        // 给正常的后续回答一个收尾窗口；只有本 run 被拒绝的工具明确结束才收敛。
        if (
          deniedAtMs !== null && this.now() - deniedAtMs >= 1_000 &&
          fields.messageCompleted && fields.finish === "tool-calls" && !tools.pending &&
          tools.observations.some((tool) => deniedCallIds.has(tool.callId) && tool.state === "error")
        ) {
          const reclaim = await this.abortAndReclaim(sessionId, "operator rejected tool without final assistant");
          mapped = {
            result: "refused", terminal: true, kind: "failed", stopReason: "refusal",
            rawFinish: fields.finish, errorName: fields.errorName,
          };
          return this.buildResult({
            active, mapped, requestOutcome, httpStatus, messageConfirmed: attribution.confirmed,
            stopCause: null, stopIntent: null, deadlineExpired: false, attribution, tracker, stream,
            warnings, progressEvents, sessionStatus, firstTextMs: tracker.firstTextMs, startedAtMs,
            errorOverride: reclaim.workerExited
              ? { code: "APPROVAL_DENIED", message: "操作已被拒绝，本轮已停止" }
              : { code: "STOP_UNCONFIRMED", message: "操作已被拒绝，但无法确认后端完全停止" },
            snapshotOk: true, forcedKind: reclaim.workerExited ? "failed" : "unknown",
          });
        }

        // 事实问题：本项不支持回答，明确失败并停止。
        if (stream.hasQuestion) {
          sink.emit({
            type: "input_requested",
            schema: { kind: "text", question: "后端要求补充信息（本项不支持自动回答）", options: [] },
          });
          const answer = await sink.requestInput({
            kind: "text",
            question: "后端要求补充信息（本项不支持自动回答）",
            options: [],
          });
          await this.abortAndReclaim(sessionId, "input required but unsupported");
          assessmentStop = "input_unsupported";
          mapped = mapOpencodeTurn({ finish: fields.finish, errorName: fields.errorName, stopping: false, messageConfirmed: true, messageCompleted: fields.messageCompleted, toolsPending: tools.pending, observationEnded: true });
          return this.buildResult({
            active, mapped, requestOutcome, httpStatus, messageConfirmed: true,
            stopCause: assessmentStop, stopIntent: null, deadlineExpired: false, attribution, tracker, stream,
            warnings, progressEvents, sessionStatus, firstTextMs: tracker.firstTextMs, startedAtMs,
            errorOverride: answer === "unsupported" || answer === null
              ? { code: "INPUT_REQUIRED_UNSUPPORTED", message: "后端要求事实输入，本项不支持自动回答" }
              : { code: "INPUT_REQUIRED_UNSUPPORTED", message: "事实输入通道未开放" },
            snapshotOk: true,
          });
        }

        // 审批：只在有提示或到达轮询间隔时查询，避免无界请求。
        const hint = stream.consumePermissionHint();
        if (hint || nowMs - lastPermissionAt >= permissionPoll) {
          lastPermissionAt = nowMs;
          const permissions = await api.permissions();
          if (permissions.ok) {
            const context: ApprovalContext = {
              runId: spec.runId,
              attemptId: active.attemptId,
              serverEpoch: spec.session.serverEpoch,
              sessionId,
              deadlineMs,
              approvalTimeoutMs: this.options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
              ownsMessage: (messageId) => active.assistantIds.has(messageId),
            };
            const processed = await approval.process(permissions.value.requests, context, api, sink, this.now);
            if (processed.kind === "denied" || processed.kind === "repeat_denied") {
              const denied = permissions.value.requests.find((request) => request.id === processed.requestId);
              if (denied?.toolCallId !== null && denied?.toolCallId !== undefined) {
                deniedCallIds.add(denied.toolCallId);
                deniedAtMs ??= this.now();
              }
            }
            if (processed.kind === "timeout") {
              await this.abortAndReclaim(sessionId, "approval timed out");
              assessmentStop = "approval_timeout";
              mapped = mapOpencodeTurn({
                finish: fields.finish,
                errorName: fields.errorName,
                stopping: false,
                messageConfirmed: true,
                messageCompleted: fields.messageCompleted,
                toolsPending: tools.pending,
                observationEnded: true,
              });
              return this.buildResult({
                active, mapped, requestOutcome, httpStatus, messageConfirmed: true,
                stopCause: assessmentStop, stopIntent: null, deadlineExpired: false, attribution, tracker, stream,
                warnings, progressEvents, sessionStatus, firstTextMs: tracker.firstTextMs, startedAtMs,
                errorOverride: { code: "APPROVAL_EXPIRED", message: "审批在期限内没有决策" },
                snapshotOk: true,
              });
            }
            if (processed.kind === "channel_lost") {
              await this.abortAndReclaim(sessionId, "approval channel lost");
              assessmentStop = "channel_lost";
              mapped = mapOpencodeTurn({
                finish: fields.finish,
                errorName: fields.errorName,
                stopping: false,
                messageConfirmed: true,
                messageCompleted: fields.messageCompleted,
                toolsPending: tools.pending,
                observationEnded: true,
              });
              return this.buildResult({
                active, mapped, requestOutcome, httpStatus, messageConfirmed: true,
                stopCause: assessmentStop, stopIntent: null, deadlineExpired: false, attribution, tracker, stream,
                warnings, progressEvents, sessionStatus, firstTextMs: tracker.firstTextMs, startedAtMs,
                errorOverride: { code: "APPROVAL_CHANNEL_LOST", message: "本地审批通道丢失，无法确认决策" },
                snapshotOk: true,
              });
            }
            if (processed.kind === "reply_failed") {
              warnings.push(`审批回复失败：${processed.detail}`);
            }
          } else {
            warnings.push(`待批列表读取失败：${permissions.message}`);
          }
        }

        sessionStatus = stream.sessionStatus;

        if (active.stopping && active.stopRequestedAtMs !== null) {
          const settleMs = this.options.stopSettleMs ?? DEFAULT_STOP_SETTLE_MS;
          if (nowMs - active.stopRequestedAtMs >= settleMs) observationEnded = true;
        }

        if (!observationEnded && remaining <= 0) {
          deadlineExpired = true;
          await sendAbort();
          // 期限后再给一小段有界收敛窗口，仍不足以判定时按 unknown。
          const settle = Math.min(2_000, Math.max(pollInterval * 4, 200));
          const settleDeadline = this.now() + settle;
          while (this.now() < settleDeadline) {
            const late = await api.messages(sessionId);
            if (late.ok) {
              attribution = attributeRun(late.value.messages, { sessionId, userMessageId });
              reconcile(attribution);
              const lateTools = collectTools(attribution.assistants);
              const lateFields = lastAssistantFields(attribution.assistants);
              const probe = mapOpencodeTurn({
                finish: lateFields.finish,
                errorName: lateFields.errorName,
                stopping: active.stopping,
                messageConfirmed: attribution.confirmed,
                messageCompleted: lateFields.messageCompleted,
                toolsPending: lateTools.pending,
              });
              if (probe.terminal) {
                mapped = probe;
                break;
              }
            }
            await this.sleep(pollInterval);
          }
          observationEnded = true;
          if (!mapped.terminal) {
            // 观察窗口结束仍没有终态：任务可能还在跑。不能只把本地状态标成 unknown
            // 就留着后端继续执行 —— 有界回收本 worker，并如实记录是否确认退出。
            const reclaim = await this.abortAndReclaim(sessionId, "deadline reached without terminal evidence");
            if (!reclaim.workerExited) {
              warnings.push(`期限到达后无法确认后端停止：${reclaim.detail}`);
            }
          }
        }

        if (this.worker?.hasExited === true && !observationEnded) {
          // 服务先死：工具后代可能仍在跑。这里必须**主动有界回收自己的遗留后代**，
          // 而不是等调用方事后 close；否则「写 A 后只杀服务」会继续写出 B。
          warnings.push("worker 进程已退出；开始有界回收本 worker 的遗留后代");
          sink.emit({ type: "warning", code: "WORKER_EXITED", message: "OpenCode worker 已退出" });
          assessmentStop = assessmentStop ?? "worker_exit";
          const reclaim = await this.abortAndReclaim(sessionId, "worker exited during run");
          warnings.push(`worker 退出后的回收结果：exited=${String(reclaim.workerExited)} ${reclaim.detail}`);
          observationEnded = true;
        }

        const candidate = mapOpencodeTurn({
          finish: fields.finish,
          errorName: fields.errorName,
          stopping: active.stopping,
          messageConfirmed: attribution.confirmed,
          messageCompleted: fields.messageCompleted,
          toolsPending: tools.pending,
          observationEnded,
        });

        if (candidate.terminal && !observationEnded) {
          terminalStreak += 1;
          // 连续两次相同的终态快照才接受，避免与紧随其后的消息竞争。
          if (terminalStreak >= 2) {
            mapped = candidate;
            break;
          }
        } else {
          terminalStreak = 0;
          mapped = candidate;
        }
        if (observationEnded) {
          mapped = candidate;
          break;
        }
        await this.sleep(pollInterval);
      }

      // 收尾快照：以历史为准，不用 SSE 累积值覆盖。
      const finalMessages = await api.messages(sessionId);
      if (finalMessages.ok) {
        attribution = attributeRun(finalMessages.value.messages, { sessionId, userMessageId });
        reconcile(attribution);
      }
      const finalTools = collectTools(attribution.assistants);
      const finalFields = lastAssistantFields(attribution.assistants);
      const finalMapped = mapOpencodeTurn({
        finish: finalFields.finish,
        errorName: finalFields.errorName,
        stopping: active.stopping,
        messageConfirmed: attribution.confirmed,
        messageCompleted: finalFields.messageCompleted,
        toolsPending: finalTools.pending,
        observationEnded: true,
      });
      // 已确定的终态不被「更晚但没有更多证据」的快照改写。
      if (finalMapped.terminal || !mapped.terminal) mapped = finalMapped;

      return this.buildResult({
        active,
        mapped,
        requestOutcome,
        httpStatus,
        messageConfirmed: attribution.confirmed,
        stopCause: deadlineExpired ? "deadline" : assessmentStop ?? (active.stopping ? "stop_intent" : null),
        stopIntent: active.stopIntent,
        deadlineExpired,
        attribution,
        tracker,
        stream,
        warnings,
        progressEvents,
        sessionStatus,
        firstTextMs: tracker.firstTextMs,
        startedAtMs,
        errorOverride: null,
        snapshotOk: true,
      });
    } finally {
      stream.abort();
      await stream.waitClosed();
      this.active = null;
    }
  }

  private buildResult(input: {
    readonly active: ActiveTurn;
    readonly mapped: BackendTurnResult;
    readonly requestOutcome: RequestOutcome;
    readonly httpStatus: number | null;
    readonly messageConfirmed: boolean;
    readonly stopCause: TurnStopCause;
    readonly stopIntent: "interrupt" | "cancel" | "close" | null;
    readonly deadlineExpired: boolean;
    readonly attribution: Attribution;
    readonly tracker: TextTracker;
    readonly stream: TurnEventStream;
    readonly warnings: readonly string[];
    readonly progressEvents: number;
    readonly sessionStatus: SessionStatusKind;
    readonly firstTextMs: number | null;
    readonly startedAtMs: number;
    readonly errorOverride: { code: string; message: string } | null;
    readonly snapshotOk: boolean;
    /** 明确的本产品判定（协议违规等），优先于纯映射结果。 */
    readonly forcedKind?: TerminalRunState;
  }): OpenCodeTurnResult {
    const mapped = input.mapped;
    const tools = collectTools(input.attribution.assistants);
    const fields = lastAssistantFields(input.attribution.assistants);
    const endedAtMs = this.now();

    let kind: TerminalRunState;
    let stopReason = mapped.stopReason;
    let error: { code: string; message: string } | null = input.errorOverride;

    switch (input.stopCause) {
      case "deadline":
        kind = mapped.terminal ? terminalStateForStop("deadline", mapped.stopReason) : "unknown";
        error = error ?? { code: "STOP_UNCONFIRMED", message: "期限到达后仍无法确认终态" };
        break;
      case "approval_timeout":
        // 产品期限到达：即使工具还挂着，这次 run 也已经按期限收敛；
        // 随后会回收本 worker，所以不会是「留着任务继续跑」。
        kind = "timed_out";
        error = error ?? { code: "APPROVAL_EXPIRED", message: "审批在期限内没有决策" };
        break;
      case "channel_lost":
        kind = "unknown";
        break;
      case "input_unsupported":
        kind = "failed";
        break;
      case "stop_intent":
        kind = mapped.terminal
          ? terminalStateForStop(input.stopIntent ?? "cancel", mapped.stopReason)
          : "unknown";
        if (kind === "unknown" && error === null) {
          error = { code: "STOP_UNCONFIRMED", message: "已请求停止，但没有足够的停止证据" };
        }
        break;
      case "worker_exit":
        kind = mapped.terminal ? mapped.kind ?? "unknown" : "unknown";
        if (kind === "unknown" && error === null) {
          error = { code: "BACKEND_UNAVAILABLE", message: "worker 退出且没有终态证据" };
        }
        break;
      case null:
        kind = mapped.terminal ? mapped.kind ?? "unknown" : "unknown";
        if (kind === "unknown" && error === null) {
          error = { code: "BACKEND_UNAVAILABLE", message: "观察结束仍没有完成证据" };
        }
        break;
    }

    if (input.forcedKind !== undefined) kind = input.forcedKind;

    if (kind === "cancelled" && stopReason === null) stopReason = "aborted";
    if (kind === "timed_out" || kind === "unknown") {
      // 停止类终态不能写成 turn_complete。
      if (stopReason === "turn_complete") stopReason = "aborted";
    }

    // 正文一律以快照累积值为准（SSE 只负责实时上报），且只取本 run assistant 的 text part。
    const text = input.tracker.assembled((messageId) => input.active.assistantIds.has(messageId));
    const usage = this.usageFor(input.attribution.assistants);

    const outcome: TurnOutcome = {
      kind,
      stopReason,
      serverEpoch: this.serverEpoch ?? 0,
      terminalObservedAfterStop: input.stopIntent !== null && mapped.terminal,
      agentReported: text.length > 0 ? text : null,
      usage,
      error,
      startedAt: new Date(input.startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
    };

    return {
      outcome,
      dispatch: {
        requestOutcome: input.requestOutcome,
        httpStatus: input.httpStatus,
        messageConfirmed: input.messageConfirmed,
        backendMessageId: input.active.userMessageId,
      },
      stopCause: input.stopCause,
      stopIntent: input.stopIntent,
      mapped,
      observations: {
        assistantMessages: input.attribution.assistants.length,
        toolCalls: tools.observations,
        progressEvents: input.progressEvents,
        firstTextMs: input.firstTextMs,
        sessionStatus: input.sessionStatus,
        requestedProviderID: input.active.requestedModel.providerID,
        requestedModelID: input.active.requestedModel.modelID,
        reportedProviderID: fields.providerId,
        reportedModelID: fields.modelId,
        sse: input.stream.stats,
        warnings: boundedWarnings([
          ...input.warnings,
          ...(input.stream.stats.error === null ? [] : [`SSE: ${input.stream.stats.error}`]),
          ...(input.stream.stats.closed && !input.stream.stats.intentional
            ? ["SSE 提前结束：改为只依赖消息快照，SSE 结束本身不代表任务完成"]
            : []),
          ...this.warnings,
        ]),
      },
    };
  }

  private usageFor(assistants: readonly OpencodeMessage[]): TurnUsage {
    let input: number | null = null;
    let output: number | null = null;
    for (const message of assistants) {
      if (message.inputTokens !== null) input = (input ?? 0) + message.inputTokens;
      if (message.outputTokens !== null) output = (output ?? 0) + message.outputTokens;
    }
    if (input === null && output === null) return { source: "unavailable", inputTokens: null, outputTokens: null };
    return { source: "backend", inputTokens: input, outputTokens: output };
  }

  // ------------------------------------------------------------------ 停止与回收

  /**
   * 有界停止：
   * 1. 先校验 run + session + serverEpoch 都指向**当前**这次执行（错配直接拒绝，不发信号）；
   * 2. 保存停止意图并发 abort；
   * 3. 在宽限期内核对本 run 的消息终态、工具结束、无待批**且没有存活的 worker 后代**
   *    —— 只有这些证据同时成立才叫 protocol confirmed；
   * 4. 否则回收**本 worker 独占**的进程组与后代并验证退出（process_tree）；
   * 5. 进程层也没有证据时返回 confirmed=false、method=none —— 不宣称已停止。
   */
  async stop(spec: StopSpec): Promise<StopOutcome> {
    const active = this.active;
    if (active === null) {
      return {
        confirmed: false,
        method: "none",
        settledAt: null,
        detail: "没有进行中的执行，无法提供停止证据",
      };
    }
    // 关联校验必须在任何 HTTP／信号动作之前。
    if (active.runId !== spec.runId) {
      return {
        confirmed: false,
        method: "none",
        settledAt: null,
        detail: "runId 与当前执行不匹配，拒绝停止",
      };
    }
    if (active.sessionId !== spec.session.backendSessionId) {
      return {
        confirmed: false,
        method: "none",
        settledAt: null,
        detail: "backendSessionId 与当前执行不匹配，拒绝停止",
      };
    }
    if (this.serverEpoch === null || this.serverEpoch !== spec.session.serverEpoch) {
      return {
        confirmed: false,
        method: "none",
        settledAt: null,
        detail: "serverEpoch 与当前 worker 代际不匹配，拒绝停止",
      };
    }

    active.stopping = true;
    active.stopIntent = spec.intent;
    active.stopRequestedAtMs = active.stopRequestedAtMs ?? this.now();

    const api = this.requireApi();
    const abortResult = await api.abort(spec.session.backendSessionId);
    const protocolConfirmed = await this.waitForSettled(spec.session.backendSessionId, active, spec.graceMs);
    // 「消息完成 + 工具结束」只说明 part 收尾了，不能证明没有后台 shell 后代。
    // 进程表读不到（owned() === null）时同样不能确认：那不是「没有后代」。
    const owned = this.worker === null ? null : this.worker.owned();
    const quiescent = protocolConfirmed && owned !== null && owned.length === 0;
    if (quiescent) {
      return {
        confirmed: true,
        method: "protocol",
        settledAt: new Date(this.now()).toISOString(),
        detail: abortResult.ok
          ? "abort 已确认，本 run 消息完成、工具结束、无待批，且 worker 没有存活后代"
          : "abort 未被明确确认，但本 run 消息完成、工具结束、无待批，且 worker 没有存活后代",
      };
    }

    const worker = this.worker;
    if (worker === null) {
      return { confirmed: false, method: "none", settledAt: null, detail: "worker 不存在，无法确认停止" };
    }
    const report = await worker.stop("SIGTERM", spec.graceMs);
    if (report.exited) {
      return {
        confirmed: true,
        method: "process_tree",
        settledAt: new Date(this.now()).toISOString(),
        detail: protocolConfirmed
          ? `协议已收尾但仍有后代；已回收独占进程组并验证退出（${report.detail}）`
          : `协议未确认；已回收独占进程组并验证退出（${report.detail}）`,
      };
    }
    return {
      confirmed: false,
      method: "none",
      settledAt: null,
      detail: `协议与进程层都无法确认停止：${report.detail}`,
    };
  }

  /**
   * 核对停止是否已经收尾。
   *
   * 严格性要求：
   * - 待批查询失败**不能**当成「没有待批」；
   * - 消息读取失败不能当成「已经完成」；
   * - 工具状态未知（unconfirmed）也不算结束。
   */
  private async waitForSettled(
    sessionId: string,
    active: ActiveTurn,
    graceMs: number,
  ): Promise<boolean> {
    const api = this.requireApi();
    const deadline = this.now() + Math.max(0, graceMs);
    for (;;) {
      const messages = await api.messages(sessionId);
      const pending = await api.permissions();
      if (messages.ok && pending.ok) {
        const attribution = attributeRun(messages.value.messages, { sessionId, userMessageId: active.userMessageId });
        const tools = collectTools(attribution.assistants);
        const fields = lastAssistantFields(attribution.assistants);
        const pendingForSession = pending.value.requests.filter((request) => request.sessionId === sessionId);
        const settled =
          attribution.confirmed &&
          fields.messageCompleted &&
          !tools.pending &&
          !tools.unconfirmed &&
          fields.finish !== "tool-calls" &&
          pendingForSession.length === 0;
        if (settled) return true;
      }
      if (this.now() >= deadline) return false;
      await this.sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  }

  /**
   * 有界放弃：先 abort，再回收本 worker 的进程树，并如实报告是否确认退出。
   * 用于「确认不了结果」的早退路径，避免已提交任务在后台无限继续。
   */
  private async abortAndReclaim(
    sessionId: string,
    reason: string,
  ): Promise<{ abortSent: boolean; workerExited: boolean; detail: string }> {
    let abortSent = false;
    if (this.api !== null) {
      const abort = await this.api.abort(sessionId).catch(() => null);
      abortSent = abort !== null && abort.ok;
    }
    const worker = this.worker;
    if (worker === null) return { abortSent, workerExited: true, detail: `${reason}：没有 worker` };
    const report = await worker.stop("SIGTERM", this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    if (!report.exited) this.warn(`reclaim_unconfirmed: ${reason}`);
    return { abortSent, workerExited: report.exited, detail: report.detail };
  }

  /** 本轮所有关联消息（含用户消息）的供应商/模型必须与本次选定一致；返回第一个冲突。 */
  private identityViolation(
    attribution: Attribution,
    expected: ModelSelection,
  ): { readonly providerID: string | null; readonly modelID: string | null; readonly messageId: string } | null {
    const candidates = attribution.user === null ? attribution.assistants : [attribution.user, ...attribution.assistants];
    for (const message of candidates) {
      if (message.providerId === null && message.modelId === null) continue;
      try {
        assertResponseIdentity(message.providerId, message.modelId, message.role === "user" ? "user 消息" : "assistant 消息", expected);
      } catch {
        return { providerID: message.providerId, modelID: message.modelId, messageId: message.id };
      }
    }
    return null;
  }

  /** 关闭：必须先确认进程树已退出，否则抛 STOP_UNCONFIRMED。 */
  async close(): Promise<void> {
    if (this.active !== null) {
      throw new ZBridgeError("SESSION_BUSY", "有进行中的 run，不能直接 close");
    }
    this.closed = true;
    const worker = this.worker;
    if (worker === null) return;
    const report = await worker.stop("SIGTERM", this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    this.worker = null;
    this.api = null;
    if (!report.exited) {
      throw new ZBridgeError("STOP_UNCONFIRMED", "worker 进程树未确认退出", { details: { detail: report.detail } });
    }
    this.log(`worker closed: ${report.detail}`);
  }

  /** 供离线测试与证据读取：当前是否还有可用的 worker。 */
  get isWorkerAlive(): boolean {
    return this.worker !== null && !this.worker.hasExited;
  }

  /** 供证据记录：当前 worker 的后代 PID（只用于验证退出，不参与业务状态）。 */
  ownedProcessIds(): readonly number[] {
    const owned = this.worker?.owned() ?? null;
    return owned === null ? [] : owned.map((row) => row.pid);
  }

  /**
   * 进程表是否可读。没有 worker 时不能说「可读」：那会让调用方把
   * 「没有进程」误当成「确认没有后代」。
   */
  processTableReadable(): boolean {
    if (this.worker === null) return false;
    return this.worker.owned() !== null;
  }
}

/** 发送前的失败：确定没有写入后端，调用方可以记 not_sent。 */
function preSendFailure(message: string, cause: unknown): ZBridgeError {
  return new ZBridgeError("BACKEND_UNAVAILABLE", message, {
    details: { phase: "pre_send" },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** 发送后的失败：无法证明没有写入，调用方必须按 unknown 处理。 */
function postSendFailure(message: string, cause: unknown): ZBridgeError {
  return new ZBridgeError("BACKEND_UNAVAILABLE", message, {
    details: { phase: "post_send" },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** 警告去重、有界，避免坏后端把内存撑大。 */
function boundedWarnings(warnings: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const warning of warnings) {
    const key = warning.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning.length > 400 ? `${warning.slice(0, 400)}…` : warning);
    if (out.length >= 32) break;
  }
  return out;
}
