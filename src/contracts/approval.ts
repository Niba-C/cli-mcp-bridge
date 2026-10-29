/**
 * 审批实体。
 *
 * 关键约束：
 * - 审批绑定 payloadHash + attemptId + 期限，参数一改旧批准立即失效；
 * - 决策只能来自本地可信通道（decisionActor=operator），后端 shell 不能自批；
 * - 模型永远拿不到决策能力，只能看到「等待中」的摘要（技术规格 §7）。
 */
import type { ApprovalId, PrincipalId, RunId, SessionId, WorkspaceId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";

/** 同一 session/request_permission 可能承载授权、计划批准和问题选择，必须按实测 payload 分类。 */
export const APPROVAL_REQUEST_KINDS = [
  "tool_permission",
  "plan_approval",
  "scope_expansion",
  "sandbox_write",
  "unknown",
] as const;
export type ApprovalRequestKind = (typeof APPROVAL_REQUEST_KINDS)[number];

export const APPROVAL_STATES = ["pending", "approved", "denied", "expired", "cancelled"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * 决策来源。human_deny 与 product_expiry / channel_lost 严格区分：
 * 后两者不是用户拒绝，不能写进「用户拒绝过该操作」的审计结论。
 */
export const DECISION_ACTORS = ["operator", "product_expiry", "channel_lost"] as const;
export type DecisionActor = (typeof DECISION_ACTORS)[number];

export type ApprovalDecision = "allow_once" | "deny";

/** 本地决策界面所需的最小信息集（技术规格 §7）。缺项即拒绝，不用截断摘要诱导批准。 */
export interface ApprovalSummary {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly attemptId: string;
  /** 决策绑定到服务代际；换代后的旧许可不再有效。 */
  readonly serverEpoch: number;
  readonly requestKind: ApprovalRequestKind;
  readonly toolName: string;
  readonly toolCallId: string;
  /** 完整决策所需的参数/命令/目标路径；敏感值只在此处按需展示，不进普通日志。 */
  readonly argumentsText: string;
  readonly targetPaths: readonly string[];
  readonly payloadHash: string;
  readonly policyVersion: string;
  readonly expiresAt: IsoTimestamp;
  readonly repeatCount: number;
}

export interface Approval {
  readonly approvalId: ApprovalId;
  readonly ownerId: PrincipalId;
  readonly summary: ApprovalSummary;
  readonly state: ApprovalState;
  readonly decisionActor: DecisionActor | null;
  readonly decidedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly revision: number;
}
