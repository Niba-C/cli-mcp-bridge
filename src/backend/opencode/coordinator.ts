/**
 * adapter 与存储之间的薄执行协调器（技术规格 §4、§7）。
 *
 * 只做一件事：把一个已受理的 run 从「可能已发出」推到一个有证据的终态。
 * 不含 daemon 调度、队列、活动任务上限、operator 通道或 MCP。
 *
 * 顺序不可颠倒：
 * 1. `prepareDispatch()` 在同一事务里提交 `possibly_sent` 并把 run 推到 starting；
 * 2. 之后才发 HTTP（adapter 内部）；
 * 3. 收到 2xx 记 `sent`，历史确认消息后再记 `confirmed`；
 * 4. 未确认、发送结果不明 → `recordDispatchUnknown`：run 变 unknown 并持续阻塞 session，
 *    不重发、不新建第二个 attempt；
 * 5. 完成必须经过 draining，并用 `completeRunWithResult()` 与结果清单原子写入。
 */
import type {
  ApprovalAnswer,
  BackendApprovalRequest,
  BackendEvent,
  BackendEventSink,
  BackendModelSelection,
  StopOutcome,
} from "../../contracts/backend.ts";
import type { IsoTimestamp, Principal } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { ApprovalId, RunId } from "../../contracts/ids.ts";
import { payloadHash } from "../../contracts/json.ts";
import type { Approval, Run, RunState, WorkspaceProfile } from "../../contracts/index.ts";
import { isTerminalRunState } from "../../contracts/run.ts";
import type { BridgeStore } from "../../storage/store.ts";
import type { ResultInput } from "../../storage/types.ts";
import type {
  OpenCodeHttpAdapter,
  OpenCodeTurnResult,
  RequestOutcome,
  TurnStopCause,
} from "./adapter.ts";

export interface CoordinatorOptions {
  /** 本地审批决策回调。缺省时不放行任何请求（按产品期限收敛），不伪造用户决策。 */
  readonly onApproval?: (request: BackendApprovalRequest) => Promise<ApprovalAnswer> | ApprovalAnswer;
  /**
   * OC-04：本地审批记录创建成功后同步回调，让 daemon 的 operator 队列拿到
   * approvalId 并开始等待可信决策。审批创建失败不会触发本回调。
   */
  readonly onApprovalRecorded?: (approval: Approval, request: BackendApprovalRequest) => void;
  readonly policyVersion?: string;
  readonly approvalTimeoutMs?: number;
  readonly now?: () => IsoTimestamp;
  readonly onWarning?: (message: string) => void;
}

export interface CoordinatorInput {
  readonly runId: RunId;
  readonly prompt: string;
  readonly deadlineAt: IsoTimestamp;
  /**
   * 本 run 受理时持久化的模型选择：后端中立形态（OC-09）。OpenCode 协调器
   * 只接受 opencode 归属的双段选择，其它后端在此处即协议错误。
   */
  readonly model: BackendModelSelection;
}

