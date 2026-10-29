/**
 * 产品会话仓库。
 *
 * 后端绑定规则直接复用 `contracts/session.ts` 的 `bindBackendSession`：
 * `backendSessionId` 与 `serverEpoch` 必须成对，且 serverEpoch 必须指向一个真实
 * server instance。绑定不会把恢复等级升级成 verified——数据库恢复不是后端恢复证据。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { PrincipalId, SessionId, WorkspaceId } from "../../contracts/ids.ts";
import type { Session, SessionState, WorkspaceProfile } from "../../contracts/index.ts";
import type { BackendId } from "../../contracts/version.ts";
import { bindBackendSession, UNVERIFIED_RECOVERY } from "../../contracts/session.ts";
import type { SqliteConnection } from "../db.ts";
import type { IdFactory } from "../ids.ts";
import { num, nullableNum, nullableStr, str, type SqlRow } from "../rows.ts";
import type { SessionRecord } from "../types.ts";
import type { ServiceRepository } from "./service.ts";
import type { WorkspaceRepository } from "./workspace.ts";

export interface CreateSessionInput {
  readonly sessionId?: SessionId;
  readonly ownerId: PrincipalId;
  readonly workspaceId: WorkspaceId;
  readonly profile: WorkspaceProfile;
  /** OC-09：会话固定归属的后端；省略时按历史行为创建 opencode 会话。 */
  readonly backendId?: BackendId;
  readonly at?: IsoTimestamp;
}

