/**
 * dispatch intent 仓库。
 *
 * 记录一次发送尝试的完整证据链：prepared/possibly_sent → sent → confirmed，
 * 或 not_sent / unknown。`possibly_sent` 必须在调用外部发送**之前**提交，
 * 否则崩溃后会被误判为未派发而留下重发窗口。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { RunId, SessionId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableStr, str, type SqlRow } from "../rows.ts";
import type { DispatchIntent, DispatchPhase } from "../types.ts";

export interface InsertDispatchInput {
  readonly attemptId: string;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly backendSessionId: string;
  readonly serverEpoch: number;
  readonly at: IsoTimestamp;
}

function mapIntent(row: SqlRow): DispatchIntent {
  return {
    attemptId: str(row, "attempt_id"),
    runId: str(row, "run_id") as RunId,
    sessionId: str(row, "session_id") as SessionId,
    backendSessionId: str(row, "backend_session_id"),
    serverEpoch: num(row, "server_epoch"),
    backendMessageId: nullableStr(row, "backend_message_id"),
    phase: str(row, "phase") as DispatchPhase,
    preparedAt: str(row, "prepared_at"),
    possiblySentAt: str(row, "possibly_sent_at"),
    sentAt: nullableStr(row, "sent_at"),
    confirmedAt: nullableStr(row, "confirmed_at"),
    notSentAt: nullableStr(row, "not_sent_at"),
    unknownAt: nullableStr(row, "unknown_at"),
    detail: nullableStr(row, "detail"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export class DispatchRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  insert(input: InsertDispatchInput): DispatchIntent {
    this.db.raw
      .prepare(
        `INSERT INTO dispatch_intents
           (attempt_id, run_id, session_id, backend_session_id, server_epoch, backend_message_id,
            phase, prepared_at, possibly_sent_at, sent_at, confirmed_at, not_sent_at, unknown_at,
            detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'possibly_sent', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.attemptId,
        input.runId,
        input.sessionId,
        input.backendSessionId,
        input.serverEpoch,
        input.at,
        input.at,
        input.at,
        input.at,
      );
    return this.require(input.attemptId);
  }

  get(attemptId: string): DispatchIntent | null {
    const row = this.db.raw.prepare("SELECT * FROM dispatch_intents WHERE attempt_id = ?").get(attemptId);
    return row === undefined ? null : mapIntent(row as SqlRow);
  }

  require(attemptId: string): DispatchIntent {
    const intent = this.get(attemptId);
    if (intent === null) throw new Error("dispatch intent 不存在");
    return intent;
  }

  findByRun(runId: RunId): DispatchIntent | null {
    const row = this.db.raw.prepare("SELECT * FROM dispatch_intents WHERE run_id = ?").get(runId);
    return row === undefined ? null : mapIntent(row as SqlRow);
  }

  listOpen(): readonly DispatchIntent[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM dispatch_intents
          WHERE phase IN ('possibly_sent','sent','confirmed','unknown')
          ORDER BY created_at, attempt_id`,
      )
      .all();
    return rows.map((row) => mapIntent(row as SqlRow));
  }

  /** 只补记消息 ID，不改变阶段：用于「已生成 messageID、尚未收到受理」的窗口。 */
  setMessageId(attemptId: string, at: IsoTimestamp, backendMessageId: string): DispatchIntent {
    this.db.raw
      .prepare("UPDATE dispatch_intents SET backend_message_id = ?, updated_at = ? WHERE attempt_id = ?")
      .run(backendMessageId, at, attemptId);
    return this.require(attemptId);
  }

  markSent(attemptId: string, at: IsoTimestamp, backendMessageId: string | null): DispatchIntent {
    this.db.raw
      .prepare(
        `UPDATE dispatch_intents
            SET phase = 'sent', sent_at = ?, backend_message_id = COALESCE(?, backend_message_id),
                updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(at, backendMessageId, at, attemptId);
    return this.require(attemptId);
  }

  markConfirmed(attemptId: string, at: IsoTimestamp, backendMessageId: string): DispatchIntent {
    this.db.raw
      .prepare(
        `UPDATE dispatch_intents
            SET phase = 'confirmed', confirmed_at = ?, backend_message_id = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(at, backendMessageId, at, attemptId);
    return this.require(attemptId);
  }

  markNotSent(attemptId: string, at: IsoTimestamp, detail: string | null): DispatchIntent {
    this.db.raw
      .prepare(
        `UPDATE dispatch_intents
            SET phase = 'not_sent', not_sent_at = ?, detail = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(at, detail, at, attemptId);
    return this.require(attemptId);
  }

  markUnknown(attemptId: string, at: IsoTimestamp, detail: string | null): DispatchIntent {
    this.db.raw
      .prepare(
        `UPDATE dispatch_intents
            SET phase = 'unknown', unknown_at = ?, detail = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(at, detail, at, attemptId);
    return this.require(attemptId);
  }

  setDetail(attemptId: string, detail: string, at: IsoTimestamp): DispatchIntent {
    this.db.raw
      .prepare("UPDATE dispatch_intents SET detail = ?, updated_at = ? WHERE attempt_id = ?")
      .run(detail, at, attemptId);
    return this.require(attemptId);
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM dispatch_intents").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
