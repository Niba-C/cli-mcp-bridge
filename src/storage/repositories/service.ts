/**
 * 服务代际仓库。
 *
 * 两个计数器刻意分开：
 * - serviceEpoch：产品 daemon 每次启动的代际；绑定 clientRequestId 回执作用域。
 * - serverEpoch：由 daemon 启动的 OpenCode worker 每次启动的代际；绑定后端会话、
 *   dispatch intent 与审批。
 * 它们各自单调递增、永不回退或复用。数值相同不表示同一层代际。
 */
import type { IsoTimestamp } from "../../contracts/common.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import type { BackendId } from "../../contracts/version.ts";
import type { SqliteConnection } from "../db.ts";
import { num, nullableNum, nullableStr, str, type SqlRow } from "../rows.ts";
import type { ServerInstance, ServiceInstance } from "../types.ts";

function mapService(row: SqlRow): ServiceInstance {
  return {
    serviceEpoch: num(row, "service_epoch"),
    status: str(row, "status") as ServiceInstance["status"],
    pid: nullableNum(row, "pid"),
    startedAt: str(row, "started_at"),
    endedAt: nullableStr(row, "ended_at"),
    createdAt: str(row, "created_at"),
  };
}

function mapServer(row: SqlRow): ServerInstance {
  return {
    serverEpoch: num(row, "server_epoch"),
    serviceEpoch: num(row, "service_epoch"),
    backendId: str(row, "backend_id") as ServerInstance["backendId"],
    status: str(row, "status") as ServerInstance["status"],
    pid: nullableNum(row, "pid"),
    runDir: nullableStr(row, "run_dir"),
    backendVersion: nullableStr(row, "backend_version"),
    startedAt: str(row, "started_at"),
    endedAt: nullableStr(row, "ended_at"),
    createdAt: str(row, "created_at"),
  };
}

export interface BeginServiceInput {
  readonly pid?: number | null;
  readonly at: IsoTimestamp;
}

export interface BeginServerInput {
  readonly serviceEpoch: number;
  /** OC-09：该运行时归属的后端；省略时按历史行为登记 opencode。 */
  readonly backendId?: BackendId;
  readonly pid?: number | null;
  readonly runDir?: string | null;
  readonly backendVersion?: string | null;
  readonly at: IsoTimestamp;
}

export class ServiceRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = db;
  }

  private nextCounter(name: "service_epoch" | "server_epoch"): number {
    const row = this.db.raw
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .get(name);
    if (row === undefined) throw new ZBridgeError("INVALID_ARGUMENT", "代际计数器更新失败");
    return num(row as SqlRow, "value");
  }

  /** 新服务代际：先把旧的 active 服务标为 stopped，再分配新号。 */
  beginService(input: BeginServiceInput): ServiceInstance {
    return this.db.transaction(() => {
      this.db.raw
        .prepare("UPDATE service_instances SET status = 'stopped', ended_at = ? WHERE status = 'active'")
        .run(input.at);
      const serviceEpoch = this.nextCounter("service_epoch");
      this.db.raw
        .prepare(
          `INSERT INTO service_instances
             (service_epoch, status, pid, started_at, ended_at, created_at)
           VALUES (?, 'active', ?, ?, NULL, ?)`,
        )
        .run(serviceEpoch, input.pid ?? null, input.at, input.at);
      return this.requireService(serviceEpoch);
    });
  }

  /** 新 worker 代际：必须属于当前 active 的产品服务，号段独立递增。 */
  beginServer(input: BeginServerInput): ServerInstance {
    return this.db.transaction(() => {
      const service = this.getService(input.serviceEpoch);
      if (service === null) {
        throw new ZBridgeError("EPOCH_MISMATCH", "serverEpoch 必须归属一个已存在的 serviceEpoch", {
          details: { serviceEpoch: input.serviceEpoch },
        });
      }
      if (service.status !== "active") {
        throw new ZBridgeError("EPOCH_MISMATCH", "不能为已停止的服务代际启动 worker", {
          details: { serviceEpoch: input.serviceEpoch, status: service.status },
        });
      }
      const serverEpoch = this.nextCounter("server_epoch");
      this.db.raw
        .prepare(
          `INSERT INTO server_instances
             (server_epoch, service_epoch, backend_id, status, pid, run_dir, backend_version,
              started_at, ended_at, created_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          serverEpoch,
          input.serviceEpoch,
          input.backendId ?? "opencode",
          input.pid ?? null,
          input.runDir ?? null,
          input.backendVersion ?? null,
          input.at,
          input.at,
        );
      return this.requireServer(serverEpoch);
    });
  }

  stopServer(serverEpoch: number, at: IsoTimestamp, status: "stopped" | "crashed" = "stopped"): ServerInstance {
    const result = this.db.raw
      .prepare("UPDATE server_instances SET status = ?, ended_at = ? WHERE server_epoch = ?")
      .run(status, at, serverEpoch);
    if (Number(result.changes) === 0) throw new ZBridgeError("NOT_FOUND", "server instance 不存在");
    return this.requireServer(serverEpoch);
  }

  getService(serviceEpoch: number): ServiceInstance | null {
    const row = this.db.raw
      .prepare("SELECT * FROM service_instances WHERE service_epoch = ?")
      .get(serviceEpoch);
    return row === undefined ? null : mapService(row as SqlRow);
  }

  requireService(serviceEpoch: number): ServiceInstance {
    const service = this.getService(serviceEpoch);
    if (service === null) throw new ZBridgeError("NOT_FOUND", "service instance 不存在");
    return service;
  }

  getServer(serverEpoch: number): ServerInstance | null {
    const row = this.db.raw
      .prepare("SELECT * FROM server_instances WHERE server_epoch = ?")
      .get(serverEpoch);
    return row === undefined ? null : mapServer(row as SqlRow);
  }

  requireServer(serverEpoch: number): ServerInstance {
    const server = this.getServer(serverEpoch);
    if (server === null) throw new ZBridgeError("NOT_FOUND", "server instance 不存在");
    return server;
  }

  currentService(): ServiceInstance | null {
    const row = this.db.raw
      .prepare("SELECT * FROM service_instances WHERE status = 'active' ORDER BY service_epoch DESC LIMIT 1")
      .get();
    return row === undefined ? null : mapService(row as SqlRow);
  }

  currentServiceEpoch(): number | null {
    return this.currentService()?.serviceEpoch ?? null;
  }

  /** 绑定与派发前必须确认 worker 代际仍属于当前 active 服务。 */
  requireActiveServer(serverEpoch: number): ServerInstance {
    const server = this.requireServer(serverEpoch);
    if (server.status !== "active") {
      throw new ZBridgeError("EPOCH_MISMATCH", "serverEpoch 已失效，不能继续使用", {
        details: { serverEpoch, status: server.status },
      });
    }
    const service = this.requireService(server.serviceEpoch);
    if (service.status !== "active") {
      throw new ZBridgeError("EPOCH_MISMATCH", "worker 所属的产品服务代际已失效", {
        details: { serverEpoch, serviceEpoch: server.serviceEpoch },
      });
    }
    return server;
  }

  listServers(serviceEpoch: number): readonly ServerInstance[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM server_instances WHERE service_epoch = ? ORDER BY server_epoch")
      .all(serviceEpoch);
    return rows.map((row) => mapServer(row as SqlRow));
  }
}