function mapSession(row: SqlRow): SessionRecord {
  return {
    sessionId: str(row, "session_id") as SessionId,
    ownerId: str(row, "owner_id"),
    workspaceId: str(row, "workspace_id") as WorkspaceId,
    workspaceGeneration: num(row, "workspace_generation"),
    profile: str(row, "profile") as WorkspaceProfile,
    backendId: str(row, "backend_id") as Session["backendId"],
    backendSessionId: nullableStr(row, "backend_session_id"),
    serverEpoch: nullableNum(row, "server_epoch"),
    recoveryVerification: str(row, "recovery_verification") as Session["recoveryVerification"],
    state: str(row, "state") as SessionState,
    revision: num(row, "revision"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    blockedReason: nullableStr(row, "blocked_reason"),
    blockedRunId: nullableStr(row, "blocked_run_id") as SessionRecord["blockedRunId"],
    blockedAt: nullableStr(row, "blocked_at"),
    /** OC-08：最近一次已受理任务选定的模型；新会话/历史会话为 null。 */
    lastSelectedModel: nullableStr(row, "last_selected_model"),
  };
}

export class SessionRepository {
  private readonly db: SqliteConnection;
  private readonly ids: IdFactory;
  private readonly workspaces: WorkspaceRepository;
  private readonly services: ServiceRepository;

  constructor(
    db: SqliteConnection,
    ids: IdFactory,
    workspaces: WorkspaceRepository,
    services: ServiceRepository,
  ) {
    this.db = db;
    this.ids = ids;
    this.workspaces = workspaces;
    this.services = services;
  }

  create(input: CreateSessionInput): SessionRecord {
    const at = input.at ?? new Date().toISOString();
    const workspace = this.workspaces.require(input.workspaceId);
    if (!workspace.profiles.includes(input.profile)) {
      throw new ZBridgeError("PROFILE_NOT_ALLOWED", "workspace 未开放该 profile", {
        details: { profile: input.profile },
      });
    }
    const sessionId = input.sessionId ?? this.ids.session();
    this.db.raw
      .prepare(
        `INSERT INTO sessions
           (session_id, owner_id, workspace_id, workspace_generation, profile, backend_id,
            backend_session_id, server_epoch, recovery_verification, state, revision,
            blocked_reason, blocked_run_id, blocked_at, last_selected_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'idle', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        sessionId,
        input.ownerId,
        input.workspaceId,
        workspace.generation,
        input.profile,
        input.backendId ?? "opencode",
        UNVERIFIED_RECOVERY,
        at,
        at,
      );
    return this.require(sessionId);
  }

  get(sessionId: SessionId): SessionRecord | null {
    const row = this.db.raw.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return row === undefined ? null : mapSession(row as SqlRow);
  }

  require(sessionId: SessionId): SessionRecord {
    const session = this.get(sessionId);
    if (session === null) throw new ZBridgeError("NOT_FOUND", "session 不存在");
    return session;
  }

  listByOwner(ownerId: PrincipalId): readonly SessionRecord[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM sessions WHERE owner_id = ? ORDER BY created_at, session_id")
      .all(ownerId);
    return rows.map((row) => mapSession(row as SqlRow));
  }

  /**
   * 绑定后端会话。拒绝三种情况：非成对、serverEpoch 不存在/非 active、
   * 同一 backend 会话已绑定到另一个产品会话。
   */
  bind(
    sessionId: SessionId,
    backendSessionId: string | null,
    serverEpoch: number | null,
    at: IsoTimestamp,
  ): SessionRecord {
    const session = this.require(sessionId);
    const binding = bindBackendSession(backendSessionId, serverEpoch);
    if (!binding.ok) {
      throw new ZBridgeError("INVALID_ARGUMENT", `后端会话绑定非法：${binding.reason}`);
    }
    if (session.state === "closed") {
      throw new ZBridgeError("SESSION_CLOSED", "已关闭的 session 不能再绑定后端会话");
    }
    if (binding.binding !== null) {
      this.services.requireActiveServer(binding.binding.serverEpoch);
      const existing = this.db.raw
        .prepare(
          "SELECT session_id FROM sessions WHERE backend_session_id = ? AND server_epoch = ? AND session_id <> ?",
        )
        .get(binding.binding.backendSessionId, binding.binding.serverEpoch, sessionId);
      if (existing !== undefined) {
        throw new ZBridgeError("INVALID_ARGUMENT", "该后端会话已绑定到其它产品会话");
      }
    }
    this.db.raw
      .prepare(
        `UPDATE sessions
            SET backend_session_id = ?, server_epoch = ?, revision = revision + 1, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(
        binding.binding?.backendSessionId ?? null,
        binding.binding?.serverEpoch ?? null,
        at,
        sessionId,
      );
    return this.require(sessionId);
  }

  /** 只改占用状态；阻塞原因要由 block()/unblock() 单独维护。 */
  setState(sessionId: SessionId, state: SessionState, at: IsoTimestamp): SessionRecord {
    this.require(sessionId);
    this.db.raw
      .prepare("UPDATE sessions SET state = ?, revision = revision + 1, updated_at = ? WHERE session_id = ?")
      .run(state, at, sessionId);
    return this.require(sessionId);
  }

  /**
   * OC-08：会话记住最近一次**已受理**任务的选定模型；省略 model 的后续请求沿用。
   * 只在新受理事务里调用；幂等重放不得改写当前选择。
   */
  setLastSelectedModel(sessionId: SessionId, modelRef: string, at: IsoTimestamp): SessionRecord {
    this.require(sessionId);
    this.db.raw
      .prepare("UPDATE sessions SET last_selected_model = ?, revision = revision + 1, updated_at = ? WHERE session_id = ?")
      .run(modelRef, at, sessionId);
    return this.require(sessionId);
  }

  /** unknown 结果持久阻塞；没有显式的本地核对，不得自行解除。 */
  block(sessionId: SessionId, runId: string, reason: string, at: IsoTimestamp): SessionRecord {
    this.require(sessionId);
    this.db.raw
      .prepare(
        `UPDATE sessions
            SET state = 'unavailable', blocked_reason = ?, blocked_run_id = ?,
                blocked_at = ?, revision = revision + 1, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(reason, runId, at, at, sessionId);
    return this.require(sessionId);
  }

  /**
   * 本地核对后解除阻塞。只清存储标记，不做任何后端探活；
   * 恢复等级仍由 `recoveryVerification` 独立表达。
   */
  unblock(sessionId: SessionId, at: IsoTimestamp): SessionRecord {
    const session = this.require(sessionId);
    if (session.blockedReason === null) return session;
    this.db.raw
      .prepare(
        `UPDATE sessions
            SET blocked_reason = NULL, blocked_run_id = NULL, blocked_at = NULL,
                state = CASE WHEN state = 'unavailable' THEN 'idle' ELSE state END,
                revision = revision + 1, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(at, sessionId);
    return this.require(sessionId);
  }

  countActiveRuns(sessionId: SessionId): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM runs
          WHERE session_id = ? AND state NOT IN
            ('completed','failed','cancelled','interrupted','timed_out','unknown')`,
      )
      .get(sessionId);
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
