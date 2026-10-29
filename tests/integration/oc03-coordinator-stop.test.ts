import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createStoreHarness, admitForRun } from "../helpers/oc03-harness.ts";

test("协调器取消从 stopping 直接进入 cancelled，不倒退到 running", async () => {
  const h = await createStoreHarness({ scenario: "abort-settle" });
  try {
    const admitted = admitForRun(h, { clientRequestId: "coordinator-stop-test" });
    const executing = h.coordinator.run({ runId: admitted.run.runId, prompt: h.prompt, model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } }, deadlineAt: h.deadlineAt });
    const limit = Date.now() + 5_000;
    while (!h.store.readEvents(admitted.run.runId).events.some((e) => e.type === "run.tool" && e.payload["phase"] === "started")) {
      assert.ok(Date.now() < limit, "等待工具开始超时");
      await delay(10);
    }
    const stop = await h.coordinator.stop({ runId: admitted.run.runId, intent: "cancel", graceMs: 500 });
    const result = await executing;
    assert.equal(stop.confirmed, true);
    assert.equal(result.state, "cancelled");
    assert.equal(h.store.getRunSnapshot(admitted.run.runId).state, "cancelled");
    const states = h.store.readEvents(admitted.run.runId).events.map((e) => e.state).filter(Boolean);
    assert.deepEqual(states.slice(-2), ["stopping", "cancelled"]);
  } finally { await h.close(); }
});
