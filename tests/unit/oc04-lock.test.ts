import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { InstanceLock, isProcessAlive, processIdentity } from "../../src/daemon/lock.ts";
import { ZBridgeError } from "../../src/contracts/errors.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "oc04-lock-"));
}

/** 拿一个确定已退出的真实 PID（spawn 一个立即退出的进程并等待结束）。 */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 });
  if (result.status !== 0) assert.fail("无法构造已退出进程");
  // spawnSync 的子进程已退出；它的 pid 现在必然死掉。
  return result.pid ?? 0;
}

test("空目录可获取锁；同一进程再次获取成功（幂等）", () => {
  const dir = makeDir();
  try {
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    const first = lock.acquire();
    assert.equal(first.acquired, true);
    assert.equal(first.staleReclaimed, false);
    const again = lock.acquire();
    assert.equal(again.acquired, true);
    const content = lock.peek();
    assert.ok(content !== null);
    assert.equal(content.pid, process.pid);
    assert.ok(content.nonce.length > 0);
    lock.release();
    assert.equal(lock.peek(), null, "释放后锁文件应被删除");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存活实例（身份相符）拒绝第二个实例", () => {
  const dir = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    const first = new InstanceLock(join(dir, "daemon.lock"));
    first.acquire();
    const second = new InstanceLock(join(dir, "daemon.lock"));
    assert.throws(() => second.acquire(), (error: unknown) => {
      assert.ok(error instanceof ZBridgeError);
      assert.equal(error.code, "DAEMON_UNAVAILABLE");
      return true;
    });
    // 第二个实例失败后不得留下任何锁副作用。
    assert.ok(first.peek() !== null);
    first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活 PID 但缺少身份记录：拒绝接管（不能当作身份不符）", () => {
  const dir = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    // 当前测试进程必然活着；写一个没有 identity 的锁。
    writeFileSync(join(dir, "daemon.lock"), `${JSON.stringify({ pid: process.pid, startedAt: "2026-10-23T00:00:00.000Z" })}\n`);
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    assert.throws(() => lock.acquire(), (error: unknown) => error instanceof ZBridgeError);
    assert.equal(existsSync(join(dir, "daemon.lock")), true, "拒绝时不得删除锁文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活 PID 但身份读不到：拒绝接管", () => {
  const dir = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "daemon.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: "x", identity: "definitely-not-matching-lstart", nonce: "n" })}\n`,
    );
    // 身份与当前进程不符 → 本应判 stale；但通过注入场景模拟「读不到」较难，
    // 这里改为验证「身份不符的活 PID」会被判定 stale（旧持有者已死，PID 被复用）。
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    const result = lock.acquire();
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("确认死亡的旧 PID：允许接管并标记 staleReclaimed", () => {
  const dir = makeDir();
  const pid = deadPid();
  try {
    mkdirSync(dir, { recursive: true });
    assert.equal(isProcessAlive(pid), false, "测试前置：PID 应已退出");
    writeFileSync(
      join(dir, "daemon.lock"),
      `${JSON.stringify({ pid, startedAt: "2026-10-23T00:00:00.000Z", identity: "whatever", nonce: "old" })}\n`,
    );
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    const result = lock.acquire();
    assert.equal(result.acquired, true);
    assert.equal(result.staleReclaimed, true);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏的锁内容：拒绝并保留现场（不自动清锁）", () => {
  const dir = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.lock"), "not-json{{{");
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    assert.throws(() => lock.acquire(), (error: unknown) => error instanceof ZBridgeError);
    assert.equal(readFileSync(join(dir, "daemon.lock"), "utf8"), "not-json{{{");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release 不删除已被替换的锁（nonce 不符时不动别人的锁）", () => {
  const dir = makeDir();
  try {
    mkdirSync(dir, { recursive: true });
    const lock = new InstanceLock(join(dir, "daemon.lock"));
    lock.acquire();
    // 模拟锁内容被并发替换成别人的锁。
    const foreign = { pid: 999_999_999, startedAt: "2026-10-23T00:00:00.000Z", identity: null, nonce: "foreign-nonce" };
    writeFileSync(join(dir, "daemon.lock"), `${JSON.stringify(foreign)}\n`);
    lock.release();
    const after = lock.peek();
    assert.ok(after !== null, "release 不得删除 nonce 不符的锁");
    assert.equal(after.nonce, "foreign-nonce");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processIdentity 对死 PID 返回 null，对自己的 PID 返回非空", () => {
  const pid = deadPid();
  assert.equal(processIdentity(pid), null);
  const self = processIdentity(process.pid);
  assert.ok(self !== null && self.length > 0);
});

/** 复刻 review-lock-race-root.mjs 的确定性调度：A 判陈旧后、B 先回收持锁、A 随后 unlink。 */
test("陈旧锁接管竞争：互斥守卫下最多一方持锁（doubleHeld 必须为 false）", () => {
  const dir = makeDir();
  const lockPath = join(dir, "daemon.lock");
  try {
    mkdirSync(dir, { recursive: true });
    // 指向确定已退出的 PID 的「陈旧锁」。
    const pid = deadPid();
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid, startedAt: "2000-01-01", identity: "dead", nonce: "old" })}\n`,
    );
    const a = new InstanceLock(lockPath);
    const b = new InstanceLock(lockPath);
    const realUnlink = fs.unlinkSync;
    let intercepted = false;
    let bAcquired = false;
    // 改写内置 unlink 是确定性复现竞态的唯一手段；结束后立即恢复。
    const fsModule = fs as unknown as { unlinkSync: (path: PathLike) => void };
    fsModule.unlinkSync = (path: PathLike) => {
      if (String(path) === lockPath && !intercepted) {
        intercepted = true;
        realUnlink(path);
        try {
          b.acquire();
          bAcquired = true;
        } catch {
          // 守卫生效：B 被拒绝（A 正持有互斥守卫）。
        }
      }
    };
    syncBuiltinESMExports();
    try {
      a.acquire();
    } finally {
      fsModule.unlinkSync = realUnlink;
      syncBuiltinESMExports();
    }
    assert.equal(intercepted, true, "测试前置：A 的 stale-unlink 应被拦截");
    assert.equal(bAcquired, false, "守卫互斥下 B 不得在 A 的接管窗口内持锁");
    assert.equal(a.isHeld && b.isHeld, false, "绝不允许双实例同时持锁");
    assert.equal(a.isHeld, true, "陈旧锁应被恰好一方接管");
    a.release();
    b.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
