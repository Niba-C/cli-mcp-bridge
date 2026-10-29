import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink } from "../../src/contracts/backend.ts";
import { applyTurnOutcome } from "../../src/core/apply-outcome.ts";
import { reduceRunState } from "../../src/core/run-machine.ts";
import type { RunState } from "../../src/contracts/run.ts";

function silentSink(events: BackendEvent[]): BackendEventSink {
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

async function runLate() {
  const backend = new FakeBackend({ scenario: "late-terminal", stopAfterMs: 200, stopIntent: "cancel" });
  const events: BackendEvent[] = [];
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const outcome = await backend.execute(
    {
      runId: "run_00000000-0000-4000-8000-000000000004",
      session,
      prompt: "late",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    silentSink(events),
  );
  return { outcome, events, records: backend.transcript };
}

test("fake 不遵守 stop 时会继续推进：stop@100 之后仍有 progress@300（这是场景设定，不是产品行为）", async () => {
  const { outcome, records } = await runLate();
  const stopAt = records.find((record) => record.type === "stop.observed")?.atMs;
  const progressAfterStop = records.filter((record) => record.type === "progress" && record.atMs > (stopAt ?? 0));

  assert.equal(stopAt, 100);
  assert.equal(progressAfterStop.length, 1, "fake 应在 stop 之后继续发一条 progress，用来模拟不配合的后端");
  // 后端如实上报自己完成了，同时标记「这是在停止请求之后」。
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.terminalObservedAfterStop, true);
});

test("产品层拒绝这个晚到的 completed：最终是 cancelled，并保留被拒终态", async () => {
  const { outcome } = await runLate();
  const applied = applyTurnOutcome(outcome, { stopIntent: "cancel" });

  assert.equal(applied.state, "cancelled");
  assert.equal(applied.rejectedTerminal, "completed");
  assert.equal(applied.accepted, true);
  assert.deepEqual(applied.path, ["stopping", "cancelled"]);
});

test("A05：停止中的 run 不能被晚到的 completed 改写", () => {
  let state: RunState = "running";
  const toStopping = reduceRunState(state, "stopping");
  assert.equal(toStopping.accepted, true);
  state = toStopping.state;

  const late = reduceRunState(state, "completed");
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "illegal_transition");
  assert.equal(late.state, "stopping");

  const confirmed = reduceRunState(state, "cancelled");
  assert.equal(confirmed.accepted, true);
  state = confirmed.state;

  const afterTerminal = reduceRunState(state, "completed");
  assert.equal(afterTerminal.accepted, false);
  assert.equal(afterTerminal.reason, "terminal_immutable");
  assert.equal(afterTerminal.state, "cancelled");
});

test("已确认成功的 run 不会被取消改写", () => {
  const completed = reduceRunState("draining", "completed");
  assert.equal(completed.accepted, true);
  const cancel = reduceRunState(completed.state, "cancelled");
  assert.equal(cancel.accepted, false);
  assert.equal(cancel.reason, "terminal_immutable");
  assert.equal(cancel.state, "completed");
});
