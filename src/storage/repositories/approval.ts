/**
 * 审批仓库。
 *
 * 只做本地数据持久化：创建、查询、记录本地决策/过期。
 * 不发送 OpenCode permission reply，也不提供 operator 通道。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type {
  Approval,
  ApprovalDecision,
  ApprovalRequestKind,
  ApprovalState,
  DecisionActor,
} from "../../contracts/index.ts";
import type { ApprovalId, PrincipalId, RunId, SessionId, WorkspaceId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableStr, str, type SqlRow } from "../rows.ts";

export interface InsertApprovalInput {
  readonly approvalId: ApprovalId;
  readonly ownerId: PrincipalId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
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
  readonly repeatCount: number;
  readonly createdAt: IsoTimestamp;
}

function mapApproval(row: SqlRow): Approval {
  const targetPathsRaw: unknown = JSON.parse(str(row, "target_paths"));
  const targetPaths = Array.isArray(targetPathsRaw)
    ? targetPathsRaw.filter((item): item is string => typeof item === "string")
    : [];
  return {
    approvalId: str(row, "approval_id") as ApprovalId,
    ownerId: str(row, "owner_id") as PrincipalId,
    state: str(row, "state") as ApprovalState,
    decisionActor: nullableStr(row, "decision_actor") as DecisionActor | null,
    decidedAt: nullableStr(row, "decided_at"),
    createdAt: str(row, "created_at"),
    revision: num(row, "revision"),
    summary: {
      approvalId: str(row, "approval_id") as ApprovalId,
      runId: str(row, "run_id") as RunId,
      sessionId: str(row, "session_id") as SessionId,
      workspaceId: str(row, "workspace_id") as WorkspaceId,
      attemptId: str(row, "attempt_id"),
      serverEpoch: num(row, "server_epoch"),
      requestKind: str(row, "request_kind") as ApprovalRequestKind,
      toolName: str(row, "tool_name"),
      toolCallId: str(row, "tool_call_id"),
      argumentsText: str(row, "arguments_text"),
      targetPaths,
      payloadHash: str(row, "payload_hash"),
      policyVersion: str(row, "policy_version"),
      expiresAt: str(row, "expires_at"),
      repeatCount: num(row, "repeat_count"),
    },
  };
}

export class ApprovalRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  insert(input: InsertApprovalInput): Approval {
    this.db.raw
      .prepare(
        `INSERT INTO approvals
           (approval_id, owner_id, run_id, session_id, workspace_id, attempt_id, server_epoch,
            request_kind, tool_name, tool_call_id, arguments_text, target_paths, payload_hash,
            policy_version, expires_at, repeat_count, state, decision_actor, decided_at,
            created_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, 1)`,
      )
      .run(
        input.approvalId,
        input.ownerId,
        input.runId,
        input.sessionId,
        input.workspaceId,
        input.attemptId,
        input.serverEpoch,
        input.requestKind,
        input.toolName,
        input.toolCallId,
        input.argumentsText,
        JSON.stringify(input.targetPaths),
        input.payloadHash,
        input.policyVersion,
        input.expiresAt,
        input.repeatCount,
        input.createdAt,
      );
    return this.require(input.approvalId);
  }

  get(approvalId: ApprovalId): Approval | null {
    const row = this.db.raw.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    return row === undefined ? null : mapApproval(row as SqlRow);
  }

  require(approvalId: ApprovalId): Approval {
    const approval = this.get(approvalId);
    if (approval === null) throw new Error("approval 不存在");
    return approval;
  }

  listPending(runId: RunId | null = null): readonly Approval[] {
    const rows =
      runId === null
        ? this.db.raw.prepare("SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at").all()
        : this.db.raw
            .prepare("SELECT * FROM approvals WHERE state = 'pending' AND run_id = ? ORDER BY created_at")
            .all(runId);
    return rows.map((row) => mapApproval(row as SqlRow));
  }

  listByRun(runId: RunId): readonly Approval[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at")
      .all(runId);
    return rows.map((row) => mapApproval(row as SqlRow));
  }

  /** 本地决策只写库；不调用任何后端 permission API。 */
  decide(
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    actor: DecisionActor,
    at: IsoTimestamp,
  ): Approval {
    const state: ApprovalState = decision === "allow_once" ? "approved" : "denied";
    const result = this.db.raw
      .prepare(
        `UPDATE approvals
            SET state = ?, decision_actor = ?, decided_at = ?, revision = revision + 1
          WHERE approval_id = ? AND state = 'pending'`,
      )
      .run(state, actor, at, approvalId);
    if (Number(result.changes) === 0) throw new Error("approval 不在 pending 状态");
    return this.require(approvalId);
  }

  expire(approvalId: ApprovalId, at: IsoTimestamp, state: "expired" | "cancelled", actor: DecisionActor): Approval {
    const result = this.db.raw
      .prepare(
        `UPDATE approvals
            SET state = ?, decision_actor = ?, decided_at = ?, revision = revision + 1
          WHERE approval_id = ? AND state = 'pending'`,
      )
      .run(state, actor, at, approvalId);
    if (Number(result.changes) === 0) throw new Error("approval 不在 pending 状态");
    return this.require(approvalId);
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM approvals").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
