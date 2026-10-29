/**
 * fake backend：确定性、无网络、无真实进程。
 *
 * 它的用途是让状态机、调度、幂等与审批逻辑在**不触碰真实后端**的前提下被反复测试。
 * 它不冒充真机：probe() 里所有涉及隔离、停止确认和恢复的能力一律 unknown，
 * 一旦有人把 fake 的结果当成真机证据，测试会先失败（见 tests/security）。
 *
 * fake 也不模拟 OpenCode 的「懒占位」：createSession 直接给出真实形状的
 * backendSessionId + serverEpoch，产品会话与后端会话仍然分开。
 */
import type {
  ApprovalAnswer,
  BackendAdapter,
  BackendApprovalRequest,
  BackendCapabilities,
  BackendEvent,
  BackendEventSink,
  BackendSessionRef,
  SessionSpec,
  StopOutcome,
  StopSpec,
  TurnOutcome,
  TurnSpec,
} from "../../contracts/backend.ts";
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { TerminalRunState } from "../../contracts/run.ts";
import { getScenario, type FakeScenario, type FakeStep } from "./scenarios.ts";

export interface FakeBackendOptions {
  readonly scenario: string;
  /** 固定起点，保证两次运行的时间戳完全一致。 */
  readonly startedAt?: IsoTimestamp;
  readonly serverEpoch?: number;
  readonly deadlineMs?: number;
  /** 虚拟时间到点自动注入 stop，替代真实定时器（确定性优先）。 */
  readonly stopAfterMs?: number;
  readonly stopIntent?: "interrupt" | "cancel" | "close";
  readonly backendSessionId?: string;
}

export interface TranscriptRecord {
  readonly seq: number;
  readonly atMs: number;
  readonly at: IsoTimestamp;
  readonly type: string;
  readonly detail: string;
}

const DEFAULT_STARTED_AT: IsoTimestamp = "2026-01-01T00:00:00.000Z";
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_BACKEND_SESSION_ID = "fake-backend-0001";

function isoPlus(base: IsoTimestamp, ms: number): IsoTimestamp {
  return new Date(Date.parse(base) + ms).toISOString();
}

export class FakeBackend implements BackendAdapter {
  private readonly scenario: FakeScenario;
  private readonly startedAt: IsoTimestamp;
  private readonly deadlineMs: number;
  private readonly stopAfterMs: number | undefined;
  private readonly stopIntent: "interrupt" | "cancel" | "close";
  private readonly serverEpoch: number;
  private readonly baseBackendSessionId: string;

  private readonly records: TranscriptRecord[] = [];
  private virtualMs = 0;
  private stopRequestedAtMs: number | null = null;
  private stopIntentUsed: "interrupt" | "cancel" | "close" | null = null;
  private sessionCreated = false;
  private closed = false;
  /** 只有 execute 真正返回后，才谈得上「停止已被确认」。 */
  private turnSettled = false;

  constructor(options: FakeBackendOptions) {
    this.scenario = getScenario(options.scenario);
    this.startedAt = options.startedAt ?? DEFAULT_STARTED_AT;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.stopAfterMs = options.stopAfterMs;
    this.stopIntent = options.stopIntent ?? "cancel";
    this.serverEpoch = options.serverEpoch ?? 1;
    this.baseBackendSessionId = options.backendSessionId ?? DEFAULT_BACKEND_SESSION_ID;
  }

  get scenarioName(): string {
    return this.scenario.name;
  }

  /** 事件流水：测试用它做逐字节比对，不参与业务语义。 */
  get transcript(): readonly TranscriptRecord[] {
    return this.records;
  }

  transcriptJson(): string {
    return JSON.stringify(this.records);
  }

  private record(type: string, detail: string): void {
    this.records.push({
      seq: this.records.length + 1,
      atMs: this.virtualMs,
      at: isoPlus(this.startedAt, this.virtualMs),
      type,
      detail,
    });
  }

