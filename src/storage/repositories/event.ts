/**
 * 业务事件仓库。
 *
 * 事件只由 store 在状态迁移事务里写入；`seq === revision` 由表级 CHECK 再兜底一次。
 * 读取只查数据库，不触发任何后端操作。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { EventType, RunEvent, RunState } from "../../contracts/index.ts";
import { toJsonValue } from "../../contracts/json.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableStr, str, type SqlRow } from "../rows.ts";

export type EventPayload = Readonly<Record<string, string | number | boolean | null>>;

function mapEvent(row: SqlRow): RunEvent {
  const payloadRaw: unknown = JSON.parse(str(row, "payload"));
  const payload =
    payloadRaw !== null && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
      ? (payloadRaw as Record<string, string | number | boolean | null>)
      : {};
  const state = nullableStr(row, "state") as RunState | null;
  const base = {
    runId: str(row, "run_id") as RunId,
    seq: num(row, "seq"),
    revision: num(row, "revision"),
    type: str(row, "type") as EventType,
    at: str(row, "at"),
    payload,
  };
  return state === null ? base : { ...base, state };
}

export class EventRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  insert(input: {
    runId: RunId;
    seq: number;
    type: EventType;
    at: IsoTimestamp;
    payload: EventPayload;
    state: RunState | null;
  }): RunEvent {
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "event.seq 必须是 ≥1 的整数");
    }
    const payload = JSON.stringify(toJsonValue(input.payload));
    this.db.raw
      .prepare("INSERT INTO run_events (run_id, seq, revision, type, at, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.runId, input.seq, input.seq, input.type, input.at, input.state, payload);
    const row = this.db.raw
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq = ?")
      .get(input.runId, input.seq);
    if (row === undefined) throw new ZBridgeError("INVALID_ARGUMENT", "事件写入后无法读回");
    return mapEvent(row as SqlRow);
  }

  list(runId: RunId, afterSeq: number, limit: number): readonly RunEvent[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(runId, afterSeq, limit + 1);
    return rows.map((row) => mapEvent(row as SqlRow));
  }

  get(runId: RunId, seq: number): RunEvent | null {
    const row = this.db.raw.prepare("SELECT * FROM run_events WHERE run_id = ? AND seq = ?").get(runId, seq);
    return row === undefined ? null : mapEvent(row as SqlRow);
  }

  maxSeq(runId: RunId): number {
    const row = this.db.raw.prepare("SELECT MAX(seq) AS n FROM run_events WHERE run_id = ?").get(runId);
    return row === undefined || row["n"] === null ? 0 : num(row as SqlRow, "n");
  }

  count(runId: RunId): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?").get(runId);
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }

  /** 保留策略只删旧事件并抬高 earliest_seq；revision 水位不回退。 */
  deleteThrough(runId: RunId, throughSeq: number): number {
    const result = this.db.raw
      .prepare("DELETE FROM run_events WHERE run_id = ? AND seq <= ?")
      .run(runId, throughSeq);
    return Number(result.changes);
  }
}
