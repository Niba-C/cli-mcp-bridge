import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CURRENT_SCHEMA_VERSION, BridgeStore, type IdFactory } from "../../src/storage/index.ts";
import { openSqlite } from "../../src/storage/db.ts";
import type { RunId } from "../../src/contracts/ids.ts";
import {
  SESSION_B_ID,
  T0,
  T1,
  admit,
  bootstrap,
  makeTempDb,
  sequentialIds,
} from "../helpers/storage-fixture.ts";

test("migrations 只在首次应用，重复执行不重复写版本", () => {
  const store = BridgeStore.openMemory({ migrate: false });
  try {
    assert.equal(store.appliedMigrations().length, 0);
    assert.equal(store.migrate(), CURRENT_SCHEMA_VERSION);
    assert.equal(store.migrate(), CURRENT_SCHEMA_VERSION);
    const applied = store.appliedMigrations();
    // OC-09 migration v5（三后端身份列）之后共五版。
    assert.deepEqual(
      applied.map((item) => item.version),
      [1, 2, 3, 4, 5],
    );
    assert.equal(applied[0]?.name, "initial-persistence");
    assert.equal(applied[1]?.name, "oc04-daemon-ownership");
    assert.equal(applied[2]?.name, "oc05-tool-receipts");
    assert.equal(applied[3]?.name, "oc08-model-selection");
    assert.equal(applied[4]?.name, "oc09-backend-identity");
  } finally {
    store.close();
  }
});

