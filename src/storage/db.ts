/**
 * SQLite 连接与事务边界（技术规格 §4）。
 *
 * 只使用 Node 自带的 `node:sqlite`，不引入任何第三方驱动。两条约束在实现里
 * 刻意做成不可绕过：
 * 1. 事务必须显式 BEGIN/COMMIT/ROLLBACK；上层把「状态 + 事件 + 回执」放进同一个
 *    事务，任何一步失败都整体回滚，不留下半条业务状态。
 * 2. 嵌套调用使用 SAVEPOINT，而不是静默忽略内层事务。
 *    repository 可以安全地在 store 的事务中复用，不需要每个调用点判断层级。
 */
import { DatabaseSync } from "node:sqlite";
import { ZBridgeError } from "../contracts/errors.ts";

export interface DatabaseOpenOptions {
  /** 文件路径，或 `:memory:`。 */
  readonly path: string;
  /** SQLite 忙等上限；单进程访问时主要用于避免测试互相踩锁。 */
  readonly busyTimeoutMs?: number;
}

export class SqliteConnection {
  readonly raw: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  /** 以写锁开始事务：同一时刻只有一个写者，避免「先读后写」的竞态。 */
  transaction<T>(fn: () => T): T {
    if (this.closed) throw new ZBridgeError("DAEMON_UNAVAILABLE", "数据库已关闭");
    const nested = this.depth > 0;
    const savepoint = `zb_sp_${this.depth}`;
    if (nested) this.raw.exec(`SAVEPOINT ${savepoint}`);
    else this.raw.exec("BEGIN IMMEDIATE");
    this.depth += 1;

    try {
      const result = fn();
      if (nested) this.raw.exec(`RELEASE ${savepoint}`);
      else this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (nested) this.raw.exec(`ROLLBACK TO ${savepoint}`);
        if (nested) this.raw.exec(`RELEASE ${savepoint}`);
        else this.raw.exec("ROLLBACK");
      } catch {
        // 回滚失败时保留原始异常：它更能说明第一现场。
      }
      throw error;
    } finally {
      // COMMIT/RELEASE 本身失败时也必须恢复层级，否则下一次嵌套事务会以为还在事务中。
      this.depth -= 1;
    }
  }

  /**
   * 一致性只读事务。SQLite 在第一次读时建立快照；同一事务内的多次查询看到同一版本。
   * 已在写事务中时直接复用当前快照，不再开启新的读事务。
   */
  readTransaction<T>(fn: () => T): T {
    if (this.closed) throw new ZBridgeError("DAEMON_UNAVAILABLE", "数据库已关闭");
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN DEFERRED");
    this.depth += 1;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // 与写事务相同：保留原始异常。
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.depth > 0) throw new ZBridgeError("INVALID_ARGUMENT", "事务未结束时不能关闭数据库");
    this.closed = true;
    this.raw.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function openSqlite(options: DatabaseOpenOptions): SqliteConnection {
  const db = new DatabaseSync(options.path, {
    enableForeignKeyConstraints: true,
    timeout: options.busyTimeoutMs ?? 5_000,
  });
  // WAL 让「进程被杀后重开」不需要手工恢复；内存库会返回 memory，不报错。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  return new SqliteConnection(db);
}
