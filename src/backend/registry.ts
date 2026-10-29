/**
 * 固定后端注册与公共运行时接口（OC-09-02）。
 *
 * 原则（主规划 §3、§6.1）：
 * - 后端 ID 固定为 opencode/codebuddy/qoder，每种最多一个实例；不做任意插件框架；
 * - 本模块只声明 daemon／scheduler 需要的中立生命周期面，OpenCode 协议细节
 *   留在 src/backend/opencode/，SDK 专用映射留在各自目录；
 * - 工厂由 daemon 在启动时按已加载配置注册；运行期不可动态增删。
 */
import type { BackendAdapter, BackendEventSink, BackendModelSelection, ModelSelection, StopOutcome } from "../contracts/backend.ts";
import type { RunId } from "../contracts/ids.ts";
import type { BackendId } from "../contracts/version.ts";
import type { IsoTimestamp } from "../contracts/common.ts";
import { isTerminalRunState, type RunState } from "../contracts/run.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import { payloadHash } from "../contracts/json.ts";

/**
 * scheduler／daemon 需要的 worker 生命周期面。
 * OpenCode HTTP adapter 与 SDK worker adapter 都必须提供；缺省成员（如
 * 纯进程内 fake）由实现方给出明确的无进程语义（null/空数组/false）。
 */
export interface ManagedAdapter extends BackendAdapter {
  /** worker 进程是否仍存活；进程内实现返回自身存活语义。 */
  readonly isWorkerAlive: boolean;
  /** worker 主进程 PID；无独立进程为 null。 */
  readonly workerPid: number | null;
  /** 本运行时确认归属的进程 PID（含 CLI／工具后代）；回收前按身份核对。 */
  ownedProcessIds(): readonly number[];
  /**
   * OC-09：SDK 适配器在首轮后才知道后端原生会话 ID；daemon 据此把产品会话
   * 绑定从占位值更新为可 resume 的真实 ID。OpenCode 不需要（存储层直接绑定）。
   */
  readonly backendSessionId?: string | null;
  /** 本轮后端消息里实际观测到的 CLI 版本；未观测时为 null。 */
  readonly observedCliVersion?: string | null;
}

/** coordinator 的最小调度面：scheduler 只调用 run 与 stop。 */
export interface RunCoordinator {
  run(input: CoordinatorRunInput): Promise<unknown>;
  stop(input: CoordinatorStopInput): Promise<StopOutcome>;
}

export interface CoordinatorRunInput {
  readonly runId: RunId;
  readonly prompt: string;
  readonly deadlineAt: IsoTimestamp;
  /** 后端中立模型选择：OpenCode 为 provider/model 双段，其余为原生 ID。 */
  readonly model: BackendModelSelection;
}

export interface CoordinatorStopInput {
  readonly runId: RunId;
  readonly intent: "interrupt" | "cancel" | "close";
  readonly graceMs: number;
}

/**
 * SDK 后端的通用运行协调器（OC-09-05）：把 ManagedAdapter.execute 包装成
 * RunCoordinator.run。与 OpenCode 协调器共享存储事务语义：
 * - prepareDispatch（possibly_sent 边界）在调用 adapter.execute 前落库；
 * - adapter 的 onDispatch 钩子实时升级 sent/confirmed；
 * - TurnOutcome 落库终态（completed 才允许 completed；unknown 阻塞会话）；
 * - stop() 委托 adapter.stop 并把确认结果返回给 scheduler。
 */
export class SdkRunCoordinator implements RunCoordinator {
  private readonly adapter: ManagedAdapter;
  private readonly store: import("../storage/store.ts").BridgeStore;
  private readonly approvals: import("../daemon/approvals.ts").DaemonApprovalQueue | null;
  readonly policyVersion: string;
  private readonly onEvent: (message: string) => void;

  constructor(
    adapter: ManagedAdapter,
    store: import("../storage/store.ts").BridgeStore,
    approvals: import("../daemon/approvals.ts").DaemonApprovalQueue | null,
    policyVersion: string,
    onEvent?: (message: string) => void,
  ) {
    this.adapter = adapter;
    this.store = store;
    this.approvals = approvals;
    this.policyVersion = policyVersion;
    this.onEvent = onEvent ?? (() => undefined);
  }

