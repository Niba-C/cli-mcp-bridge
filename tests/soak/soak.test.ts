import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink } from "../../src/contracts/backend.ts";
import { scenarioNames } from "../../src/backend/fake/scenarios.ts";
import { TERMINAL_RUN_STATES, type TerminalRunState } from "../../src/contracts/run.ts";

const SINK: BackendEventSink = {
  emit(_event: BackendEvent) {},
  async requestApproval() {
    return { decision: "allow_once", actor: "operator" };
  },
  async requestInput() {
    return "unsupported";
  },
};

const ALLOWED_STATES: ReadonlySet<string> = new Set(TERMINAL_RUN_STATES);

async function once(scenario: string) {
  const backend = new FakeBackend({ scenario });
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const outcome = await backend.execute(
    {
      runId: "run_00000000-0000-4000-8000-000000000007",
      session,
      prompt: "soak",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: "2026-01-01T00:01:00.000Z",
    },
    SINK,
  );
  await backend.close();
  return { outcome, transcript: backend.transcriptJson() };
}

/**
 * 保留的有界版本：固定 200 次、全部用 fake、不联网。
 * 只作离线粗筛；长期稳定性验证需另行明确范围。
 *
 * 这里特意不做「堆增长 < N MiB」这种弱断言：
 * 200 次 fake 只需几毫秒，堆几乎不动，任何阈值都必然通过。
 * 用 --expose-gc 后测一次基线，仅作为「同一进程内不随次数累积 transcript」的粗略回归；
 * 真正的内存结论需要单独的长时验证，本用例不能提供。
 */
test("200 次 fake 执行：状态都在白名单内，且同一场景逐字节稳定", async () => {
  const scenarios = scenarioNames();
  const baseline = await once("happy-path");
  assert.equal(baseline.outcome.kind, "completed");

  if (globalThis.gc) globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  const perScenarioTranscript = new Map<string, string>();

  for (let index = 0; index < 200; index += 1) {
    const scenario = scenarios[index % scenarios.length] as string;
    const result = await once(scenario);

    assert.ok(ALLOWED_STATES.has(result.outcome.kind), `${scenario} 返回了非法终态 ${result.outcome.kind}`);
    const previous = perScenarioTranscript.get(scenario);
    if (previous === undefined) perScenarioTranscript.set(scenario, result.transcript);
    else assert.equal(result.transcript, previous, `${scenario} 在第 ${index} 次执行时轨迹漂移`);
  }

  if (globalThis.gc) globalThis.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const elapsed = Date.now() - startedAt;

  assert.equal(perScenarioTranscript.size, scenarios.length, "每个场景都应被执行到");
  assert.ok(elapsed < 20_000, `200 次 fake 执行耗时 ${elapsed}ms`);
  // 仅作粗筛：若真的每次泄漏一条 transcript，这里会明显超阈值。
  const growthMiB = (heapAfter - heapBefore) / (1024 * 1024);
  assert.ok(growthMiB < 32, `堆增长 ${growthMiB.toFixed(1)}MiB 超过粗筛阈值（需单独长时验证）`);
});

test("重复执行同一场景，终态与轨迹都不变", async () => {
  const first = await once("approval-gated");
  const second = await once("approval-gated");
  assert.equal(first.transcript, second.transcript);
  assert.equal(first.outcome.kind, second.outcome.kind);
  assert.equal(first.outcome.kind as TerminalRunState, "completed");
});
