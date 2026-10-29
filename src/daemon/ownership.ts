/**
 * worker 所有权与遗留进程回收（OC-04 §6，技术规格 §7）。
 *
 * 硬规则（复核修正后）：
 * - 只有「PID 活着 **且** `ps lstart` 身份与登记一致」的进程才允许发信号；
 * - 身份不符（PID 复用）、身份缺失、进程表读不到 → 一律**不发信号**，置 unknown；
 * - 父 worker 已死但进程组仍有成员：组号可能已被复用，**不按组发信号**；
 *   只对「曾记录且身份核对一致」的后代逐个补刀；
 * - 记录在案的后代也必须逐个核对身份：身份不符 = 原进程已结束（PID 被占用），
 *   不动新占用者；身份读不到 = 无法确认原工具是否结束 → unknown；
 * - confirmedStopped 只有在「全部记录进程都可证明已结束/被我们自己停止」时才为 true。
 *
 * 测试注入：signalGroup/signalPid 可注入记录器，测试**绝不**向真实无关进程发信号。
 */
import { groupHasMembers, isProcessAlive, processIdentity, readProcessTable, type ProcessTableRead } from "../core/proc.ts";
import type { WorkerProcessRecord } from "../storage/index.ts";

export { processIdentity };

export type OwnershipVerdict =
  | { readonly kind: "confirmed"; readonly pid: number; readonly pgid: number }
  /** PID 活着但身份不符：原进程已结束，当前占用者与我们无关，绝不触碰。 */
  | { readonly kind: "pid_reused"; readonly pid: number }
  | { readonly kind: "process_dead"; readonly pid: number }
  /** PID 活着但身份读不到：无法确认是不是旧进程。 */
  | { readonly kind: "unreadable"; readonly pid: number };

/**
 * 判定一条 worker 记录指向的进程现在是否仍是我们启动的那个。
 * identity 为 null 的记录（当时没采集到）按 unreadable 保守处理。
 */
export function verifyOwnership(
  record: Pick<WorkerProcessRecord, "pid" | "pgid" | "processIdentity">,
  identityOf: (pid: number) => string | null = processIdentity,
  isAlive: (pid: number) => boolean = isProcessAlive,
): OwnershipVerdict {
  const pid = record.pid;
  if (!isAlive(pid)) return { kind: "process_dead", pid };
  const current = identityOf(pid);
  if (record.processIdentity === null || current === null) return { kind: "unreadable", pid };
  if (current !== record.processIdentity) return { kind: "pid_reused", pid };
  return { kind: "confirmed", pid, pgid: record.pgid };
}

export interface ReclaimResult {
  /** 是否发出了任何信号（只对身份确认的进程发出）。 */
  readonly attempted: boolean;
  /** 只有「进程表可读 + 所有已记录进程可证明结束」才为 true。 */
  readonly confirmedStopped: boolean;
  readonly survivors: readonly number[];
  readonly detail: string;
}

export type SignalFn = (target: number, signal: "SIGTERM" | "SIGKILL") => void;

export interface ReclaimOptions {
  /** 供离线测试注入；生产固定 readProcessTable()。 */
  readonly readTable?: () => ProcessTableRead;
  readonly identityOf?: (pid: number) => string | null;
  /** 供离线测试注入存活判断；生产固定 isProcessAlive()。 */
  readonly isAlive?: (pid: number) => boolean;
  readonly signalPid?: SignalFn;
  readonly signalGroup?: SignalFn;
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACE_MS = 3_000;

function defaultSignalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ESRCH") throw error;
  }
}

function defaultSignalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ESRCH") throw error;
  }
}

/**
 * 有界回收一条 worker 记录。只对身份确认的进程发信号：
 * - 主 worker 身份确认且存活：SIGTERM → 宽限 → SIGKILL（进程组属于它，组信号安全）；
 * - 主 worker 已死或 PID 复用：绝不按组发信号；
 * - 已记录后代：逐个身份核对，确认是我们启动的才补刀；
 * - 任何「活着但无法归因」的记录 → confirmedStopped=false（unknown）。
 */
