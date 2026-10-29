/**
 * run 仓库（纯数据访问）。
 *
 * 状态迁移、事件水位与会话占用由 `BridgeStore` 在同一事务内组合，仓库本身
 * 不判断业务合法性；这样测试可以直接验证「事务失败时没有半条状态」。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { RunId, SessionId, WorkspaceId } from "../../contracts/ids.ts";
import type { Run, RunState, WorkspaceProfile } from "../../contracts/index.ts";
import type { BackendId } from "../../contracts/version.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableStr, str, type SqlRow } from "../rows.ts";

export interface InsertRunInput {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly ownerId: string;
  readonly workspaceId: WorkspaceId;
  readonly requestId: string;
  readonly requestHash: string;
  readonly requestTool: string;
  readonly profile: WorkspaceProfile;
  /** OC-09：run 固定归属的后端；与受理请求解析结果一致，之后不改写。 */
  readonly backendId: BackendId;
  readonly state: RunState;
  readonly revision: number;
  readonly lastEventSeq: number;
  /** 受理时解析并持久化的完整模型标识（OC-08）。 */
  readonly selectedModel: string;
  readonly deadlineAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

function mapRun(row: SqlRow): Run {
  return {
    runId: str(row, "run_id") as RunId,
    sessionId: str(row, "session_id") as SessionId,
    requestId: str(row, "request_id"),
    requestHash: str(row, "request_hash"),
    profile: str(row, "profile") as WorkspaceProfile,
    backendId: str(row, "backend_id") as Run["backendId"],
    state: str(row, "state") as RunState,
    revision: num(row, "revision"),
    lastEventSeq: num(row, "last_event_seq"),
    backendAttemptId: nullableStr(row, "backend_attempt_id"),
    deadlineAt: str(row, "deadline_at"),
    resultManifestId: nullableStr(row, "result_manifest_id"),
    selectedModel: nullableStr(row, "selected_model"),
    observedModel: nullableStr(row, "observed_model"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export class RunRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  insert(input: InsertRunInput): Run {
    this.db.raw
      .prepare(
        `INSERT INTO runs
           (run_id, session_id, owner_id, workspace_id, request_id, request_hash, request_tool,
            profile, backend_id, state, revision, last_event_seq, earliest_seq, backend_attempt_id,
            deadline_at, result_manifest_id, selected_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sessionId,
        input.ownerId,
        input.workspaceId,
        input.requestId,
        input.requestHash,
        input.requestTool,
        input.profile,
        input.backendId,
        input.state,
        input.revision,
        input.lastEventSeq,
        input.deadlineAt,
        input.selectedModel,
        input.createdAt,
        input.updatedAt,
      );
    return this.require(input.runId);
  }

  get(runId: RunId): Run | null {
    const row = this.db.raw.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? null : mapRun(row as SqlRow);
  }

  require(runId: RunId): Run {
    const run = this.get(runId);
    if (run === null) throw new ZBridgeError("NOT_FOUND", "run 不存在");
    return run;
  }

  getEarliestSeq(runId: RunId): number {
    const row = this.db.raw.prepare("SELECT earliest_seq FROM runs WHERE run_id = ?").get(runId);
    if (row === undefined) throw new ZBridgeError("NOT_FOUND", "run 不存在");
    return num(row as SqlRow, "earliest_seq");
  }

  updateState(
    runId: RunId,
    state: RunState,
    revision: number,
    at: IsoTimestamp,
  ): Run {
    this.db.raw
      .prepare("UPDATE runs SET state = ?, revision = ?, last_event_seq = ?, updated_at = ? WHERE run_id = ?")
      .run(state, revision, revision, at, runId);
    return this.require(runId);
  }

  setBackendAttempt(runId: RunId, attemptId: string, at: IsoTimestamp): Run {
    this.db.raw
      .prepare("UPDATE runs SET backend_attempt_id = ?, updated_at = ? WHERE run_id = ?")
      .run(attemptId, at, runId);
    return this.require(runId);
  }

  /** OC-08：记录后端关联消息里实际观测到的模型；不改变状态机。 */
  setObservedModel(runId: RunId, modelRef: string, at: IsoTimestamp): Run {
    this.db.raw
      .prepare("UPDATE runs SET observed_model = ?, updated_at = ? WHERE run_id = ?")
      .run(modelRef, at, runId);
    return this.require(runId);
  }

  setResultManifest(runId: RunId, manifestId: string, at: IsoTimestamp): Run {
    this.db.raw
      .prepare("UPDATE runs SET result_manifest_id = ?, updated_at = ? WHERE run_id = ?")
      .run(manifestId, at, runId);
    return this.require(runId);
  }

  raiseEarliestSeq(runId: RunId, seq: number): void {
    this.db.raw
      .prepare("UPDATE runs SET earliest_seq = CASE WHEN earliest_seq < ? THEN ? ELSE earliest_seq END WHERE run_id = ?")
      .run(seq, seq, runId);
  }

  listBySession(sessionId: SessionId): readonly Run[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId);
    return rows.map((row) => mapRun(row as SqlRow));
  }

  /**
   * 会话最近一次受理的 run（OC-08：旧会话继承的兜底事实来源）。
   * v4 之前的会话没有 `sessions.last_selected_model`，但其历史 run 都是真实受理过的
   * 任务——按迁移语义，它们的模型选择是固定 MiniMax（selected_model NULL → LEGACY）。
   */
  lastBySession(sessionId: SessionId): Run | null {
    // rowid（插入序）做 created_at 同毫秒平局的裁决：随机 UUID 的 run_id
    // 不是受理顺序，「最近受理」不能依赖它。
    const row = this.db.raw
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(sessionId);
    return row === undefined ? null : mapRun(row as SqlRow);
  }

  listNonTerminal(): readonly Run[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM runs
          WHERE state NOT IN ('completed','failed','cancelled','interrupted','timed_out','unknown')
          ORDER BY created_at, run_id`,
      )
      .all();
    return rows.map((row) => mapRun(row as SqlRow));
  }

  countAll(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM runs").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
