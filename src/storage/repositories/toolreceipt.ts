/**
 * 停止类工具（agent_interrupt／agent_cancel／agent_close）的幂等回执仓库。
 *
 * 与 `request_receipts`（agent_start 受理）的区别：这里还保存**原响应 JSON**，
 * 同 key 重试在 run revision 已经变化之后仍重放原响应，而不是重新求值。
 * 表结构见 migration v3。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import type { SqliteConnection } from "../db.ts";
import { num, str, type SqlRow } from "../rows.ts";

export interface ToolReceipt {
  readonly principalId: string;
  readonly toolName: string;
  readonly clientRequestId: string;
  readonly serviceEpoch: number;
  readonly requestHash: string;
  readonly targetId: string;
  readonly responseJson: string;
  readonly createdAt: IsoTimestamp;
}

function mapReceipt(row: SqlRow): ToolReceipt {
  return {
    principalId: str(row, "principal_id"),
    toolName: str(row, "tool_name"),
    clientRequestId: str(row, "client_request_id"),
    serviceEpoch: num(row, "service_epoch"),
    requestHash: str(row, "request_hash"),
    targetId: str(row, "target_id"),
    responseJson: str(row, "response_json"),
    createdAt: str(row, "created_at"),
  };
}

export interface InsertToolReceiptInput {
  readonly principalId: string;
  readonly toolName: string;
  readonly clientRequestId: string;
  readonly serviceEpoch: number;
  readonly requestHash: string;
  readonly targetId: string;
  readonly responseJson: string;
  readonly at: IsoTimestamp;
}

export class ToolReceiptRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  /** 精确按四元组主键取回执（同 epoch 重试）。 */
  get(principalId: string, toolName: string, clientRequestId: string, serviceEpoch: number): ToolReceipt | null {
    const row = this.db.raw
      .prepare(
        "SELECT * FROM tool_receipts WHERE principal_id = ? AND tool_name = ? AND client_request_id = ? AND service_epoch = ?",
      )
      .get(principalId, toolName, clientRequestId, serviceEpoch);
    return row === undefined ? null : mapReceipt(row as SqlRow);
  }

  /**
   * 跨代际取同 key 最近一次回执：daemon 重启后 serviceEpoch 已变，
   * 重试方只有 clientRequestId；幂等要求重放原响应，不重新求值。
   */
  findLatest(principalId: string, toolName: string, clientRequestId: string): ToolReceipt | null {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM tool_receipts
          WHERE principal_id = ? AND tool_name = ? AND client_request_id = ?
          ORDER BY created_at DESC, service_epoch DESC LIMIT 1`,
      )
      .get(principalId, toolName, clientRequestId);
    return row === undefined ? null : mapReceipt(row as SqlRow);
  }

  insert(input: InsertToolReceiptInput): ToolReceipt {
    this.db.raw
      .prepare(
        `INSERT INTO tool_receipts
           (principal_id, tool_name, client_request_id, service_epoch, request_hash, target_id, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.principalId,
        input.toolName,
        input.clientRequestId,
        input.serviceEpoch,
        input.requestHash,
        input.targetId,
        input.responseJson,
        input.at,
      );
    const receipt = this.get(
      input.principalId,
      input.toolName,
      input.clientRequestId,
      input.serviceEpoch,
    );
    if (receipt === null) throw new Error("tool_receipts 写入后无法读回");
    return receipt;
  }
}