  async probe(): Promise<BackendCapabilities> {
    const unknownCapability = {
      support: "unknown" as const,
      verifiedAt: null,
      evidenceRef: null,
      limitation: "fake backend 不提供任何隔离或安全证据",
    };
    const supported = {
      support: "supported" as const,
      verifiedAt: this.startedAt,
      evidenceRef: `fake:${this.scenario.name}`,
    };
    return {
      adapterId: "fake",
      policyProfile: "review",
      runDirRef: "fake:run",
      versions: {
        adapter: { ...supported, version: "fake-0.0.0" },
        backendServer: {
          ...unknownCapability,
          version: null,
          limitation: "fake 不是 OpenCode server，不声明后端版本",
        },
        apiSchema: {
          ...unknownCapability,
          version: null,
          sourceRef: null,
          limitation: "fake 不提供 OpenCode API schema",
        },
      },
      methods: {
        health: supported,
        createSession: supported,
        loadSession: {
          ...unknownCapability,
          limitation: "fake 只能回显同一引用，不能证明后端会话仍存在",
        },
        execute: supported,
        stop: {
          ...unknownCapability,
          limitation: "fake 只登记 stop，不提供停止确认证据",
        },
        close: supported,
        events: {
          ...unknownCapability,
          limitation: "fake 只有内存事件，不代表 OpenCode SSE 语义",
        },
        resolvePermission: {
          ...supported,
          limitation: "仅 fake 回调，不代表 OpenCode permission API 或操作者隔离",
        },
      },
      reviewWriteBlocked: unknownCapability,
      writeSandbox: unknownCapability,
      controlChannelIsolation: unknownCapability,
      usageSource: "unavailable",
      hardBudget: { ...unknownCapability, support: "unsupported" },
      internalRetry: {
        support: "unknown",
        verifiedAt: null,
        evidenceRef: null,
        limitation: "fake 不做内部重发；真实适配器是否会在写入后重发仍未验证",
      },
      sessionResume: {
        ...unknownCapability,
        limitation: "fake 不提供重启用同一 backendSessionId 继续的证据",
      },
      probedAt: this.startedAt,
    };
  }

  async createSession(_spec: SessionSpec): Promise<BackendSessionRef> {
    this.sessionCreated = true;
    this.record("session.created", this.baseBackendSessionId);
    // OpenCode 的 POST /session 立即返回真实会话 ID；没有懒占位阶段。
    return {
      backendSessionId: this.baseBackendSessionId,
      serverEpoch: this.serverEpoch,
      backendVersion: "fake-0.0.0",
    };
  }

  async loadSession(ref: BackendSessionRef): Promise<BackendSessionRef> {
    this.record("session.loaded", `${ref.backendSessionId}@${ref.serverEpoch}`);
    return ref;
  }

