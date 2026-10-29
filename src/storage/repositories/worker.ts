/**
 * worker 归属仓库（OC-04）。
 *
 * daemon 启动的每个 OpenCode worker 在这里留下可跨进程崩溃存活的身份证据：
 * PID 只是线索，`process_identity`（`ps lstart` 串）才是「还是当初那个进程」的判据。
 * 恢复时对确认归属的遗留 worker 才允许有界回收；证据不足一律 unknown，不能凭 PID 杀进程。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { BackendId } from "../../contracts/version.ts";
import type { SqliteConnection } from "../db.ts";
import { nullableStr, num, str, type SqlRow } from "../rows.ts";

export type WorkerProcessStatus = "active" | "stopped" | "crashed" | "unknown";

/** 后代观察记录：PID 本身会被复用，必须同时保存观察时刻的 lstart 身份。 */
export interface DescendantObservation {
  readonly pid: number;
  /** 观察时刻的 `ps lstart` 串；null 表示当时读不到，恢复时按无法核对处理。 */
  readonly identity: string | null;
}

export interface WorkerProcessRecord {
  readonly serverEpoch: number;
  readonly serviceEpoch: number;
  /** OC-09：该 worker 归属的后端；回收身份核对只作用于同后端运行时。 */
  readonly backendId: BackendId;
  readonly pid: number;
  readonly pgid: number;
  /** spawn 后立即采集的 `ps -p PID -o lstart=` 串；null 表示当时未采集到。 */
  readonly processIdentity: string | null;
  readonly executable: string;
  readonly runDir: string;
  /** 执行期间观察到的后代（含身份）；用于父进程死后逐个核对幸存者。 */
  readonly descendants: readonly DescendantObservation[];
  readonly status: WorkerProcessStatus;
  readonly note: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RecordWorkerInput {
  readonly serverEpoch: number;
  readonly serviceEpoch: number;
  /** OC-09：worker 归属后端；省略时按历史行为登记 opencode。 */
  readonly backendId?: BackendId;
  readonly pid: number;
  readonly pgid: number;
  readonly processIdentity: string | null;
  readonly executable: string;
  readonly runDir: string;
  readonly at: IsoTimestamp;
}

function mapWorker(row: SqlRow): WorkerProcessRecord {
  let descendants: readonly DescendantObservation[] = [];
  try {
    const parsed: unknown = JSON.parse(str(row, "descendants"));
    if (Array.isArray(parsed)) {
      descendants = parsed
        .map((item): DescendantObservation | null => {
          if (item === null || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          const pid = record["pid"];
          if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
          const identity = record["identity"];
          return { pid, identity: typeof identity === "string" ? identity : null };
        })
        .filter((item): item is DescendantObservation => item !== null);
    }
  } catch {
    descendants = [];
  }
  return {
    serverEpoch: num(row, "server_epoch"),
    serviceEpoch: num(row, "service_epoch"),
    backendId: str(row, "backend_id") as BackendId,
    pid: num(row, "pid"),
    pgid: num(row, "pgid"),
    processIdentity: nullableStr(row, "process_identity"),
    executable: str(row, "executable"),
    runDir: str(row, "run_dir"),
    descendants,
    status: str(row, "status") as WorkerProcessStatus,
    note: nullableStr(row, "note"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export class WorkerProcessRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  record(input: RecordWorkerInput): WorkerProcessRecord {
    if (!Number.isInteger(input.pid) || input.pid <= 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "worker pid 非法，拒绝记录");
    }
    if (!Number.isInteger(input.pgid) || input.pgid <= 1) {
      throw new ZBridgeError("INVALID_ARGUMENT", "worker pgid 非法，拒绝记录");
    }
    this.db.raw
      .prepare(
        `INSERT INTO worker_processes
           (server_epoch, service_epoch, backend_id, pid, pgid, process_identity, executable, run_dir,
            descendants, status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'active', NULL, ?, ?)`,
      )
      .run(
        input.serverEpoch,
        input.serviceEpoch,
        input.backendId ?? "opencode",
        input.pid,
        input.pgid,
        input.processIdentity,
        input.executable,
        input.runDir,
        input.at,
        input.at,
      );
    return this.require(input.serverEpoch);
  }

  get(serverEpoch: number): WorkerProcessRecord | null {
    const row = this.db.raw.prepare("SELECT * FROM worker_processes WHERE server_epoch = ?").get(serverEpoch);
    return row === undefined ? null : mapWorker(row as SqlRow);
  }

  require(serverEpoch: number): WorkerProcessRecord {
    const worker = this.get(serverEpoch);
    if (worker === null) throw new ZBridgeError("NOT_FOUND", "worker 记录不存在");
    return worker;
  }

  listByStatus(status: WorkerProcessStatus): readonly WorkerProcessRecord[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM worker_processes WHERE status = ? ORDER BY server_epoch")
      .all(status);
    return rows.map((row) => mapWorker(row as SqlRow));
  }

  list(): readonly WorkerProcessRecord[] {
    const rows = this.db.raw.prepare("SELECT * FROM worker_processes ORDER BY server_epoch").all();
    return rows.map((row) => mapWorker(row as SqlRow));
  }

  setDescendants(serverEpoch: number, descendants: readonly DescendantObservation[], at: IsoTimestamp): WorkerProcessRecord {
    const bounded = (() => {
      const seen = new Set<number>();
      const out: DescendantObservation[] = [];
      for (const entry of descendants) {
        if (!Number.isInteger(entry.pid) || entry.pid <= 0 || seen.has(entry.pid)) continue;
        seen.add(entry.pid);
        out.push({ pid: entry.pid, identity: entry.identity });
        if (out.length >= 256) break;
      }
      return out;
    })();
    const result = this.db.raw
      .prepare("UPDATE worker_processes SET descendants = ?, updated_at = ? WHERE server_epoch = ?")
      .run(JSON.stringify(bounded), at, serverEpoch);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "worker 记录不存在");
    return this.require(serverEpoch);
  }

  setStatus(
    serverEpoch: number,
    status: WorkerProcessStatus,
    at: IsoTimestamp,
    note?: string | null,
  ): WorkerProcessRecord {
    const trimmed = note === undefined || note === null ? null : note.slice(0, 512);
    const result = this.db.raw
      .prepare("UPDATE worker_processes SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE server_epoch = ?")
      .run(status, trimmed, at, serverEpoch);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "worker 记录不存在");
    return this.require(serverEpoch);
  }
}