export async function reclaimWorkerRecord(
  record: Pick<WorkerProcessRecord, "pid" | "pgid" | "processIdentity" | "descendants">,
  options: ReclaimOptions = {},
): Promise<ReclaimResult> {
  const readTable = options.readTable ?? readProcessTable;
  const identityOf = options.identityOf ?? processIdentity;
  const alive = options.isAlive ?? isProcessAlive;
  const signalPid = options.signalPid ?? defaultSignalPid;
  const signalGroup = options.signalGroup ?? defaultSignalGroup;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  // 进程表读不到：不沿用任何内存假设，一个信号都不发。
  const firstTable = readTable();
  if (!firstTable.ok) {
    return {
      attempted: false,
      confirmedStopped: false,
      survivors: [],
      detail: `进程表不可读（${firstTable.reason}）：不向任何进程发信号，按 unknown 处理`,
    };
  }

  let attempted = false;
  const details: string[] = [];

  // ---- 主 worker ----
  const verdict = verifyOwnership(record, identityOf, alive);
  const mainPid = record.pid;
  if (verdict.kind === "confirmed") {
    // 组长身份确认且存活：它的进程组只可能是它自己的后代（无关进程无法加入别人的组）。
    // 额外防线：绝不对自己所在的进程组发信号。
    const ownRow = firstTable.rows.find((row) => row.pid === process.pid);
    if (ownRow !== undefined && ownRow.pgid === record.pgid) {
      return {
        attempted: false,
        confirmedStopped: false,
        survivors: [mainPid],
        detail: "记录的进程组与当前进程组相同，拒绝发信号，按 unknown 处理",
      };
    }
    attempted = true;
    signalGroup(record.pgid, "SIGTERM");
    const deadline = now() + graceMs;
    while (now() < deadline && alive(mainPid)) {
      await sleep(50);
    }
    if (alive(mainPid)) {
      signalGroup(record.pgid, "SIGKILL");
      await sleep(Math.min(1_000, graceMs));
    }
    details.push(alive(mainPid) ? "主 worker 回收后仍存活" : "主 worker（身份确认）已停止");
  } else if (verdict.kind === "process_dead") {
    details.push("主 worker 进程已退出");
  } else if (verdict.kind === "pid_reused") {
    details.push("主 worker 的 PID 已被其它程序占用（原进程已结束）；不触碰占用者");
  } else {
    return {
      attempted: false,
      confirmedStopped: false,
      survivors: [mainPid],
      detail: "主 worker 活着但身份不可读：不发信号，按 unknown 处理",
    };
  }

  // ---- 已记录后代：逐个身份核对 ----
  const unresolved: number[] = [];
  const survivors: number[] = [];
  for (const entry of record.descendants) {
    if (!alive(entry.pid)) continue; // 已结束
    const current = identityOf(entry.pid);
    if (entry.identity !== null && current === entry.identity) {
      // 确认是我们观察过的那个后代：逐个补刀（不按组，避免误伤）。
      attempted = true;
      signalPid(entry.pid, "SIGKILL");
      if (alive(entry.pid)) {
        await sleep(Math.min(1_000, graceMs));
      }
      if (alive(entry.pid)) {
        unresolved.push(entry.pid);
      }
      continue;
    }
    if (current === null) {
      // 活着但身份读不到：无法确认是不是原工具进程。
      unresolved.push(entry.pid);
      details.push(`后代 ${entry.pid} 身份不可读，无法确认是否为原工具进程`);
      continue;
    }
    // 身份不符：原进程已结束，当前占用者是无关进程，不动。
    details.push(`后代 ${entry.pid} 的 PID 已被复用，原进程视为已结束`);
  }

  // ---- 组残留核对 ----
  const finalTable = readTable();
  if (!finalTable.ok) {
    return {
      attempted,
      confirmedStopped: false,
      survivors: [...new Set([...unresolved, mainPid].filter((pid) => alive(pid)))],
      detail: `回收动作已执行，但进程表随后不可读（${finalTable.reason}）；无法确认全部退出`,
    };
  }
  const groupStillVisible = groupHasMembers(finalTable.rows, record.pgid);
  if (verdict.kind === "confirmed") {
    // 组长身份确认过，组里任何残留成员都是它的后代（或已在上面处理）。
    if (groupStillVisible) {
      const groupRows = finalTable.rows.filter((row) => row.pgid === record.pgid);
      for (const row of groupRows) {
        if (!unresolved.includes(row.pid)) unresolved.push(row.pid);
      }
      details.push(`进程组仍有 ${groupRows.length} 个成员无法确认结束`);
    }
  } else if (groupStillVisible) {
    // 主 worker 已死/被复用：组号归属无法证明，残留成员不可归因 → unknown。
    const groupRows = finalTable.rows.filter((row) => row.pgid === record.pgid);
    for (const row of groupRows) {
      if (!unresolved.includes(row.pid)) unresolved.push(row.pid);
    }
    details.push("主 worker 不在（或 PID 已复用）但原组号仍有成员：无法归因，不发信号");
  }

  const aliveSurvivors = [...new Set(unresolved)].filter((pid) => alive(pid));
  const mainSettled = !alive(mainPid) || verdict.kind === "pid_reused";
  const confirmedStopped = mainSettled && aliveSurvivors.length === 0;
  if (aliveSurvivors.length > 0) survivors.push(...aliveSurvivors);
  return {
    attempted,
    confirmedStopped,
    survivors,
    detail: details.length > 0 ? details.join("; ") : "所有已记录进程均可证明已结束",
  };
}
