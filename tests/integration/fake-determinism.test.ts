import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink, BackendSessionRef } from "../../src/contracts/backend.ts";

function sinkCollector(events: BackendEvent[]): BackendEventSink {
  return {
    emit(event) {
      events.push(event);
    },
    async requestApproval() {
      return { decision: "allow_once", actor: "operator" };
    },
    async requestInput() {
      return "unsupported";
    },
  };
}

async function createFakeSession(backend: FakeBackend): Promise<BackendSessionRef> {
  return backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
}

async function runScenario(name: string, options: { stopAfterMs?: number; startedAt?: string } = {}) {
  const backend = new FakeBackend({ scenario: name, ...options });
  const events: BackendEvent[] = [];
  const session = await createFakeSession(backend);
  const outcome = await backend.execute(
    {
      runId: "run_00000000-0000-4000-8000-000000000001",
      session,
      prompt: "deterministic",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    sinkCollector(events),
  );
  await backend.close();
  return { events, outcome, transcript: backend.transcriptJson(), records: backend.transcript };
}

test("同一场景两次运行逐字节一致（可确定性复现）", async () => {
  const first = await runScenario("happy-path");
  const second = await runScenario("happy-path");
  assert.equal(first.transcript, second.transcript);
  assert.deepEqual(first.outcome, second.outcome);
  assert.equal(first.events.length, second.events.length);
});

test("时间戳由固定起点 + 虚拟毫秒推导，不依赖墙钟", async () => {
  const { records } = await runScenario("happy-path", { startedAt: "2030-05-05T00:00:00.000Z" });
  // 只取业务事件：turn.started/session.created/turn.settled 是记录行，不属于脚本时间线。
  const business = records.filter(
    (record) => record.atMs > 0 && record.type !== "turn.settled",
  );
  assert.deepEqual(
    business.map((record) => record.atMs),
    [100, 200, 300, 400, 500],
  );
  assert.equal(business[0]?.at, "2030-05-05T00:00:00.100Z");
});

test("事件顺序与类型符合脚本", async () => {
  const { events, outcome } = await runScenario("happy-path");
  assert.deepEqual(
    events.map((event) => event.type),
    ["progress", "message", "tool", "progress"],
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.stopReason, "turn_complete");
  assert.equal(outcome.terminalObservedAfterStop, false);
});

test("不同场景得到不同轨迹", async () => {
  const happy = await runScenario("happy-path");
  const failure = await runScenario("backend-failure");
  assert.notEqual(happy.transcript, failure.transcript);
  assert.equal(failure.outcome.kind, "failed");
  assert.equal(failure.outcome.error?.code, "BACKEND_UNAVAILABLE");
});

test("createSession 直接给出后端会话引用与代际，没有懒占位阶段", async () => {
  const backend = new FakeBackend({ scenario: "happy-path" });
  const session = await createFakeSession(backend);
  assert.match(session.backendSessionId, /^fake-backend-/);
  assert.equal(session.serverEpoch, 1);
  assert.equal(session.backendVersion, "fake-0.0.0");
  assert.equal("materialization" in session, false);

  const reloaded = await backend.loadSession(session);
  assert.deepEqual(reloaded, session);
});
