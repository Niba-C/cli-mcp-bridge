/**
 * 存储层对外类型。
 *
 * 契约类型（Run/Session/Approval/Artifact）保持来自 `src/contracts`，存储只增加
 * 数据库必需但不属于外部 wire contract 的字段（例如 session 阻塞原因、dispatch 证据）。
 */
import type { IsoTimestamp } from "../contracts/common.ts";
import type { Run, RunEvent, Session } from "../contracts/index.ts";
import type { RunId, SessionId } from "../contracts/ids.ts";

/**
 * dispatch 证据阶段。`possibly_sent` 在调用外部发送**之前**落库，
 * 因此崩溃窗口内不会被误判成「未派发」。
 */
export const DISPATCH_PHASES = [
  "possibly_sent",
  "sent",
  "confirmed",
  "not_sent",
  "unknown",
] as const;
export type DispatchPhase = (typeof DISPATCH_PHASES)[number];

export interface ServiceInstance {
  /** 产品 daemon 的服务代际；与 OpenCode worker 的 serverEpoch 分开。 */
  readonly serviceEpoch: number;
  readonly status: "active" | "stopped" | "crashed";
  readonly pid: number | null;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

export interface ServerInstance {
  /** 后端运行时的服务代际；每次启动新分配，永不重复。 */
  readonly serverEpoch: number;
  readonly serviceEpoch: number;
  /** OC-09：该运行时归属的后端（opencode HTTP 服务或某个 SDK worker 服务代际）。 */
  readonly backendId: Run["backendId"];
  readonly status: "active" | "stopped" | "crashed";
  readonly pid: number | null;
  readonly runDir: string | null;
  readonly backendVersion: string | null;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

/** Session + 持久化的阻塞状态；阻塞用于 unknown 结果，不自动解除。 */
export interface SessionRecord extends Session {
  readonly blockedReason: string | null;
  readonly blockedRunId: RunId | null;
  readonly blockedAt: IsoTimestamp | null;
  /** OC-08：最近一次已受理任务选定的完整模型标识；未选择过为 null。 */
  readonly lastSelectedModel: string | null;
}

export interface RequestReceipt {
  readonly principalId: string;
  readonly toolName: string;
  readonly clientRequestId: string;
  readonly serviceEpoch: number;
  readonly requestHash: string;
  readonly runId: RunId;
  readonly createdAt: IsoTimestamp;
}

export interface DispatchIntent {
  readonly attemptId: string;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly backendSessionId: string;
  readonly serverEpoch: number;
  readonly backendMessageId: string | null;
  readonly phase: DispatchPhase;
  /** 发送意图落库时间；它就是「可能已发出」的边界证据。 */
  readonly preparedAt: IsoTimestamp;
  readonly possiblySentAt: IsoTimestamp;
  readonly sentAt: IsoTimestamp | null;
  readonly confirmedAt: IsoTimestamp | null;
  readonly notSentAt: IsoTimestamp | null;
  readonly unknownAt: IsoTimestamp | null;
  readonly detail: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ResultClaimInput {
  readonly text: string;
  /** verification 必须有证据引用；agentReported 不接受证据引用。 */
  readonly evidenceRef?: string | null;
}

export interface ResultInput {
  readonly agentReported?: readonly ResultClaimInput[];
  readonly observed?: readonly ResultClaimInput[];
  readonly verification?: readonly ResultClaimInput[];
}

export interface VerificationClaim {
  readonly text: string;
  readonly evidenceRef: string;
}

/** 结果清单把三类证据分开；没有 verification 条目时 verified 恒为 false。 */
export interface ResultManifest {
  readonly manifestId: string;
  readonly runId: RunId;
  readonly ownerId: string;
  readonly createdAt: IsoTimestamp;
  readonly agentReported: readonly string[];
  readonly observed: readonly string[];
  readonly verification: readonly VerificationClaim[];
  readonly verified: boolean;
}

export interface EventPageResult {
  readonly runId: RunId;
  readonly events: readonly RunEvent[];
  readonly nextSeq: number;
  readonly earliestSeq: number;
  readonly hasMore: boolean;
  readonly snapshotRevision: number;
  readonly runState: Run["state"];
}

export interface RunTransitionResult {
  readonly run: Run;
  readonly event: RunEvent | null;
  readonly accepted: boolean;
  readonly reason: "terminal_immutable" | "illegal_transition" | null;
}

export type RecoveryDisposition =
  | "never_dispatched"
  | "possibly_executed"
  | "confirmed_but_unsettled";

export interface RecoveryRunReport {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly stateBefore: Run["state"];
  readonly stateAfter: Run["state"];
  readonly disposition: RecoveryDisposition;
  readonly attemptId: string | null;
  readonly dispatchPhase: DispatchPhase | null;
  readonly backendSessionId: string | null;
  readonly serverEpoch: number | null;
  readonly backendMessageId: string | null;
  readonly blocked: boolean;
  readonly notes: readonly string[];
}

export interface RecoveryReport {
  readonly at: IsoTimestamp;
  readonly serviceEpoch: number | null;
  readonly runs: readonly RecoveryRunReport[];
  readonly pendingVerifications: readonly RecoveryRunReport[];
  /** 恢复只读/写数据库；没有检查或终止任何外部进程，因此这里永远是 false。 */
  readonly descendantsConfirmedStopped: false;
  readonly notes: readonly string[];
}

/** 未派发和可能执行必须区分；这里只声明存储看到的事实，不推断后端状态。 */
export interface DispatchObservation {
  readonly intent: DispatchIntent | null;
  readonly mayHaveExecuted: boolean;
}
