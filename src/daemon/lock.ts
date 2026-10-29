/**
 * 单实例锁（OC-04 §1）。
 *
 * 设计目标：任何时刻最多一个 daemon 持锁，且不误伤无关进程。
 *
 * - 排他创建用「写临时文件 + link()」：lock 文件要么不存在、要么内容完整，
 *   不存在「空文件窗口」让第二个实例误判；
 * - 锁内容带 nonce 与进程身份（`ps lstart`）：release/接管都先核对内容再动手，
 *   避免 A 释放时删掉 B 刚拿到的锁；
 * - PID 会复用：活 PID 缺少身份、或身份读不到 → 拒绝接管（宁可不动）；
 *   身份不符 = 旧持有者已死、PID 被占用 → 旧锁作废后重试排他创建；
 * - 接管用 link() 竞争而不是 unlink+create：即使两个实例同时接管，
 *   也只有一个 link 成功，另一个重新读锁再评估。
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ZBridgeError } from "../contracts/errors.ts";
import { processIdentity } from "../core/proc.ts";

export { processIdentity };

export interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
  readonly identity: string | null;
  readonly nonce: string;
}

const MAX_ACQUIRE_ATTEMPTS = 4;
const MAX_GUARD_ATTEMPTS = 4;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "EPERM";
  }
}

function parseLock(raw: string): LockContent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const pid = record["pid"];
    const startedAt = record["startedAt"];
    const nonce = record["nonce"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== "string" || typeof nonce !== "string" || nonce.length === 0) return null;
    const identity = record["identity"];
    return { pid, startedAt, nonce, identity: typeof identity === "string" ? identity : null };
  } catch {
    return null;
  }
}

export interface AcquireResult {
  readonly acquired: true;
  /** true 表示清掉了一个已确认死亡的旧实例的锁。 */
  readonly staleReclaimed: boolean;
}

export class InstanceLock {
  private readonly path: string;
  private heldNonce: string | null = null;

  constructor(path: string) {
    this.path = path;
  }

  get isHeld(): boolean {
    return this.heldNonce !== null;
  }

  /** 当前锁内容（他人写入的只读视图）；无锁或损坏返回 null。 */
  peek(): LockContent | null {
    try {
      return parseLock(readFileSync(this.path, "utf8"));
    } catch {
      return null;
    }
  }

  private selfContent(): LockContent {
    return {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      identity: processIdentity(process.pid),
      nonce: randomBytes(16).toString("hex"),
    };
  }

  private writeStaging(content: LockContent): string {
    const staging = `${this.path}.${process.pid}.${content.nonce}.tmp`;
    const handle = openSync(staging, "wx", 0o600);
    try {
      writeSync(handle, `${JSON.stringify(content)}\n`);
    } finally {
      closeSync(handle);
    }
    return staging;
  }

