import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink } from "../../src/contracts/backend.ts";
import { applyTurnOutcome } from "../../src/core/apply-outcome.ts";

test("v0.1 没有 agent_answer：事实输入按 INPUT_REQUIRED_UNSUPPORTED 有界停止", async () => {
  const backend = new FakeBackend({ scenario: "input-required" });
  const events: BackendEvent[] = [];
  const sink: BackendEventSink = {
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

  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const outcome = await backend.execute(
    {
      runId: "run_00000000-0000-4000-8000-000000000008",
      session,
      prompt: "input",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    sink,
  );

  assert.equal(outcome.kind, "cancelled");
  assert.equal(outcome.error?.code, "INPUT_REQUIRED_UNSUPPORTED");
  // 输入请求本身要被暴露出来，但答案是 unsupported，不能编一个答案。
  assert.equal(events.filter((event) => event.type === "input_requested").length, 1);
  assert.equal(outcome.agentReported, null);

  const applied = applyTurnOutcome(outcome, { stopIntent: "cancel" });
  assert.equal(applied.state, "cancelled");
});

test("事实输入请求不会被当成授权：approval 回调一次都不应触发", async () => {
  const backend = new FakeBackend({ scenario: "input-required" });
  let approvals = 0;
  const sink: BackendEventSink = {
    emit() {},
    async requestApproval() {
      approvals += 1;
      return { decision: "allow_once", actor: "operator" };
    },
    async requestInput() {
      return "unsupported";
    },
  };
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  await backend.execute(
    {
      runId: "run_00000000-0000-4000-8000-000000000009",
      session,
      prompt: "input",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    sink,
  );
  assert.equal(approvals, 0);
});