  async run(input: CoordinatorRunInput): Promise<unknown> {
    const preRun = this.store.runs.require(input.runId);
    const preSession = this.store.sessions.require(preRun.sessionId);
    if (preSession.backendSessionId === null || preSession.serverEpoch === null) {
      // 与 OpenCode 路线一致：会话绑定在 prepareSession 完成后才允许派发。
      throw new ZBridgeError("BACKEND_UNAVAILABLE", "产品会话尚未绑定后端会话，拒绝派发");
    }
    const prepared = this.store.prepareDispatch({
      runId: input.runId,
      backendSessionId: preSession.backendSessionId,
      serverEpoch: preSession.serverEpoch,
    });
    const attemptId = prepared.intent.attemptId;
    void prepared.run;
    const session = preSession;
    const binding = session.backendSessionId;
    const sink = this.makeSink(input.runId, attemptId, session.serverEpoch ?? 0);
    const spec: import("../contracts/backend.ts").TurnSpec = {
      runId: input.runId,
      session: {
        backendSessionId: binding ?? `pending-${attemptId}`,
        serverEpoch: session.serverEpoch ?? 0,
        backendVersion: null,
      },
      prompt: input.prompt,
      model: input.model,
      deadlineAt: input.deadlineAt,
      attemptId,
    };
    this.store.transitionRun(input.runId, "running", { payload: { attemptId } });
    try {
      let outcome = await this.adapter.execute(spec, sink);
      // B06：完成不能覆盖本轮身份矛盾；观测到与选定不一致时只报协议错误。
      if (outcome.kind === "completed" && outcome.observedModel !== null && outcome.observedModel !== undefined && outcome.observedModel !== input.model.modelRef) {
        outcome = {
          ...outcome,
          kind: "failed",
          error: {
            code: "BACKEND_PROTOCOL_MISMATCH",
            message: `本轮观测模型 ${outcome.observedModel} 与选定模型 ${input.model.modelRef} 不一致`,
          },
        };
      }
      this.applyOutcome(input.runId, outcome);
      return outcome;
    } catch (error) {
      // 异常路径：保持 possibly_sent/unknown 语义（发送意图已存在 → unknown）。
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent(`sdk run failed: ${input.runId}: ${message}`);
      throw error;
    }
  }

  async stop(input: CoordinatorStopInput): Promise<import("../contracts/backend.ts").StopOutcome> {
    const run = this.store.runs.require(input.runId);
    if (isTerminalRunState(run.state)) {
      return { confirmed: false, method: "none", settledAt: null, detail: "run 已是终态，没有可停止的执行" };
    }
    // 先把停止意图落进状态机：待批中的 run 因此不再被 resumeIfWaiting 拉回 running。
    this.driveTo(input.runId, "stopping", { intent: input.intent });
    const session = this.store.sessions.require(run.sessionId);
    const outcome = await this.adapter.stop({
      runId: input.runId,
      session: {
        backendSessionId: session.backendSessionId ?? `pending-${input.runId}`,
        serverEpoch: session.serverEpoch ?? 0,
        backendVersion: null,
      },
      intent: input.intent,
      graceMs: input.graceMs,
    });
    if (outcome.confirmed) {
      this.driveTo(input.runId, input.intent === "interrupt" ? "interrupted" : "cancelled", {
        stopMethod: outcome.method,
      });
    } else {
      this.store.transitionRun(input.runId, "unknown", {
        payload: { reason: "STOP_UNCONFIRMED", stopMethod: outcome.method },
      });
    }
    return outcome;
  }

