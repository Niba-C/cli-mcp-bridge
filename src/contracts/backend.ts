/**
 * BackendAdapter 最小接口（技术规格 §5、§6）。
 *
 * 这是内部接口，任何方法都不会直接变成 MCP 工具。适配器负责与真实后端
 * （OpenCode HTTP Server）打交道；上层只按这里的事件与终态做状态机决策。
 *
 * 刻意不放进接口的东西：
 * - 不传 env：worker 环境必须由适配器按白名单从空对象构造，不能让调用方注入；
 * - 不传 cwd / argv / 可执行文件：工作区根只来自已登记的 workspace，可执行文件固定；
 * - 不暴露 provider/密钥或任意后端 URL：模型只按受控 profile 映射。
 */
import type { ApprovalDecision, ApprovalRequestKind } from "./approval.ts";
import type { InputAnswer, QuestionSchema } from "./input.ts";
import type { IsoTimestamp } from "./common.ts";
import type { RunId } from "./ids.ts";
import type { StopReason, TerminalRunState } from "./run.ts";
import type { WorkspaceProfile } from "./workspace.ts";
import type { BackendId } from "./version.ts";

/**
 * OC-09 固定后端 ID 再导出，避免各模块从 version.ts 与 backend.ts 拿到不同名字。
 * 历史数据（migration v5 前）与旧回执一律解释为 "opencode"。
 */
export type { BackendId };

/**
 * 受控策略 profile：映射到受控运行目录里的 OpenCode 权限策略集合。
 * 它不是 ACP 的 session mode，也不表示运行中的模式切换；策略内容由 daemon 准备。
 */
export const BACKEND_POLICY_PROFILES = ["review", "edit"] as const;
export type BackendPolicyProfile = (typeof BACKEND_POLICY_PROFILES)[number];

/**
 * 一次执行选定的模型（OC-08 起，OC-09 扩展到三后端）。
 * - opencode：`providerID/modelID` 双段，来自配置 modelProfiles 允许列表；
 * - codebuddy/qoder：后端原生模型 ID 单段字符串（有界、无 URL/路径/控制字符），
 *   来自各自配置 models.allowed 精确匹配。
 */
export interface ModelSelection {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * 后端中立的模型选择。`modelRef` 是唯一持久化与幂等哈希使用的完整字符串：
 * OpenCode 为 `providerID/modelID`，其余后端为原生 ID。`opencode` 字段只在
 * opencode 后端非空，供现有 OpenCode 链路直接消费；其他后端为 null，
 * 不把双段格式强加给原生 ID。
 */
export interface BackendModelSelection {
  readonly backendId: BackendId;
  readonly modelRef: string;
  readonly opencode: ModelSelection | null;
}

/** 把持久化的 modelRef 按 backendId 解释回中立选择；格式不合法返回 null。 */
export function parseBackendModelRef(backendId: BackendId, modelRef: string): BackendModelSelection | null {
  if (modelRef.length === 0) return null;
  if (backendId === "opencode") {
    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) return null;
    if (modelRef.indexOf("/", slash + 1) !== -1) return null;
    return {
      backendId,
      modelRef,
      opencode: { providerID: modelRef.slice(0, slash), modelID: modelRef.slice(slash + 1) },
    };
  }
  return { backendId, modelRef, opencode: null };
}

export interface SessionSpec {
  /** 已 realpath、已登记的工作区根；适配器不再做策略判断。 */
  readonly workspaceRoot: string;
  readonly profile: WorkspaceProfile;
  /** 受控策略集合名；具体 allow/ask/deny 规则在受控运行目录内。 */
  readonly policyProfile: BackendPolicyProfile;
  /** 创建后端会话时使用的受控模型（允许列表内的 providerID/modelID），不是密钥。 */
  readonly model: ModelSelection;
  /** 本产品独占的 OpenCode 运行目录（独立 HOME／XDG／config／data），由 daemon 准备。 */
  readonly runDir: string;
}

export interface BackendSessionRef {
  /** OpenCode 返回的 session ID；与产品 sessionId 分开存，不能互相顶替。 */
  readonly backendSessionId: string;
  /** 创建／加载该会话的服务代际；不同启动不混用审批与在途状态。 */
  readonly serverEpoch: number;
  /** OpenCode server 版本；未探测时为 null，不能猜。 */
  readonly backendVersion: string | null;
}

