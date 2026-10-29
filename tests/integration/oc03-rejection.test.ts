import assert from "node:assert/strict";
import { test } from "node:test";
import { newId } from "../../src/contracts/ids.ts";
import { createAdapterHarness, recordingSink } from "../helpers/oc03-harness.ts";

test("真实拒绝样本：tool-calls + tool.error 无最终回答时收敛为 APPROVAL_DENIED", async () => {
  const sink = recordingSink(() => ({ decision: "deny", actor: "operator" }));
  const h = await createAdapterHarness({ scenario: "permission-reject-no-final", sink, policyProfile: "edit" });
  try {
    const started = Date.now();
    assert.ok(h.session !== null);
    const result = await h.adapter.executeTurn({
      runId: newId("run"), session: h.session, prompt: "写文件",
      model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
      deadlineAt: new Date(Date.now() + 6_000).toISOString(),
    }, sink);
    assert.equal(result.outcome.kind, "failed");
    assert.equal(result.outcome.error?.code, "APPROVAL_DENIED");
    assert.equal(result.mapped.rawFinish, "tool-calls");
    assert.ok(Date.now() - started < 4_000, "拒绝不应一直等到用户轮次期限");
    assert.equal(h.adapter.isWorkerAlive, false);
    assert.equal(h.sink.tools.filter((entry) => entry === "bash:failed").length, 1);
  } finally { await h.close(); }
});