  private applyOutcome(runId: import("../contracts/ids.ts").RunId, outcome: import("../contracts/backend.ts").TurnOutcome): void {
    const at = new Date().toISOString();
    const current = this.store.runs.require(runId).state;
    // A05：停止路径已定终态（或正在收敛）时，晚到的后端终态只是观测，不是成功证据。
    if (isTerminalRunState(current)) return;
    if (current === "stopping") {
      this.store.appendRunEvent(runId, { type: "run.progress", payload: { lateTerminal: outcome.kind } });
      return;
    }
    // OC-09：只持久化本轮后端消息里实际观测到的模型；缺失保持 NULL，不用配置回声回填。
    if (outcome.observedModel !== undefined && outcome.observedModel !== null) {
      try {
        this.store.runs.setObservedModel(runId, outcome.observedModel, at);
      } catch (error) {
        this.onEvent(`sdk observed_model write failed: ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const kind = outcome.kind;
    if (kind === "completed") {
      // completed 必须有 draining 证据链；直接从 running 写结果会被存储层拒绝。
      this.driveTo(runId, "draining");
      try {
        this.store.completeRunWithResult(
          runId,
          {
            ...(outcome.agentReported !== null ? { agentReported: [{ text: outcome.agentReported }] } : {}),
            observed: [
              { text: `stopReason=${outcome.stopReason ?? "none"}` },
              { text: `usageSource=${outcome.usage.source}` },
              { text: `observedModel=${outcome.observedModel ?? "unavailable"}` },
            ],
          },
          { at },
        );
      } catch (error) {
        // 结果写入失败不能停在 draining 假装成功：收敛为 unknown 并阻塞会话。
        this.store.transitionRun(runId, "unknown", { payload: { reason: "result_write_failed" }, at });
        throw error;
      }
      return;
    }
    if (kind === "unknown") {
      this.store.transitionRun(runId, "unknown", {
        payload: { reason: outcome.error?.message ?? "sdk unknown terminal" },
      });
      return;
    }
    this.driveTo(runId, "draining");
    this.store.transitionRun(runId, "failed", {
      payload: {
        reason: outcome.error?.code ?? "backend_error",
        detail: (outcome.error?.message ?? "").slice(0, 300),
      },
    });
  }

  /**
   * 按状态机显式路径迁移；已经从路径中段开始时继续下一跳。
   * 终态不可改写，非法跳转不抛错（与 OpenCode 协调器一致；停止意图这条更严，
   * OpenCode 协调器仍会先绕 running，已登记为边界）。
   */
  private driveTo(
    runId: RunId,
    target: RunState,
    payload?: Record<string, string | number | boolean | null>,
  ): void {
    let run = this.store.runs.require(runId);
    if (run.state === target) return;
    if (isTerminalRunState(run.state)) return;
    // 状态机允许 waiting_* → stopping 直迁：停止意图不能先绕 running，
    // 否则事件流会在 run.stop_requested 之前多出一条假的「又跑起来了」。
    if (target === "stopping" && (run.state === "waiting_approval" || run.state === "waiting_input")) {
      this.store.transitionRun(runId, "stopping", payload ? { payload } : undefined);
      return;
    }
    // 等待审批/输入时先回到 running；starting 直接进入 running。
    if (run.state === "waiting_approval" || run.state === "waiting_input" || run.state === "starting") {
      const toRunning = this.store.transitionRun(runId, "running");
      if (!toRunning.accepted) return;
      run = toRunning.run;
      if (target === "running") return;
    }
    if (run.state === "running" && (target === "draining" || target === "failed")) {
      const toDraining = this.store.transitionRun(runId, "draining");
      if (!toDraining.accepted) return;
      run = toDraining.run;
    }
    if (run.state !== target) {
      this.store.transitionRun(runId, target, payload ? { payload } : undefined);
    }
  }

  private makeSink(runId: RunId, attemptId: string, serverEpoch: number): BackendEventSink {
    return {
      emit: (event) => {
        // 业务事件经 store 的追加通道（事件上限/字节限额在 store 内收敛）。
        if (event.type === "message") {
          this.store.appendRunEvent(runId, { type: "run.progress", payload: { text: event.text.slice(0, 1_000) } });
        } else if (event.type === "tool") {
          this.store.appendRunEvent(runId, {
            type: "run.tool",
            payload: { tool: event.tool.toolName, phase: event.tool.phase },
          });
        } else if (event.type === "input_requested") {
          this.driveTo(runId, "waiting_input");
        }
        void attemptId;
      },
      requestApproval: async (request) => {
        if (this.approvals === null) {
          return { decision: "channel_lost", actor: "channel_lost" } as const;
        }
        this.driveTo(runId, "waiting_approval");
        let approvalId: import("../contracts/ids.ts").ApprovalId;
        try {
          const approval = this.store.createApproval({
            runId,
            attemptId,
            serverEpoch,
            requestKind: request.requestKind,
            toolName: request.toolName,
            toolCallId: request.toolCallId,
            argumentsText: request.argumentsText,
            targetPaths: request.targetPaths,
            payloadHash: payloadHash({
              kind: request.requestKind,
              toolName: request.toolName,
              toolCallId: request.toolCallId,
              argumentsText: request.argumentsText,
              targetPaths: [...request.targetPaths],
              serverEpoch,
              attemptId,
            }),
            policyVersion: this.policyVersion,
            expiresAt: request.expiresAt,
            at: new Date().toISOString(),
          });
          approvalId = approval.approvalId;
        } catch (error) {
          this.onEvent(`sdk approval record failed: ${runId}: ${error instanceof ZBridgeError ? error.code : String(error)}`);
          this.resumeIfWaiting(runId);
          return { decision: "channel_lost", actor: "channel_lost" } as const;
        }
        try {
          this.approvals.approvalRecorded(this.store.approvals.require(approvalId), request);
        } catch (error) {
          this.onEvent(`sdk approval notify failed: ${runId}: ${error instanceof ZBridgeError ? error.code : String(error)}`);
        }
        let answer: import("../contracts/backend.ts").ApprovalAnswer;
        try {
          answer = await this.approvals.waitForDecision(request);
        } catch (error) {
          this.onEvent(`sdk approval wait failed: ${runId}: ${error instanceof ZBridgeError ? error.code : String(error)}`);
          answer = { decision: "channel_lost", actor: "channel_lost" };
        }
        if (answer.decision === "timeout") {
          this.expireApproval(approvalId, "timeout", runId);
        } else if (answer.decision === "channel_lost") {
          this.expireApproval(approvalId, "channel_lost", runId);
        } else {
          try {
            this.store.recordLocalApprovalDecision(approvalId, answer.decision, new Date().toISOString());
            this.store.appendRunEvent(runId, { type: "run.approval_decided", payload: { decision: answer.decision } });
          } catch (error) {
            const expectedState = answer.decision === "allow_once" ? "approved" : "denied";
            const recorded = this.store.approvals.get(approvalId);
            const alreadyRecorded =
              recorded !== null && recorded.state === expectedState && recorded.decisionActor === "operator";
            if (!alreadyRecorded) {
              this.onEvent(`sdk approval decision not trusted: ${runId}: ${error instanceof ZBridgeError ? error.code : String(error)}`);
              this.expireApproval(approvalId, "channel_lost", runId);
              this.resumeIfWaiting(runId);
              return { decision: "channel_lost", actor: "channel_lost" } as const;
            }
            try {
              this.store.appendRunEvent(runId, { type: "run.approval_decided", payload: { decision: answer.decision } });
            } catch {
              /* 终态后事件只作丢弃 */
            }
          }
        }
        this.resumeIfWaiting(runId);
        return answer;
      },
      requestInput: () => {
        this.driveTo(runId, "waiting_input");
        this.resumeIfWaiting(runId);
        return Promise.resolve("unsupported" as const);
      },
    };
  }

  /** 只有仍在等待的 run 才回 running；stopping/terminal 不能因 channel_lost 被拉回。 */
  private resumeIfWaiting(runId: RunId): void {
    const state = this.store.runs.require(runId).state;
    if (state === "waiting_approval" || state === "waiting_input") {
      this.driveTo(runId, "running");
    }
  }

  private expireApproval(approvalId: import("../contracts/ids.ts").ApprovalId, actor: "timeout" | "channel_lost", runId: RunId): void {
    const recorded = this.store.approvals.get(approvalId);
    // 队列的期限定时器可能已先行结算；重复结算不是异常，不该打成 error 日志误导运维。
    if (recorded === null || recorded.state !== "pending") return;
    try {
      this.store.expireApproval(approvalId, {
        actor: actor === "timeout" ? "product_expiry" : "channel_lost",
        state: actor === "timeout" ? "expired" : "cancelled",
        at: new Date().toISOString(),
      });
    } catch (error) {
      this.onEvent(`sdk approval expire failed: ${runId}: ${error instanceof ZBridgeError ? error.code : String(error)}`);
    }
  }
}

/** OpenCode 协调器消费的双段选择；非 opencode 后端传入时为协议错误。 */
export function requireOpencodeSelection(model: BackendModelSelection): ModelSelection {
  if (model.opencode === null) {
    throw new Error(`opencode 协调器收到非 opencode 模型选择（backend=${model.backendId}）`);
  }
  return model.opencode;
}

/**
 * 后端运行时工厂：daemon 在 ensureRuntime 时按 run 的后端归属调用。
 * 粒度由各适配器决定（OpenCode 按工作区；SDK worker 按产品会话）。
 */
export type BackendRuntime = {
  readonly adapter: ManagedAdapter;
  readonly coordinator: RunCoordinator;
  readonly serverEpoch: number;
};

export interface BackendRuntimeContext {
  readonly backendId: BackendId;
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly sessionId: string;
}

export type BackendRuntimeFactory = (context: BackendRuntimeContext) => Promise<BackendRuntime>;

const FACTORIES = new Map<BackendId, BackendRuntimeFactory>();

/** 启动期注册；同 ID 重复注册视为编码错误（固定三后端，不做动态插件）。 */
export function registerBackendRuntime(id: BackendId, factory: BackendRuntimeFactory): void {
  if (FACTORIES.has(id)) throw new Error(`后端 ${id} 的运行时工厂已注册`);
  FACTORIES.set(id, factory);
}

/** 测试隔离用：清空注册表。 */
export function resetBackendRuntimes(): void {
  FACTORIES.clear();
}

export function hasBackendRuntime(id: BackendId): boolean {
  return FACTORIES.has(id);
}

export function registeredBackendIds(): readonly BackendId[] {
  return [...FACTORIES.keys()];
}

/** 按 run 归属取运行时；未注册的后端是配置/路由错误，明确报错。 */
export function ensureBackendRuntime(context: BackendRuntimeContext): Promise<BackendRuntime> {
  const factory = FACTORIES.get(context.backendId);
  if (factory === undefined) {
    throw new Error(`后端 ${context.backendId} 未注册运行时工厂（已注册：${[...FACTORIES.keys()].join(",") || "无"}）`);
  }
  return factory(context);
}
