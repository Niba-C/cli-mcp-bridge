import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink, TurnSpec } from "../../src/contracts/backend.ts";

function sink(events: BackendEvent[]): BackendEventSink {
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

async function setup(scenario: string, stopAfterMs?: number) {
  const backend = new FakeBackend({ scenario, stopAfterMs });
  const events: BackendEvent[] = [];
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const spec: TurnSpec = {
    runId: "run_00000000-0000-4000-8000-000000000005",
    session,
    prompt: "stop",
    model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
    deadlineAt: "2026-01-01T00:01:00.000Z",
  };
  return { backend, events, spec };
}

test("永不结束的场景在 stop 之后有界收敛，且停止后不再产生业务事件", async () => {
  const { backend, events, spec } = await setup("never-ending", 250);
  const outcome = await backend.execute(spec, sink(events));

  assert.equal(outcome.kind, "cancelled");
  assert.equal(Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt), 250);
  assert.deepEqual(
    events.map((event) => event.type),
    ["progress", "progress"],
  );
});

test("首个事件之前就收到 stop：不产生任何业务事件", async () => {
  const { backend, events, spec } = await setup("happy-path");
  const pending = backend.execute(spec, sink(events));
  const stopOutcome = await backend.stop({
    runId: spec.runId,
    session: spec.session,
    intent: "interrupt",
    graceMs: 1000,
  });
  const outcome = await pending;

  assert.equal(outcome.kind, "interrupted");
  assert.deepEqual(events, []);
  // fake 不提供真实停止证据，因此不得声称 confirmed（OC-03 不能拿它当断言依据）。
  assert.equal(stopOutcome.confirmed, false);
  assert.equal(stopOutcome.method, "none");
});

test("静默无终态收敛为 unknown，绝不标 completed（A19）", async () => {
  const { backend, events, spec } = await setup("silent");
  const started = Date.now();
  const outcome = await backend.execute(spec, sink(events));
  const wallClock = Date.now() - started;

  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.agentReported, null);
  // 虚拟时间到 deadline，但真实时间必须立刻返回：fake 不用真实定时器。
  assert.ok(wallClock < 2_000, `真实耗时 ${wallClock}ms 过长`);
  assert.equal(Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt), 60_000);
});

test("无人 stop 的永不结束场景到 deadline 收敛为 timed_out", async () => {
  const { backend, events, spec } = await setup("never-ending");
  const outcome = await backend.execute(spec, sink(events));
  assert.equal(outcome.kind, "timed_out");
});

test("close 之后的 backend 拒绝继续执行", async () => {
  const { backend, events, spec } = await setup("happy-path");
  await backend.close();
  await assert.rejects(() => backend.execute(spec, sink(events)), /已关闭/);
});
