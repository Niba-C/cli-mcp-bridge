import assert from "node:assert/strict";
import { test } from "node:test";
import { reclaimWorkerRecord, verifyOwnership } from "../../src/daemon/ownership.ts";
import type { ProcessInfo, ProcessTableRead } from "../../src/backend/opencode/worker.ts";

function table(rows: ProcessInfo[]): ProcessTableRead {
  return { ok: true, rows };
}

function row(pid: number, ppid: number, pgid: number): ProcessInfo {
  return { pid, ppid, pgid };
}

interface SignalLog {
  readonly targets: Array<{ target: number; signal: string; via: "pid" | "group" }>;
  signalPid(target: number, signal: "SIGTERM" | "SIGKILL"): void;
  signalGroup(target: number, signal: "SIGTERM" | "SIGKILL"): void;
}

function makeSignalLog(): SignalLog {
  const targets: Array<{ target: number; signal: string; via: "pid" | "group" }> = [];
  return {
    targets,
    signalPid(target, signal) {
      targets.push({ target, signal, via: "pid" });
    },
    signalGroup(target, signal) {
      targets.push({ target, signal, via: "group" });
    },
  };
}

const BASE = { graceMs: 40, now: (() => Date.now()) as () => number, sleep: () => Promise.resolve() };

test("主 worker 身份确认存活：组信号允许，只发给 worker 组", async () => {
  const log = makeSignalLog();
  const alive = new Set([4100, 4200, process.pid]);
  const result = await reclaimWorkerRecord(
    { pid: 4100, pgid: 4100, processIdentity: "worker-lstart", descendants: [{ pid: 4200, identity: "child-lstart" }] },
    {
      ...BASE,
      identityOf: (pid) => (pid === 4100 ? "worker-lstart" : pid === 4200 ? "child-lstart" : null),
      isAlive: (pid) => alive.has(pid),
      readTable: () => table([row(4100, 1, 4100), row(4200, 4100, 4100), row(process.pid, 1, process.pid)]),
      signalPid: (target, signal) => {
        log.signalPid(target, signal);
        alive.delete(target);
      },
      signalGroup: (target, signal) => {
        log.signalGroup(target, signal);
        // 模拟组信号让组长与同组成员退出。
        alive.delete(4100);
        alive.delete(4200);
      },
    },
  );
  assert.equal(result.attempted, true);
  assert.equal(result.confirmedStopped, true, JSON.stringify(result));
  for (const entry of log.targets) {
    assert.equal(entry.target, 4100, "只允许向 worker 进程组发信号");
    assert.equal(entry.via, "group");
  }
});

test("主 worker 已死且组号仍有成员：不按组发信号，不可归因成员 → unknown", async () => {
  const log = makeSignalLog();
  const alive = new Set([4300]);
  const result = await reclaimWorkerRecord(
    { pid: 4100, pgid: 4100, processIdentity: "worker-lstart", descendants: [] },
    {
      ...BASE,
      identityOf: () => "whatever",
      isAlive: (pid) => alive.has(pid),
      readTable: () => table([row(4300, 1, 4100)]), // 组 4100 仍有成员，但 PID 4100 已不存在
      signalPid: log.signalPid,
      signalGroup: log.signalGroup,
    },
  );
  assert.equal(log.targets.length, 0, "主 worker 已死时不得按组号发信号");
  assert.equal(result.confirmedStopped, false);
  assert.equal(result.survivors.includes(4300), true);
});

test("PID 复用（身份不符）：一个信号都不发，unknown", async () => {
  const log = makeSignalLog();
  const alive = new Set([5000, 5100]);
  const verdict = verifyOwnership(
    { pid: 5000, pgid: 5000, processIdentity: "old-lstart" },
    () => "new-lstart",
    (pid) => alive.has(pid),
  );
  assert.equal(verdict.kind, "pid_reused");
  const result = await reclaimWorkerRecord(
    { pid: 5000, pgid: 5000, processIdentity: "old-lstart", descendants: [{ pid: 5100, identity: "old-child" }] },
    {
      ...BASE,
      identityOf: (pid) => (pid === 5000 ? "new-lstart" : pid === 5100 ? "someone-else" : null),
      isAlive: (pid) => alive.has(pid),
      readTable: () => table([row(5000, 1, 5000), row(5100, 1, 999)]),
      signalPid: log.signalPid,
      signalGroup: log.signalGroup,
    },
  );
  assert.equal(log.targets.length, 0, "PID 复用者与身份不符的后代占用者都不得被触碰");
  assert.equal(result.confirmedStopped, false);
  assert.equal(result.attempted, false);
});

test("进程表读不到：不发任何信号，保守 unknown", async () => {
  const log = makeSignalLog();
  const result = await reclaimWorkerRecord(
    { pid: 6000, pgid: 6000, processIdentity: "ident", descendants: [] },
    {
      ...BASE,
      identityOf: () => "ident",
      isAlive: () => true,
      readTable: (): ProcessTableRead => ({ ok: false, reason: "ps 不可用" }),
      signalPid: log.signalPid,
      signalGroup: log.signalGroup,
    },
  );
  assert.equal(log.targets.length, 0);
  assert.equal(result.attempted, false);
  assert.equal(result.confirmedStopped, false);
});

test("后代身份读不到：不补刀并计入 unresolved；主 worker 身份同样不可读时零信号", async () => {
  const log = makeSignalLog();
  const alive = new Set([7000, 7100]);
  const result = await reclaimWorkerRecord(
    { pid: 7000, pgid: 7000, processIdentity: null, descendants: [{ pid: 7100, identity: "child-ident" }] },
    {
      ...BASE,
      identityOf: () => null, // 全部身份不可读
      isAlive: (pid) => alive.has(pid),
      readTable: () => table([row(7000, 1, 7000), row(7100, 7000, 7000)]),
      signalPid: log.signalPid,
      signalGroup: log.signalGroup,
    },
  );
  assert.equal(log.targets.length, 0, "身份不可读时不发信号");
  assert.equal(result.confirmedStopped, false);
  assert.equal(result.survivors.includes(7000), true);
});

test("后代身份不符（PID 被复用）：原进程视为已结束，不触碰占用者", async () => {
  const log = makeSignalLog();
  const alive = new Set([8100]);
  const result = await reclaimWorkerRecord(
    { pid: 8000, pgid: 8000, processIdentity: "worker-ident", descendants: [{ pid: 8100, identity: "child-ident" }] },
    {
      ...BASE,
      identityOf: (pid) => (pid === 8000 ? "worker-ident" : "changed-occupant"),
      isAlive: (pid) => alive.has(pid) || pid === 8000,
      readTable: () => table([]),
      signalPid: log.signalPid,
      signalGroup: log.signalGroup,
    },
  );
  // 主 worker 8000 身份相符且存活 → 会发组信号（合法路径）；后代 8100 身份不符 → 不补刀。
  assert.equal(log.targets.some((entry) => entry.via === "pid" && entry.target === 8100), false);
  assert.equal(result.attempted, true);
});
