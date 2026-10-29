/**
 * 请求回执仓库。
 *
 * 主键就是作用域：principalId + toolName + clientRequestId + serviceEpoch。
 * 参数哈希由服务端按规范化 JSON 计算，调用方传入的 requestHash 不被信任。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { SqliteConnection } from "../db.ts";
import { num, str, type SqlRow } from "../rows.ts";
import type { RequestReceipt } from "../types.ts";

export interface ReceiptKey {
  readonly principalId: string;
  readonly toolName: string;
  readonly clientRequestId: string;
  readonly serviceEpoch: number;
}

function mapReceipt(row: SqlRow): RequestReceipt {
  return {
    principalId: str(row, "principal_id"),
    toolName: str(row, "tool_name"),
    clientRequestId: str(row, "client_request_id"),
    serviceEpoch: num(row, "service_epoch"),
    requestHash: str(row, "request_hash"),
    runId: str(row, "run_id") as RunId,
    createdAt: str(row, "created_at"),
  };
}

export class ReceiptRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  get(key: ReceiptKey): RequestReceipt | null {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM request_receipts
          WHERE principal_id = ? AND tool_name = ? AND client_request_id = ? AND service_epoch = ?`,
      )
      .get(key.principalId, key.toolName, key.clientRequestId, key.serviceEpoch);
    return row === undefined ? null : mapReceipt(row as SqlRow);
  }

  /**
   * 跨代际查找同一 clientRequestId 的既有回执（OC-04）。
   *
   * daemon 重启后 serviceEpoch 变化，重试方只拿得到 clientRequestId；
   * 幂等要求重试沿用原 run（原期限、原回执），不能因为换代就再次执行。
   */
  findLatestByClientRequest(principalId: string, toolName: string, clientRequestId: string): RequestReceipt | null {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM request_receipts
          WHERE principal_id = ? AND tool_name = ? AND client_request_id = ?
          ORDER BY service_epoch DESC LIMIT 1`,
      )
      .get(principalId, toolName, clientRequestId);
    return row === undefined ? null : mapReceipt(row as SqlRow);
  }

  insert(key: ReceiptKey, requestHash: string, runId: RunId, at: IsoTimestamp): RequestReceipt {
    this.db.raw
      .prepare(
        `INSERT INTO request_receipts
           (principal_id, tool_name, client_request_id, service_epoch, request_hash, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key.principalId, key.toolName, key.clientRequestId, key.serviceEpoch, requestHash, runId, at);
    const receipt = this.get(key);
    if (receipt === null) throw new Error("回执写入后无法读回");
    return receipt;
  }

  listByRun(runId: RunId): readonly RequestReceipt[] {
    const rows = this.db.raw.prepare("SELECT * FROM request_receipts WHERE run_id = ?").all(runId);
    return rows.map((row) => mapReceipt(row as SqlRow));
  }

  count(): number {
    const row = this.db.raw.prepare("SELECT COUNT(*) AS n FROM request_receipts").get();
    return row === undefined ? 0 : num(row as SqlRow, "n");
  }
}