test("OC-09 v5：默认行确定标记 opencode，新代际可登记其它后端", () => {
  const temp = makeTempDb();
  try {
    const store = BridgeStore.open(temp.path);
    try {
      const fixture = bootstrap(store);
      const admitted = admit(store, fixture, { clientRequestId: "v5-1" });
      // 新建行（未显式指定后端）与 v4 存量行读取都返回 opencode。
      assert.equal(store.sessions.require(fixture.session.sessionId).backendId, "opencode");
      assert.equal(store.runs.require(admitted.run.runId).backendId, "opencode");
      assert.equal(store.getServerInstance(fixture.serverEpoch)?.backendId, "opencode");

      // 新代际可登记非 opencode 后端的 server instance（列约束允许三值）。
      const service = store.beginService({ at: T1 });
      const server = store.beginServerInstance({ serviceEpoch: service.serviceEpoch, backendId: "codebuddy", at: T1 });
      assert.equal(server.backendId, "codebuddy");

      // 迁移列表完整：v1–v5。
      assert.deepEqual(
        store.appliedMigrations().map((r) => r.version),
        [1, 2, 3, 4, 5],
      );
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("OC-09 v4→v5 与 v3→v4→v5：历史行固定 opencode，旧 NULL 不回填", () => {
  /** 把当前库降回目标版本形状；仅用于构造真实升级起点。 */
  const downgrade = (dbPath: string, target: 3 | 4): void => {
    const db = new DatabaseSync(dbPath);
    db.exec("BEGIN");
    db.exec("DROP INDEX IF EXISTS ix_sessions_backend");
    db.exec("DROP INDEX IF EXISTS ix_runs_backend");
    db.exec("ALTER TABLE sessions DROP COLUMN backend_id");
    db.exec("ALTER TABLE runs DROP COLUMN backend_id");
    db.exec("ALTER TABLE server_instances DROP COLUMN backend_id");
    db.exec("ALTER TABLE worker_processes DROP COLUMN backend_id");
    db.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    if (target === 3) {
      db.exec("ALTER TABLE runs DROP COLUMN selected_model");
      db.exec("ALTER TABLE runs DROP COLUMN observed_model");
      db.exec("ALTER TABLE sessions DROP COLUMN last_selected_model");
      db.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    }
    db.exec("COMMIT");
    db.close();
  };

  for (const target of [4, 3] as const) {
    const temp = makeTempDb();
    let store = BridgeStore.open(temp.path);
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: `upgrade-from-v${target}` });
    const runId = admitted.run.runId;
    store.close();
    downgrade(temp.path, target);

    store = BridgeStore.open(temp.path);
    try {
      assert.deepEqual(
        store.appliedMigrations().map((row) => row.version),
        [1, 2, 3, 4, 5],
        `v${target} 起点应补齐到 v5`,
      );
      assert.equal(store.sessions.require(fixture.session.sessionId).backendId, "opencode");
      assert.equal(store.runs.require(runId).backendId, "opencode");
      assert.equal(store.getServerInstance(fixture.serverEpoch)?.backendId, "opencode");
      if (target === 3) {
        assert.equal(store.runs.require(runId).selectedModel, null, "v3 起点没有模型列，不得编造回填");
        assert.equal(store.runs.require(runId).observedModel, null);
      } else {
        assert.equal(store.runs.require(runId).selectedModel, "minimax/MiniMax-M3.1-Flash", "v4 已有选择原样保留");
      }

      const cbSession = store.createSession({
        ownerId: fixture.principal.principalId,
        workspaceId: fixture.workspaceId,
        profile: "review",
        backendId: "codebuddy",
      });
      assert.equal(cbSession.backendId, "codebuddy", "升级后可登记新后端会话");
    } finally {
      store.close();
      temp.cleanup();
    }
  }
});

test("文件数据库重开后数据仍在：实体、回执、事件、绑定", () => {
  const temp = makeTempDb();
  let store = BridgeStore.open(temp.path);
  try {
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "reopen-1" });
    assert.equal(admitted.reused, false);
    const runId = admitted.run.runId;
    store.close();

    store = BridgeStore.open(temp.path);
    // OC-09 后共五版 migration。
    assert.equal(store.appliedMigrations().length, 5);
    assert.equal(store.workspaces.get(fixture.workspaceId)?.name, "oc02-fixture");

    const session = store.sessions.require(fixture.session.sessionId);
    assert.equal(session.backendSessionId, "oc-backend-1");
    assert.equal(session.serverEpoch, fixture.serverEpoch);

    const run = store.runs.require(runId);
    assert.equal(run.state, "queued");
    assert.equal(run.requestId, "reopen-1");
    // OC-08：模型选择随 run 与 session 持久化，重开后保留。
    assert.equal(run.selectedModel, "minimax/MiniMax-M3.1-Flash");
    assert.equal(run.observedModel, null);
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, "minimax/MiniMax-M3.1-Flash");
    assert.equal(store.receipts.count(), 1);

    const page = store.readEvents(runId);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.seq, 1);
    assert.equal(page.snapshotRevision, 1);

    // 重开后同一 key 仍返回原 run，不新建。
    const retry = store.admitRun({
      principal: fixture.principal,
      sessionId: fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "reopen-1",
      serviceEpoch: fixture.serviceEpoch,
      prompt: "总结这个仓库的入口",
      model: "minimax/MiniMax-M3.1-Flash",
      backend: "opencode",
      deadlineAt: "2026-01-01T00:15:00.000Z",
    });
    assert.equal(retry.reused, true);
    assert.equal(retry.run.runId, runId);
    assert.equal(store.runs.countAll(), 1);

    // 新服务代际的号不与旧值重复。
    const nextService = store.beginService({ at: T1 });
    assert.equal(nextService.serviceEpoch, fixture.serviceEpoch + 1);
    const nextServer = store.beginServerInstance({ serviceEpoch: nextService.serviceEpoch, at: T1 });
    assert.equal(nextServer.serverEpoch, fixture.serverEpoch + 1);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("事务回滚不留下半条业务状态（受理失败）", () => {
  let runSequence: RunId[] = [];
  const base = sequentialIds();
  const ids: IdFactory = {
    ...base,
    run: () => {
      const next = runSequence.shift();
      if (next === undefined) throw new Error("run id 用尽");
      return next;
    },
  };
  const store = BridgeStore.openMemory({ ids });
  try {
    const fixture = bootstrap(store);
    // 预先取一个合法 run id，并让下一次生成复用同一个 → 主键冲突。
    const duplicated = base.run();
    runSequence = [duplicated, duplicated];

    const first = admit(store, fixture, { clientRequestId: "rollback-1" });
    assert.equal(first.run.runId, duplicated);

    const secondSession = store.createSession({
      sessionId: SESSION_B_ID,
      ownerId: fixture.principal.principalId,
      workspaceId: fixture.workspaceId,
      profile: "review",
      at: T1,
    });
    store.bindSessionBackend(secondSession.sessionId, "oc-backend-2", fixture.serverEpoch, T1);

    assert.throws(() => admit(store, fixture, { sessionId: secondSession.sessionId, clientRequestId: "rollback-2" }));

    assert.equal(store.runs.countAll(), 1, "冲突后不留下第二条 run");
    assert.equal(store.receipts.count(), 1, "冲突后不留下第二条回执");
    const sessionAfter = store.sessions.require(secondSession.sessionId);
    assert.equal(sessionAfter.state, "idle", "会话占用被回滚");
    assert.equal(store.readEvents(first.run.runId).events.length, 1);
    assert.equal(store.runs.listBySession(secondSession.sessionId).length, 0);
  } finally {
    store.close();
  }
});

test("显式事务抛错时整体回滚（workspace 写入不残留）", () => {
  const store = BridgeStore.openMemory();
  try {
    const fixture = bootstrap(store);
    const before = store.workspaces.list().length;
    assert.throws(() =>
      store.transaction(() => {
        store.createWorkspace({
          workspaceId: store.ids.workspace(),
          name: "rollback",
          canonicalRoot: "/tmp/oc02-rollback",
          profiles: ["review"],
          at: T0,
        });
        throw new Error("模拟事务中途失败");
      }),
    );
    assert.equal(store.workspaces.list().length, before);
    assert.equal(store.sessions.listByOwner(fixture.principal.principalId).length, 1);
  } finally {
    store.close();
  }
});

test("COMMIT 失败后事务层级恢复，连接仍可嵌套事务", () => {
  const db = openSqlite({ path: ":memory:" });
  try {
    db.raw.exec(
      "CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)",
    );
    // 延迟外键在 COMMIT 时才失败；旧实现会在这里把 depth 减两次。
    assert.throws(
      () => db.transaction(() => db.raw.prepare("INSERT INTO c (id) VALUES (?)").run(99)),
      /FOREIGN KEY constraint failed/,
    );
    db.transaction(() =>
      db.transaction(() => db.raw.prepare("INSERT INTO p (id) VALUES (?)").run(1)),
    );
    const row = db.raw.prepare("SELECT COUNT(*) AS n FROM p").get();
    assert.equal(Number(row?.["n"]), 1);
  } finally {
    db.close();
  }
});

test("数据库版本高于程序时拒绝打开", () => {
  const temp = makeTempDb();
  try {
    const raw = new DatabaseSync(temp.path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      999,
      "future",
      T0,
    );
    raw.close();
    assert.throws(() => BridgeStore.open(temp.path), /schema 版本高于当前程序/);
  } finally {
    temp.cleanup();
  }
});