/**
 * 适配器在真实发送边界上回调，让调用方**实时**持久化发送证据。
 *
 * 存在的理由：如果只在整轮结束后补记，任务挂起或崩溃时数据库里只剩
 * `possibly_sent`、没有消息 ID，恢复时无法判断到底有没有发出去。
 * 钩子抛错视为致命：发送前抛错就不发送，发送后抛错就不能报成功。
 */
export interface DispatchHooks {
  /** 生成用户 messageID 之后、发送之前。 */
  onMessageId?(messageId: string): void | Promise<void>;
  /** HTTP 明确受理之后。 */
  onAccepted?(messageId: string): void | Promise<void>;
  /** 从历史确认本 run 消息之后。 */
  onConfirmed?(messageId: string): void | Promise<void>;
  /** 后端明确拒绝（4xx）之后。 */
  onRejected?(): void | Promise<void>;
}

export interface TurnSpec {
  readonly runId: RunId;
  readonly session: BackendSessionRef;
  readonly prompt: string;
  /**
   * 本 run 选定的模型（OC-08 起，OC-09 中立化）：每次 prompt 都显式携带，
   * 不能只在创建 worker／session 时设置一次，也不允许 adapter 用自己的
   * 常量顶替。OpenCode 适配器收窄为双段（opencode 字段非空）。
   */
  readonly model: BackendModelSelection;
  /** 硬期限；到时由适配器发起有界停止，而不是无限等。 */
  readonly deadlineAt: IsoTimestamp;
  /**
   * 本 run 的发送意图 ID（OC-02 的 dispatch attempt）。
   * 用于把审批请求绑定到具体 attempt，避免跨 attempt 复用许可。
   */
  readonly attemptId?: string;
  /** 实时持久化发送证据；见 DispatchHooks。 */
  readonly onDispatch?: DispatchHooks;
}

export interface ToolCallSummary {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly phase: "requested" | "started" | "completed" | "failed";
  /** 参数摘要（脱敏后有界），不是完整参数。 */
  readonly summary: string;
}

export interface BackendApprovalRequest {
  readonly requestKind: ApprovalRequestKind;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly attemptId: string;
  readonly serverEpoch: number;
  /**
   * 后端自己的请求 ID（OpenCode `per_*`）。产品 approvalId 与它分开：
   * 本地审批记录用它回指后端请求，但用户看到的 ID 不是它。
   */
  readonly backendRequestId?: string;
  /** 完整决策所需参数的文本形态，受保护存储，不进普通日志。 */
  readonly argumentsText: string;
  readonly targetPaths: readonly string[];
  readonly expiresAt: IsoTimestamp;
}

/** 适配器只能拿到这四种答复；timeout/channel_lost 都不是「用户拒绝」。 */
export type ApprovalAnswer =
  | { readonly decision: ApprovalDecision; readonly actor: "operator" }
  | { readonly decision: "timeout"; readonly actor: "product_expiry" }
  | { readonly decision: "channel_lost"; readonly actor: "channel_lost" };

export type BackendEvent =
  | { readonly type: "progress"; readonly text: string }
  | { readonly type: "message"; readonly text: string; readonly final: boolean }
  | { readonly type: "tool"; readonly tool: ToolCallSummary }
  | { readonly type: "approval_requested"; readonly request: BackendApprovalRequest }
  | { readonly type: "input_requested"; readonly schema: QuestionSchema }
  | { readonly type: "stderr"; readonly tail: string }
  | { readonly type: "warning"; readonly code: string; readonly message: string };

export interface BackendEventSink {
  /** 同步、无 await：事件顺序就是状态机看到的顺序。 */
  emit(event: BackendEvent): void;
  /** 未决期间后端 Promise 保持挂起；超时/断连由实现返回 timeout/channel_lost。 */
  requestApproval(request: BackendApprovalRequest): Promise<ApprovalAnswer>;
  /** v0.1 没有 agent_answer 工具时返回 unsupported，让 run 有界停止。 */
  requestInput(schema: QuestionSchema): Promise<InputAnswer | "unsupported">;
}

