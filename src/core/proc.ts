/**
 * 后端中立的 OS 进程工具（OC-09 自 backend/opencode/worker.ts 迁出）。
 *
 * 这些函数只做 `ps`/`kill` 层面的观察与存活性判断，不含任何 OpenCode 语义；
 * worker 归属核对（ownership.ts）与各后端受管 worker 共用。`ps` 只用于归属
 * 与退出验证，不参与业务状态判断。
 */
import { spawnSync } from "node:child_process";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

export type ProcessTableRead =
  | { readonly ok: true; readonly rows: readonly ProcessInfo[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 读取进程表。必须区分「读到但为空」与「读不到」：后者不能当作「没有后代」，
 * 否则父进程一死就会错误地宣称 exited=true。
 */
export function readProcessTable(): ProcessTableRead {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5_000 });
  if (result.error !== undefined) return { ok: false, reason: `ps 执行失败：${result.error.name}` };
  if (result.status !== 0) return { ok: false, reason: `ps 退出码 ${String(result.status)}` };
  if (typeof result.stdout !== "string") return { ok: false, reason: "ps 没有输出" };
  const rows: ProcessInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, pgid: Number.isInteger(pgid) ? pgid : pid });
  }
  return { ok: true, rows };
}

/** 兼容包装：只需要行数据、读不到时返回空数组的调用方要自行承担不确定性。 */
export function listProcessTable(): readonly ProcessInfo[] {
  const read = readProcessTable();
  return read.ok ? read.rows : [];
}

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

/**
 * 读取进程启动时刻（`ps lstart`）。这是 worker_processes.process_identity
 * 的唯一格式：恢复时 verifyOwnership 用同一函数核对。null 表示读不到，
 * 不能当作「不符」。
 */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 属于该 worker 的进程集合：同进程组成员 + 以 worker 为根的后代。
 * 祖先（我们的父进程、其进程组）永远不会被选中。
 */
export function ownedProcesses(
  table: readonly ProcessInfo[],
  rootPid: number,
  rootPgid: number,
): readonly ProcessInfo[] {
  if (!Number.isInteger(rootPgid) || rootPgid <= 1) return [];
  const ownGroup = ownProcessGroupId(table);
  if (ownGroup !== null && rootPgid === ownGroup) return [];

  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row.pid]);
    else list.push(row.pid);
  }
  const selected = new Set<number>();
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      selected.add(child);
      queue.push(child);
    }
  }
  for (const row of table) {
    if (row.pgid === rootPgid && row.pid !== rootPid) selected.add(row.pid);
  }
  return table.filter((row) => selected.has(row.pid));
}

/** 当前进程自己的进程组；用于拒绝「杀掉自己所在的组」。 */
export function ownProcessGroupId(table: readonly ProcessInfo[]): number | null {
  const self = table.find((row) => row.pid === process.pid);
  return self === undefined ? null : self.pgid;
}

/** 该进程组里是否还有成员（父进程已被 reaped 时 `kill(pid,0)` 不再可靠）。 */
export function groupHasMembers(table: readonly ProcessInfo[], pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  return table.some((row) => row.pgid === pgid);
}