  async execute(spec: TurnSpec, sink: BackendEventSink): Promise<TurnOutcome> {
    if (this.closed) throw new Error("fake backend 已关闭");
    this.record("turn.started", spec.runId);
    this.turnSettled = false;
    this.virtualMs = 0;

    let terminalStep: Extract<FakeStep, { kind: "terminal" }> | null = null;
    let failure: { code: string; message: string } | null = null;
    let failureState: TerminalRunState = "failed";
    const reported: string[] = [];

    const steps = [...this.scenario.steps].sort((a, b) => a.atMs - b.atMs);

    for (const step of steps) {
      // 让出一次微任务：外部 stop() 能在第一步之前被观察到，行为可重放。
      await Promise.resolve();

      if (this.stopRequestedAtMs === null && this.stopAfterMs !== undefined && step.atMs >= this.stopAfterMs) {
        this.stopRequestedAtMs = this.stopAfterMs;
        this.stopIntentUsed = this.stopIntent;
        this.record("stop.observed", this.stopIntent);
      }

      if (this.stopRequestedAtMs !== null && this.scenario.obeyStop) {
        this.virtualMs = Math.max(this.virtualMs, this.stopRequestedAtMs);
        break;
      }

      if (step.atMs > this.deadlineMs) break;
      this.virtualMs = Math.max(this.virtualMs, step.atMs);

      switch (step.kind) {
        case "progress": {
          this.emit(sink, { type: "progress", text: step.text });
          break;
        }
        case "message": {
          this.emit(sink, { type: "message", text: step.text, final: step.final });
          if (step.final) reported.push(step.text);
          break;
        }
        case "tool": {
          this.emit(sink, {
            type: "tool",
            tool: {
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              phase: step.phase,
              summary: step.summary,
            },
          });
          break;
        }
        case "approval": {
          const request: BackendApprovalRequest = {
            requestKind: step.requestKind,
            toolName: step.toolName,
            toolCallId: step.toolCallId,
            attemptId: `attempt-${this.serverEpoch}`,
            serverEpoch: this.serverEpoch,
            argumentsText: step.argumentsText,
            targetPaths: step.targetPaths,
            expiresAt: isoPlus(this.startedAt, step.atMs + step.ttlMs),
          };
          this.emit(sink, { type: "approval_requested", request });
          const answer: ApprovalAnswer = await sink.requestApproval(request);
          this.record("approval.answered", `${answer.actor}:${answer.decision}`);
          if (answer.decision !== "allow_once") {
            failure = {
              code: answer.decision === "timeout" ? "APPROVAL_EXPIRED" : "APPROVAL_DENIED",
              message: answer.decision === "timeout" ? "审批在期限内无人决策" : "操作被拒绝",
            };
            failureState = "cancelled";
            // 拒绝后不再继续执行后续步骤（不允许模型改写同一命令绕行）。
            break;
          }
          break;
        }
        case "input": {
          this.emit(sink, { type: "input_requested", schema: step.schema });
          const answer = await sink.requestInput(step.schema);
          if (answer === "unsupported") {
            failure = {
              code: "INPUT_REQUIRED_UNSUPPORTED",
              message: "v0.1 无 agent_answer，事实输入无法回答",
            };
            failureState = "cancelled";
          } else {
            this.record("input.answered", answer.kind);
          }
          break;
        }
        case "fail": {
          failure = { code: step.code, message: step.message };
          this.emit(sink, { type: "warning", code: step.code, message: step.message });
          break;
        }
        case "terminal": {
          terminalStep = step;
          reported.push(step.agentReported);
          break;
        }
        case "hold": {
          break;
        }
      }

      if (failure || terminalStep) break;
    }

    const stoppedBeforeTerminal = this.stopRequestedAtMs !== null;
    let kind: TerminalRunState;
    let stopReason = terminalStep?.stopReason ?? null;
    let lateTerminal = false;

    if (failure) {
      kind = failureState;
      stopReason = stopReason ?? (failureState === "cancelled" ? "aborted" : null);
    } else if (terminalStep) {
      kind = "completed";
      // 停止请求之后才到的终态：如实上报，但由上层状态机拒绝改写（A05）。
      lateTerminal = stoppedBeforeTerminal;
    } else if (stoppedBeforeTerminal) {
      kind = this.kindForStop();
      stopReason = "aborted";
    } else {
      // 没有任何终态：按场景约定收敛，绝不假定成功。
      this.virtualMs = this.deadlineMs;
      kind = this.scenario.atDeadline;
      stopReason = null;
    }

    this.record("turn.settled", `${kind}:${stopReason ?? "none"}${lateTerminal ? ":late" : ""}`);
    this.turnSettled = true;

    return {
      kind,
      stopReason,
      serverEpoch: this.serverEpoch,
      terminalObservedAfterStop: lateTerminal,
      agentReported: reported.length > 0 ? reported.join("\n") : null,
      usage: { source: "unavailable", inputTokens: null, outputTokens: null },
      error: failure,
      startedAt: this.startedAt,
      endedAt: isoPlus(this.startedAt, this.virtualMs),
    };
  }

  private kindForStop(): TerminalRunState {
    if (this.stopIntentUsed === "interrupt") return "interrupted";
    return "cancelled";
  }

  private emit(sink: BackendEventSink, event: BackendEvent): void {
    switch (event.type) {
      case "progress":
        this.record("progress", event.text);
        break;
      case "message":
        this.record("message", event.text);
        break;
      case "tool":
        this.record("tool", `${event.tool.toolName}:${event.tool.phase}`);
        break;
      case "approval_requested":
        this.record("approval.requested", event.request.toolCallId);
        break;
      case "input_requested":
        this.record("input.requested", event.schema.kind);
        break;
      case "stderr":
        this.record("stderr", event.tail);
        break;
      case "warning":
        this.record("warning", event.code);
        break;
    }
    sink.emit(event);
  }

  async stop(spec: StopSpec): Promise<StopOutcome> {
    if (this.stopRequestedAtMs === null) {
      this.stopRequestedAtMs = this.virtualMs;
      this.stopIntentUsed = spec.intent;
      this.record("stop.requested", spec.intent);
    }
    // 诚实边界：fake 无法提供「匹配终态 + 后台静止」或「进程树已退出」的证据，
    // 因此停止确认一律为 false；后续任务不得拿 fake 的 confirmed 当断言依据。
    return {
      confirmed: false,
      method: "none",
      settledAt: this.turnSettled ? isoPlus(this.startedAt, this.virtualMs) : null,
      detail: this.turnSettled
        ? "fake：turn 已 settle，但这不构成真实停止证据"
        : "fake：stop 已登记，确认取决于随后终态；fake 不提供真实停止证据",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.record("backend.closed", this.sessionCreated ? "session" : "none");
  }
}