export interface TurnUsage {
  readonly source: "backend" | "estimated" | "unavailable";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface TurnOutcome {
  readonly kind: TerminalRunState;
  readonly stopReason: StopReason | null;
  /** 产生该结果的服务代际；与 dispatch attempt 不是一个计数。 */
  readonly serverEpoch: number;
  /** 停止请求之后才到达的终态：调用方必须保留已有终态，只记审计。 */
  readonly terminalObservedAfterStop: boolean;
  /** 后端自述内容，只能进 agentReported 栏位。 */
  readonly agentReported: string | null;
  /**
   * OC-09：本轮后端消息里实际观测到的模型身份；没有证据时为 null/省略。
   * 只记录本轮证据，不用配置回声冒充（B06）。
   */
  readonly observedModel?: string | null;
  readonly usage: TurnUsage;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
}

export interface StopSpec {
  readonly runId: RunId;
  readonly session: BackendSessionRef;
  readonly intent: "interrupt" | "cancel" | "close";
  /** 有界升级窗口：超时后允许终止本 worker 独占的进程组。 */
  readonly graceMs: number;
}

export interface StopOutcome {
  /** 只有「匹配终态 + 后台静止」或「独占进程树已退出」才能为 true。 */
  readonly confirmed: boolean;
  readonly method: "protocol" | "process_tree" | "none";
  readonly settledAt: IsoTimestamp | null;
  readonly detail: string;
}

export type SupportLevel = "supported" | "unsupported" | "unknown" | "not_applicable";

/**
 * 能力项：support 是声明，verifiedAt/evidenceRef 是证据。
 * 不允许用一个 true 同时表示「协议有这个方法」和「本机实测可用」。
 */
export interface Capability {
  readonly support: SupportLevel;
  readonly verifiedAt: IsoTimestamp | null;
  readonly evidenceRef: string | null;
  readonly limitation?: string;
}

/** 适配器对后端暴露的最小方法集；不是 MCP 工具，也不保证都已验证。 */
export const METHOD_NAMES = [
  "health",
  "createSession",
  "loadSession",
  "execute",
  "stop",
  "close",
  "events",
  "resolvePermission",
] as const;
export type MethodName = (typeof METHOD_NAMES)[number];

export interface BackendVersions {
  /** 本产品 adapter 的版本；不冒充 OpenCode 版本。 */
  readonly adapter: Capability & { readonly version: string | null };
  /** OpenCode server 的版本，来自 health 或可执行文件。 */
  readonly backendServer: Capability & { readonly version: string | null };
  /** 安装版本提供的 API schema 标识与来源引用。 */
  readonly apiSchema: Capability & { readonly version: string | null; readonly sourceRef: string | null };
}

export interface BackendCapabilities {
  /** adapter 标识：产品为 "opencode-http"；fake 用 "fake"。 */
  readonly adapterId: string;
  /** 本次探测使用的受控策略集合。 */
  readonly policyProfile: BackendPolicyProfile;
  /** 受控运行目录的引用（不是绝对路径）；绝对路径只留在服务端。 */
  readonly runDirRef: string;
  readonly versions: BackendVersions;
  readonly methods: Readonly<Record<MethodName, Capability>>;
  /** 「真实项目文件不会被修改」的证据等级；不等于「只读」。 */
  readonly reviewWriteBlocked: Capability;
  readonly writeSandbox: Capability;
  readonly controlChannelIsolation: Capability;
  readonly usageSource: "backend" | "estimated" | "unavailable";
  readonly hardBudget: Capability;
  /** 适配器是否会在瞬时失败后内部重发；无法关闭时 edit 不发布。 */
  readonly internalRetry: Capability;
  /** 崩溃/重启后能否用同一 backendSessionId 继续；没有证据必须 unknown。 */
  readonly sessionResume: Capability;
  readonly probedAt: IsoTimestamp;
}

export interface BackendAdapter {
  probe(): Promise<BackendCapabilities>;
  createSession(spec: SessionSpec): Promise<BackendSessionRef>;
  loadSession(ref: BackendSessionRef): Promise<BackendSessionRef>;
  execute(spec: TurnSpec, sink: BackendEventSink): Promise<TurnOutcome>;
  stop(spec: StopSpec): Promise<StopOutcome>;
  close(): Promise<void>;
  /**
   * 可选能力：仅当 probe() 里对应方法 support=supported 时才允许调用。
   * 不提供默认实现，避免「调用成功但实际没生效」的假能力。
   */
  fork?(session: BackendSessionRef, mode: "native_fork" | "explicit_summary"): Promise<BackendSessionRef>;
  steer?(runId: RunId, message: string): Promise<void>;
}