export interface CoordinatorResult {
  readonly runId: RunId;
  readonly state: RunState;
  readonly attemptId: string;
  readonly requestOutcome: RequestOutcome;
  readonly messageConfirmed: boolean;
  readonly stopCause: TurnStopCause;
  readonly resultReady: boolean;
  readonly warnings: readonly string[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

const POLICY_VERSION = "oc03-controlled-v1";
const MAX_CLAIM_TEXT = 16_000;

function truncate(text: string, max = MAX_CLAIM_TEXT): string {
  if (text.length <= max) return text;
  const marker = "…[truncated]".slice(0, max);
  let prefix = text.slice(0, max - marker.length);
  // 存储上限使用 UTF-16 长度；标记计入同一上限，并避免切断 emoji。
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + marker;
}

export class OpenCodeRunCoordinator {
  private readonly store: BridgeStore;
  private readonly adapter: OpenCodeHttpAdapter;
  private readonly options: CoordinatorOptions;
  private readonly approvalsByRequest = new Map<string, ApprovalId>();

  constructor(store: BridgeStore, adapter: OpenCodeHttpAdapter, options: CoordinatorOptions = {}) {
    this.store = store;
    this.adapter = adapter;
    this.options = options;
  }

  private warn(message: string): void {
    this.options.onWarning?.(message);
  }

  /** 从 queued/starting 走到某个中间或终态（completed 除外）。 */
  private driveTo(runId: RunId, target: RunState, payload: Record<string, string | number | boolean | null> = {}): Run {
    let run = this.store.runs.require(runId);
    if (run.state === target) return run;
    const path = pathFor(target);
    // 已经走到路径中段时从下一跳继续，不能把 stopping/draining 拉回 running。
    const currentIndex = path.indexOf(run.state);
    const ordered = currentIndex < 0 ? path : path.slice(currentIndex + 1);
    for (const step of ordered) {
      if (run.state === step) continue;
      if (isTerminalRunState(run.state)) return run;
      const result = this.store.transitionRun(runId, step, { payload });
      if (!result.accepted) return result.run;
      run = result.run;
    }
    return run;
  }

  private appendEvent(
    runId: RunId,
    type: "run.progress" | "run.tool" | "run.warning" | "run.approval_decided",
    payload: Record<string, string | number | boolean | null>,
  ): void {
    try {
      this.store.appendRunEvent(runId, { type, payload });
    } catch (error) {
      // 终态之后到达的进度只作丢弃，不把已完成的 run 拉回活跃。
      if (!(error instanceof ZBridgeError)) throw error;
      this.warn(`append_event_ignored: ${error.code}`);
    }
  }

  private makeSink(input: CoordinatorInput, attemptId: string, serverEpoch: number, profile: WorkspaceProfile): BackendEventSink {
    return {
      emit: (event: BackendEvent): void => {
        switch (event.type) {
          case "progress":
            this.driveTo(input.runId, "running");
            this.appendEvent(input.runId, "run.progress", { text: truncate(event.text, 4096) });
            return;
          case "tool":
            this.appendEvent(input.runId, "run.tool", {
              callId: event.tool.toolCallId.slice(0, 128),
              tool: event.tool.toolName.slice(0, 64),
              phase: event.tool.phase,
            });
            return;
          case "warning":
            this.appendEvent(input.runId, "run.warning", { code: event.code.slice(0, 64) });
            return;
          case "stderr":
            this.appendEvent(input.runId, "run.warning", { code: "STDERR", tail: truncate(event.tail, 512) });
            return;
          case "input_requested":
            this.driveTo(input.runId, "waiting_input");
            return;
          case "approval_requested": {
            this.driveTo(input.runId, "waiting_approval", { requestKind: event.request.requestKind });
            return;
          }
          case "message":
            // adapter 不产生该事件；即便出现也只作为进度，不影响终态。
            this.appendEvent(input.runId, "run.progress", { text: truncate(event.text, 4096) });
            return;
        }
      },
      requestApproval: async (request: BackendApprovalRequest): Promise<ApprovalAnswer> => {
        const approvalId = this.createLocalApproval(input, attemptId, serverEpoch, profile, request);
        if (request.backendRequestId !== undefined) this.approvalsByRequest.set(request.backendRequestId, approvalId);
        // 审批行已落库：daemon 的 operator 队列现在可以列出并决定它。
        if (this.options.onApprovalRecorded !== undefined) {
          try {
            const approval = this.store.approvals.require(approvalId);
            this.options.onApprovalRecorded(approval, request);
          } catch (error) {
            this.warn(`approval_notify_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
          }
        }
        const answer = await this.decide(approvalId, input.runId, request);
        this.driveTo(input.runId, "running");
        return answer;
      },
      requestInput: async () => {
        this.driveTo(input.runId, "waiting_input");
        return "unsupported";
      },
    };
  }

  private createLocalApproval(
    input: CoordinatorInput,
    attemptId: string,
    serverEpoch: number,
    _profile: WorkspaceProfile,
    request: BackendApprovalRequest,
  ): ApprovalId {
    try {
      const approval = this.store.createApproval({
        runId: input.runId,
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
        policyVersion: this.options.policyVersion ?? POLICY_VERSION,
        expiresAt: request.expiresAt,
        at: this.now(),
      });
      return approval.approvalId;
    } catch (error) {
      this.warn(`approval_record_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
      throw error;
    }
  }

  private async decide(approvalId: ApprovalId, runId: RunId, request: BackendApprovalRequest): Promise<ApprovalAnswer> {
    const handler = this.options.onApproval;
    if (handler === undefined) {
      // 没有可信操作者通道时，按产品期限收敛；这不是「用户拒绝」。
      this.expire(approvalId, "timeout");
      return { decision: "timeout", actor: "product_expiry" };
    }
    let answer: ApprovalAnswer;
    try {
      answer = await handler(request);
    } catch (error) {
      this.warn(`approval_handler_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
      this.expire(approvalId, "channel_lost");
      return { decision: "channel_lost", actor: "channel_lost" };
    }
    if (answer.decision === "timeout") {
      this.expire(approvalId, "timeout");
    } else if (answer.decision === "channel_lost") {
      this.expire(approvalId, "channel_lost");
    } else {
      try {
        // 本地记录失败（含已过期）时，这个许可已经不可信：绝不能发给后端。
        this.store.recordLocalApprovalDecision(approvalId, answer.decision, this.now());
        this.appendEvent(runId, "run.approval_decided", { decision: answer.decision });
      } catch (error) {
        // OC-04：operator 队列在返回答案**之前**已经把同一决策落库时，
        // 这里按幂等成功处理（不能把真实 allow_once 变成 channel_lost）。
        // 其余落库失败仍然绝不能把许可发给后端。
        const expectedState = answer.decision === "allow_once" ? "approved" : "denied";
        const recorded = this.store.approvals.get(approvalId);
        const alreadyRecorded =
          recorded !== null && recorded.state === expectedState && recorded.decisionActor === "operator";
        if (!alreadyRecorded) {
          this.warn(`approval_record_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
          this.expire(approvalId, "channel_lost");
          return { decision: "channel_lost", actor: "channel_lost" };
        }
        this.appendEvent(runId, "run.approval_decided", { decision: answer.decision });
      }
    }
    return answer;
  }

  private expire(approvalId: ApprovalId, actor: "timeout" | "channel_lost"): void {
    try {
      this.store.expireApproval(approvalId, {
        actor: actor === "timeout" ? "product_expiry" : "channel_lost",
        state: actor === "timeout" ? "expired" : "cancelled",
        at: this.now(),
      });
    } catch (error) {
      this.warn(`approval_expire_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
    }
  }

  private now(): IsoTimestamp {
    return this.options.now?.() ?? this.store.now();
  }

  /**
   * 执行一个已受理的 run。调用前必须已有 run 行与后端绑定。
   */
  async run(input: CoordinatorInput): Promise<CoordinatorResult> {
    const store = this.store;
    const run = store.runs.require(input.runId);
    if (isTerminalRunState(run.state)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "run 已是终态，不能再执行", { details: { state: run.state } });
    }
    const deadlineMs = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadlineMs)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "deadlineAt 不是合法时间");
    }
    // 发送前就过期：不提交 possibly_sent、不发 HTTP，任务保持未派发。
    if (deadlineMs <= Date.parse(this.now())) {
      throw new ZBridgeError("REQUEST_EXPIRED", "任务期限在派发前已经到达", {
        details: { phase: "pre_send" },
      });
    }
    const session = store.sessions.require(run.sessionId);
    if (session.backendSessionId === null || session.serverEpoch === null) {
      throw new ZBridgeError("EPOCH_MISMATCH", "session 尚未绑定后端会话");
    }

    // 1) 发送前提交「可能已发出」。这一步之后才允许外部 HTTP。
    const prepared = store.prepareDispatch({
      runId: run.runId,
      backendSessionId: session.backendSessionId,
      serverEpoch: session.serverEpoch,
      at: this.now(),
    });
    const attemptId = prepared.intent.attemptId;

    const sink = this.makeSink(input, attemptId, session.serverEpoch, run.profile);
    // 实时证据：在适配器真正跨越发送边界的时刻落库，而不是整轮结束后补记。
    const onDispatch = {
      onMessageId: (messageId: string) => {
        store.setDispatchMessageId(attemptId, { backendMessageId: messageId, at: this.now() });
      },
      onAccepted: (messageId: string) => {
        store.markDispatchSent(attemptId, { backendMessageId: messageId, at: this.now() });
      },
      onConfirmed: (messageId: string) => {
        store.markDispatchConfirmed(attemptId, { backendMessageId: messageId, at: this.now() });
      },
      onRejected: () => {
        store.markDispatchNotSent(attemptId, { at: this.now(), detail: "后端明确拒绝提交（HTTP 4xx）" });
      },
    };

    let turn: OpenCodeTurnResult;
    try {
      turn = await this.adapter.executeTurn(
        {
          runId: run.runId,
          session: {
            backendSessionId: session.backendSessionId,
            serverEpoch: session.serverEpoch,
            backendVersion: null,
          },
          prompt: input.prompt,
          deadlineAt: input.deadlineAt,
          model: input.model,
          attemptId,
          onDispatch,
        },
        sink,
      );
    } catch (error) {
      const preSend = error instanceof ZBridgeError && error.details?.["phase"] === "pre_send";
      if (preSend) {
        // 明确没有写入后端：可以声明未派发，并按失败收敛。
        store.markDispatchNotSent(attemptId, {
          at: this.now(),
          detail: `发送前失败：${error instanceof ZBridgeError ? error.code : "unknown"}`,
        });
        this.driveTo(run.runId, "failed", { outcome: "failed", errorCode: "BACKEND_UNAVAILABLE" });
        return this.report(input.runId, attemptId, "failed", false, null, [
          `pre_send_failure: ${error instanceof ZBridgeError ? error.code : "unknown"}`,
        ], { code: "BACKEND_UNAVAILABLE", message: "发送前失败，未派发" });
      }
      // 其它异常（启动失败、epoch 不符、回调落库失败）：无法证明后端没执行 → unknown。
      store.recordDispatchUnknown(attemptId, {
        at: this.now(),
        detail: `adapter 异常：${error instanceof ZBridgeError ? error.code : "unknown"}`,
      });
      return this.report(input.runId, attemptId, "unknown", false, null, [
        `adapter_exception: ${error instanceof ZBridgeError ? error.code : "unknown"}`,
      ], error instanceof ZBridgeError ? { code: error.code, message: error.message } : { code: "BACKEND_UNAVAILABLE", message: "adapter 异常" });
    }

    // 2) dispatch 证据链
    let requestOutcome = turn.dispatch.requestOutcome;
    const messageId = turn.dispatch.backendMessageId;
    if (turn.dispatch.messageConfirmed && requestOutcome === "unknown") {
      // 传输层不明，但历史里有本 run 的消息：按已发出 + 已确认处理。
      requestOutcome = "accepted";
    }
    if (requestOutcome === "accepted") {
      store.markDispatchSent(attemptId, { at: this.now(), backendMessageId: messageId });
      if (turn.dispatch.messageConfirmed) {
        store.markDispatchConfirmed(attemptId, { at: this.now(), backendMessageId: messageId });
      }
    } else if (requestOutcome === "rejected") {
      store.markDispatchNotSent(attemptId, { at: this.now(), detail: "后端明确拒绝提交（HTTP 4xx）" });
    } else {
      const unknown = store.recordDispatchUnknown(attemptId, {
        at: this.now(),
        detail: "提交结果不明：无 HTTP 结论，且历史里没有本 run 的消息",
      });
      return this.report(
        run.runId,
        attemptId,
        unknown.run.state,
        false,
        null,
        turn.observations.warnings,
        turn.outcome.error ?? { code: "BACKEND_UNAVAILABLE", message: "提交结果不明" },
      );
    }

    // 3) 终态
    // 观测身份先落库（独立于结果写入；失败只告警，不影响终态收敛）。
    const reported = turn.observations.reportedProviderID !== null && turn.observations.reportedModelID !== null
      ? `${turn.observations.reportedProviderID}/${turn.observations.reportedModelID}`
      : null;
    if (reported !== null) {
      try {
        this.store.runs.setObservedModel(run.runId, reported, this.now());
      } catch (error) {
        this.warn(`observed_model_write_failed: ${error instanceof ZBridgeError ? error.code : "unknown"}`);
      }
    }
    const finalState = this.finalize(run.runId, turn, requestOutcome);
    const snapshot = store.getRunSnapshot(run.runId);
    return this.report(
      run.runId,
      attemptId,
      finalState,
      snapshot.resultReady,
      turn.stopCause,
      turn.observations.warnings,
      turn.outcome.error,
      requestOutcome,
      turn.dispatch.messageConfirmed,
    );
  }

  private report(
    runId: RunId,
    attemptId: string,
    state: RunState,
    resultReady: boolean,
    stopCause: TurnStopCause,
    warnings: readonly string[],
    error: { readonly code: string; readonly message: string } | null,
    requestOutcome: RequestOutcome = "unknown",
    messageConfirmed = false,
  ): CoordinatorResult {
    return {
      runId,
      state,
      attemptId,
      requestOutcome,
      messageConfirmed,
      stopCause,
      resultReady,
      warnings,
      error,
    };
  }

  /**
   * 把 adapter 的结果写成产品终态。
   *
   * - completed：必须经过 draining，并 `completeRunWithResult()` 原子写结果；
   * - failed：经 draining 落 failed（证据不足不报成功）；
   * - cancelled／interrupted／timed_out：经 stopping；
   * - unknown：直接落 unknown，session 由存储层持续阻塞。
   */
  private finalize(runId: RunId, turn: OpenCodeTurnResult, requestOutcome: RequestOutcome): RunState {
    const kind = turn.outcome.kind;
    const result = this.buildResultClaims(turn);

    if (kind === "completed") {
      this.driveTo(runId, "draining", { outcome: "completed" });
      try {
        this.store.completeRunWithResult(runId, result, { at: this.now() });
      } catch (error) {
        // 结果写入失败：不能停在 draining 假装成功，收敛为 unknown（阻塞后续任务）。
        this.store.transitionRun(runId, "unknown", {
          payload: { reason: "result_write_failed" },
          at: this.now(),
        });
        throw error;
      }
      return this.store.runs.require(runId).state;
    }

    if (kind === "failed") {
      this.driveTo(runId, "failed", {
        outcome: "failed",
        errorCode: (turn.outcome.error?.code ?? "BACKEND_ERROR").slice(0, 64),
        requestOutcome,
      });
      return this.store.runs.require(runId).state;
    }

    if (kind === "cancelled" || kind === "interrupted" || kind === "timed_out") {
      this.driveTo(runId, kind, { outcome: kind, stopCause: turn.stopCause ?? "none" });
      return this.store.runs.require(runId).state;
    }

    this.store.transitionRun(runId, "unknown", {
      payload: {
        reason: (turn.outcome.error?.code ?? "no_terminal_evidence").slice(0, 64),
        stopCause: turn.stopCause ?? "none",
        requestOutcome,
      },
      at: this.now(),
    });
    return this.store.runs.require(runId).state;
  }

  /**
   * 三类结果严格分开：
   * - agentReported：模型自述，不带证据引用；
   * - observed：本 adapter 实际观察到的事实（消息数、工具终态、finish 原值等）；
   * - verification：本项没有独立验证产物，保持为空 —— 不能让 `verified` 变成 true。
   */
  private buildResultClaims(turn: OpenCodeTurnResult): ResultInput {
    const observed: { text: string }[] = [
      { text: `assistantMessages=${turn.observations.assistantMessages}` },
      { text: `progressEvents=${turn.observations.progressEvents}` },
      { text: `sessionStatus=${turn.observations.sessionStatus}` },
      { text: `requestedModel=${turn.observations.requestedProviderID}/${turn.observations.requestedModelID}` },
      { text: `reportedModel=${turn.observations.reportedProviderID ?? "none"}/${turn.observations.reportedModelID ?? "none"}` },
      { text: `sseFrames=${turn.observations.sse.frames} unknownEvents=${turn.observations.sse.unknownEvents} duplicateEvents=${turn.observations.sse.duplicateEvents}` },
    ];
    if (turn.mapped.rawFinish !== null) observed.push({ text: `backendFinish=${turn.mapped.rawFinish}` });
    if (turn.mapped.errorName !== null) observed.push({ text: `backendError=${turn.mapped.errorName}` });
    for (const tool of turn.observations.toolCalls.slice(0, 8)) {
      observed.push({ text: `tool ${tool.toolName} ${tool.callId} ${tool.state}` });
    }
    const agentReported = turn.outcome.agentReported === null ? [] : [{ text: truncate(turn.outcome.agentReported) }];
    return { agentReported, observed, verification: [] };
  }

  /** 允许调用方在 `recordLocalApprovalDecision` 之外查询本地审批映射（离线测试用）。 */
  approvalIdFor(backendRequestId: string): ApprovalId | null {
    return this.approvalsByRequest.get(backendRequestId) ?? null;
  }

  /**
   * 有界停止：先落停止意图，再 abort 并核对；无法确认时回收本 worker 的进程树。
   */
  async stop(input: {
    readonly runId: RunId;
    readonly intent: "interrupt" | "cancel" | "close";
    readonly graceMs: number;
  }): Promise<StopOutcome> {
    const run = this.store.runs.require(input.runId);
    if (isTerminalRunState(run.state)) {
      return { confirmed: false, method: "none", settledAt: null, detail: "run 已是终态，没有可停止的执行" };
    }
    const session = this.store.sessions.require(run.sessionId);
    if (session.backendSessionId === null || session.serverEpoch === null) {
      return { confirmed: false, method: "none", settledAt: null, detail: "session 未绑定后端，无法停止" };
    }
    if (run.state === "queued") {
      this.store.transitionRun(run.runId, "cancelled", { payload: { intent: input.intent } });
      return { confirmed: true, method: "none", settledAt: this.now(), detail: "尚未派发，直接取消" };
    }
    this.driveTo(run.runId, "stopping", { intent: input.intent });
    const outcome = await this.adapter.stop({
      runId: run.runId,
      session: {
        backendSessionId: session.backendSessionId,
        serverEpoch: session.serverEpoch,
        backendVersion: null,
      },
      intent: input.intent,
      graceMs: input.graceMs,
    });
    if (outcome.confirmed) {
      const target: RunState = input.intent === "interrupt" ? "interrupted" : "cancelled";
      this.driveTo(run.runId, target, { stopMethod: outcome.method });
    } else {
      this.store.transitionRun(run.runId, "unknown", {
        payload: { reason: "STOP_UNCONFIRMED", stopMethod: outcome.method },
        at: this.now(),
      });
    }
    return outcome;
  }

  /** 供上层读取当前主体可见的快照（这里只用于离线测试与报告）。 */
  snapshot(runId: RunId, principal?: Principal) {
    return this.store.getRunSnapshot(runId, principal);
  }
}

/** target 之前必须经过的状态序列（completed 只能由 completeRunWithResult 写入）。 */
function pathFor(target: RunState): readonly RunState[] {
  switch (target) {
    case "running":
      return ["running"];
    case "waiting_approval":
      return ["running", "waiting_approval"];
    case "waiting_input":
      return ["running", "waiting_input"];
    case "draining":
      return ["running", "draining"];
    case "stopping":
      return ["running", "stopping"];
    case "failed":
      return ["running", "draining", "failed"];
    case "cancelled":
    case "interrupted":
    case "timed_out":
      return ["running", "stopping", target];
    case "unknown":
      return ["unknown"];
    default:
      return [target];
  }
}