  /**
   * 获取锁。目录必须已存在且为 0700（由调用方准备）。
   *
   * 「评估陈旧 → unlink → link」整段由互斥守卫目录串行化：没有守卫时，
   * A 判定旧锁陈旧后、B 先回收并持锁、A 随后 unlink 会删掉 B 的活锁形成双实例
   * （已由 review-lock-race-root.mjs 真实复现）。守卫被活实例占用 → 立即拒绝
   * （不同步自旋，避免同线程/不同线程互相卡死）；守卫内容损坏/来源不明 →
   * 要求人工核对，绝不误删。
   */
  acquire(): AcquireResult {
    if (this.heldNonce !== null) return { acquired: true, staleReclaimed: false };
    const guardToken = this.enterGuard();
    if (guardToken === null) {
      throw new ZBridgeError("DAEMON_UNAVAILABLE", "另一实例正在获取锁（互斥守卫被占用）；请稍后重试启动");
    }
    try {
      let staleReclaimed = false;
      for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
        const content = this.selfContent();
        const staging = this.writeStaging(content);
        try {
          try {
            linkSync(staging, this.path);
            this.heldNonce = content.nonce;
            return { acquired: true, staleReclaimed };
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code !== "EEXIST") {
              throw new ZBridgeError("DAEMON_UNAVAILABLE", `锁创建失败: ${(error as Error).message}`);
            }
          }
        } finally {
          rmSync(staging, { force: true });
        }
        // link 失败：已有锁（守卫保证此刻没有其它接管者在评估/回收）。
        const verdict = this.evaluateExisting();
        if (verdict === "refuse") {
          throw new ZBridgeError("DAEMON_UNAVAILABLE", "已有 daemon 实例在运行或锁状态无法确认，拒绝启动");
        }
        if (verdict === "stale") {
          staleReclaimed = true;
          // 守卫互斥下，这个 unlink 只可能删掉「我们刚评估过的那份陈旧锁」。
          try {
            unlinkSync(this.path);
          } catch {
            // 已不存在：直接重试 link。
          }
          continue;
        }
        // verdict === "retry"：锁在读取/评估瞬间被释放（持有者正常退出）。
        // 重新 link 一次即可，不盲目 unlink。
        continue;
      }
      throw new ZBridgeError("DAEMON_UNAVAILABLE", "锁竞争多次未决，放弃启动（避免双实例）");
    } finally {
      this.exitGuard(guardToken);
    }
  }

  // ---------------------------------------------------------------- 互斥守卫

  private guardDir(): string {
    return `${this.path}.guard`;
  }

  /**
   * 以目录 mkdir 的原子性做短时互斥。成功返回本次守卫 nonce；
   * 被活实例占用返回 null（调用方拒绝启动）；守卫主人已死则回收后重试。
   * 内容损坏/来源不明 → 抛错要求人工核对，绝不误删。
   */
  private enterGuard(): string | null {
    const guard = this.guardDir();
    for (let attempt = 0; attempt < MAX_GUARD_ATTEMPTS; attempt += 1) {
      const nonce = randomBytes(12).toString("hex");
      try {
        mkdirSync(guard, { recursive: false, mode: 0o700 });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== "EEXIST") {
          throw new ZBridgeError("DAEMON_UNAVAILABLE", `互斥守卫创建失败: ${(error as Error).message}`);
        }
        // 已有守卫：核对主人身份。
        let owner: LockContent | null = null;
        try {
          owner = parseLock(readFileSync(join(guard, "owner.json"), "utf8"));
        } catch {
          owner = null;
        }
        if (owner === null) {
          throw new ZBridgeError(
            "DAEMON_UNAVAILABLE",
            `互斥守卫内容损坏或缺失（${guard}/owner.json），无法归因持有者；请人工核对后删除守卫目录`,
          );
        }
        const ownerAlive = isProcessAlive(owner.pid);
        const identityMatches =
          owner.identity !== null && owner.identity === processIdentity(owner.pid);
        if (ownerAlive && identityMatches) {
          // 守卫被活实例占用：不同步等待（可能同线程互相卡死），直接拒绝。
          return null;
        }
        if (ownerAlive && owner.identity !== null && !identityMatches) {
          // PID 已被其它程序复用：原守卫主人已死，可以回收。
        } else if (ownerAlive) {
          // 活着但身份读不到：宁可拒绝也不动。
          throw new ZBridgeError("DAEMON_UNAVAILABLE", "互斥守卫持有者仍在运行但身份不可读，拒绝接管；请人工核对");
        }
        rmSync(guard, { recursive: true, force: true });
        continue;
      }
      // mkdir 成功：立即写入身份，供并发方核对。
      const content: LockContent = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        identity: processIdentity(process.pid),
        nonce,
      };
      writeFileSync(join(guard, "owner.json"), `${JSON.stringify(content)}\n`, { mode: 0o600 });
      return nonce;
    }
    return null;
  }

  /** 释放守卫；只有内容仍是自己写入的那份（nonce 相符）才删除。 */
  private exitGuard(nonce: string): void {
    const guard = this.guardDir();
    let owner: LockContent | null = null;
    try {
      owner = parseLock(readFileSync(join(guard, "owner.json"), "utf8"));
    } catch {
      owner = null;
    }
    if (owner !== null && owner.nonce === nonce && owner.pid === process.pid) {
      try {
        rmSync(guard, { recursive: true, force: true });
      } catch {
        // 已被并发回收：以现状为准。
      }
    }
  }

  /**
   * 评估现有锁。
   * - "refuse"：有确认存活的实例，或状态无法证明旧持有者已死；
   * - "stale"：可以证明旧持有者已死（进程退出，或 PID 已被其它程序复用）；
   * - "retry"：读取竞态，重试评估。
   */
  private evaluateExisting(): "refuse" | "stale" | "retry" {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // 锁在读取瞬间被释放：重新 link 一次即可。
      return "retry";
    }
    const existing = parseLock(raw);
    if (existing === null) {
      // link() 写入是原子的；内容损坏说明锁文件被外部改过，无法归因持有者状态。
      // 保守拒绝，要求人工确认后删除——绝不在无法证明死亡时清锁。
      return "refuse";
    }
    const alive = isProcessAlive(existing.pid);
    if (!alive) return "stale";
    if (existing.identity === null) {
      // 活 PID 但没有身份记录：不能当作身份不符（可能就是旧实例）。
      return "refuse";
    }
    const current = processIdentity(existing.pid);
    if (current === null) {
      // PID 活着但身份读不到：无法确认是不是旧实例，宁可拒绝也不冒险。
      return "refuse";
    }
    if (current === existing.identity) return "refuse"; // 就是旧实例本身
    // PID 已被其它程序复用：旧持有者确定已死。
    return "stale";
  }

  /**
   * 释放锁。只有锁内容仍然是我们写入的那份（nonce + pid 都相符）才删除；
   * 内容被替换（我们的锁已作废/被接管）时不动别人的锁。
   */
  release(): void {
    const nonce = this.heldNonce;
    if (nonce === null) return;
    this.heldNonce = null;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const existing = parseLock(raw);
    if (existing !== null && existing.nonce === nonce && existing.pid === process.pid) {
      try {
        unlinkSync(this.path);
      } catch {
        // 已被并发接管：以现状为准，不强制。
      }
    }
  }
}

export function ensureDaemonDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mode 受 umask 影响；调用方（daemon.start）负责显式 chmodSync 0700 收紧。
}
