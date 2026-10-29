import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeStore } from "../../src/storage/index.ts";
import { resolveDaemonPaths } from "../../src/daemon/layout.ts";
import { WorkspaceManager } from "../../src/daemon/workspacemgr.ts";
import { ZBridgeError } from "../../src/contracts/errors.ts";

/**
 * 登记规则拒绝 $TMPDIR 下的 root，因此源工作区放在 home 专用前缀下；
 * 测试结束清理自己创建的目录。
 */
function makeSourceDir(label: string): string {
  const base = join(homedir(), ".opencode-bridge-oc04-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `wscopy-${label.slice(0, 20)}-${randomBytes(5).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

interface Fixture {
  readonly store: BridgeStore;
  readonly dataRoot: string;
  readonly manager: WorkspaceManager;
  /** 登记需要清理的目录。 */
  readonly created: string[];
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dataRoot = mkdtempSync(join(tmpdir(), "oc04-ws-"));
  const store = BridgeStore.open(join(dataRoot, "bridge.sqlite"));
  const manager = new WorkspaceManager(store, resolveDaemonPaths(dataRoot));
  const created: string[] = [dataRoot];
  return {
    store,
    dataRoot,
    manager,
    created,
    cleanup(): void {
      try {
        store.close();
      } catch {
        // 已关闭。
      }
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 让 fixture 统一清理源目录。 */
function track(fixture: Fixture, dir: string): string {
  fixture.created.push(dir);
  return dir;
}

test("副本排除 .git、凭据与策略配置，不跟随 symlink，正常文件复制", () => {
  const fixture = makeFixture();
  const source = track(fixture, makeSourceDir("basic"));
  try {
    writeFileSync(join(source, "seed.txt"), "hello\n");
    writeFileSync(join(source, "opencode.jsonc"), '{"model":"x"}');
    writeFileSync(join(source, "opencode.json"), "{}");
    writeFileSync(join(source, ".env"), "SECRET=1");
    writeFileSync(join(source, "server.key"), "KEY");
    writeFileSync(join(source, "auth.json"), "{}");
    mkdirSync(join(source, ".git", "hooks"), { recursive: true });
    writeFileSync(join(source, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    mkdirSync(join(source, "sub"), { recursive: true });
    writeFileSync(join(source, "sub", "a.md"), "A");
    symlinkSync("/etc/hosts", join(source, "escaped-link"));

    const result = fixture.manager.register("main", source, ["review"]);
    assert.equal(result.generationBumped, false);
    assert.equal(result.workspace.generation, 1);
    const copy = result.copyRoot;
    assert.ok(copy !== null);
    assert.equal(existsSync(join(copy, "seed.txt")), true);
    assert.equal(readFileSync(join(copy, "seed.txt"), "utf8"), "hello\n");
    assert.equal(existsSync(join(copy, "sub", "a.md")), true);
    // 排除项。
    assert.equal(existsSync(join(copy, ".git")), false, ".git 不得复制（hooks 不执行）");
    assert.equal(existsSync(join(copy, ".env")), false, "凭据不得复制");
    assert.equal(existsSync(join(copy, "server.key")), false);
    assert.equal(existsSync(join(copy, "auth.json")), false);
    assert.equal(existsSync(join(copy, "opencode.json")), false, "用户策略配置不得复制");
    assert.equal(existsSync(join(copy, "opencode.jsonc")), false, "opencode.jsonc 不得复制");
    assert.equal(existsSync(join(copy, "escaped-link")), false, "symlink 一律跳过");
    fixture.cleanup();
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
});

test("普通重启不换 generation、不重建副本；登记变化才 +1", () => {
  const fixture = makeFixture();
  const source = track(fixture, makeSourceDir("regen"));
  try {
    writeFileSync(join(source, "a.txt"), "A\n");
    const first = fixture.manager.register("main", source, ["review"]);
    const firstGen = first.workspace.generation;
    assert.equal(firstGen, 1);
    const firstCopy = first.copyRoot;

    // 普通重启：同 root 同 profiles → 复用。
    const again = fixture.manager.register("main", source, ["review"]);
    assert.equal(again.reused, true);
    assert.equal(again.generationBumped, false);
    assert.equal(again.workspace.generation, firstGen);
    assert.equal(again.copyRoot, firstCopy);

    // profiles 变化 = 登记变化 → generation+1、新副本。
    const bumped = fixture.manager.register("main", source, ["review", "edit"]);
    assert.equal(bumped.generationBumped, true);
    assert.equal(bumped.workspace.generation, firstGen + 1);
    assert.notEqual(bumped.copyRoot, firstCopy);
    fixture.cleanup();
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
});

test("同 slug 换目录拒绝；副本目标已存在拒绝；重叠路径拒绝", () => {
  const fixture = makeFixture();
  const source = track(fixture, makeSourceDir("conflict"));
  const other = track(fixture, makeSourceDir("other"));
  try {
    writeFileSync(join(source, "a.txt"), "A\n");
    writeFileSync(join(other, "b.txt"), "B\n");
    fixture.manager.register("main", source, ["review"]);

    // 同 slug 不同 realpath。
    assert.throws(
      () => fixture.manager.register("main", other, ["review"]),
      (error: unknown) => error instanceof ZBridgeError && error.code === "INVALID_ARGUMENT",
    );

    // 副本目标已存在（残留/人工目录）→ 拒绝且不覆盖。
    const occupied = join(fixture.dataRoot, "workspaces", "fresh-g1");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep.txt"), "keep");
    assert.throws(
      () => fixture.manager.register("fresh", other, ["review"]),
      (error: unknown) => error instanceof ZBridgeError,
    );
    assert.equal(readFileSync(join(occupied, "keep.txt"), "utf8"), "keep", "已存在目标不得被覆盖");

    // 重叠：root 即 dataRoot 本身（源包含副本目标）。
    assert.throws(
      () => fixture.manager.register("overlap", fixture.dataRoot, ["review"]),
      (error: unknown) => error instanceof ZBridgeError,
    );
    fixture.cleanup();
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
});

test("$TMPDIR 下的 root 与 HOME 本身仍被拒绝", () => {
  const fixture = makeFixture();
  try {
    const tmpWorkspace = mkdtempSync(join(tmpdir(), "oc04-tmp-ws-"));
    fixture.created.push(tmpWorkspace);
    assert.throws(
      () => fixture.manager.register("tmpws", tmpWorkspace, ["review"]),
      (error: unknown) => error instanceof ZBridgeError && error.code === "WORKSPACE_NOT_ALLOWED",
    );
    assert.throws(
      () => fixture.manager.register("home", homedir(), ["review"]),
      (error: unknown) => error instanceof ZBridgeError && error.code === "WORKSPACE_NOT_ALLOWED",
    );
    fixture.cleanup();
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
});
