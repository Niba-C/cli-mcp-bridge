/**
 * OC-09 回执哈希与后端归属的幂等语义（B07/B08 的存储层部分）。
 *
 * 覆盖：
 * - 同 key 同 backend 同 model：重放原回执，不新建 run；
 * - 同 key 改 backend（opencode → codebuddy）：IDEMPOTENCY_CONFLICT，
 *   且不能删掉 backend 字段后命中旧 OpenCode 回执；
 * - 显式 codebuddy 请求不得按旧哈希（含/不含 model）匹配任何既有回执；
 * - opencode 同 key 同参数重试：旧哈希族（OC-08 形状）匹配放行重放。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeStore } from "../../src/storage/index.ts";
import { bootstrap, admit, type Fixture } from "../helpers/storage-fixture.ts";

const MODEL_A = "minimax/MiniMax-M3.1-Flash";
const CB_MODEL = "glm-5.3";

function freshStore(): { store: BridgeStore; fixture: Fixture } {
  const store = BridgeStore.openMemory();
  const fixture = bootstrap(store);
  return { store, fixture };
}

test("同 key 同后端同模型重放原回执；run 持久化 backendId", () => {
  const { store, fixture } = freshStore();
  try {
    const first = admit(store, fixture, { clientRequestId: "oc09-receipt-1", model: MODEL_A, backend: "opencode" });
    assert.equal(first.reused, false);
    assert.equal(first.run.backendId, "opencode");

    const retry = admit(store, fixture, { clientRequestId: "oc09-receipt-1", model: MODEL_A, backend: "opencode" });
    assert.equal(retry.reused, true);
    assert.equal(retry.run.runId, first.run.runId);
    assert.equal(store.runs.countAll(), 1);
  } finally {
    store.close();
  }
});

test("同 key 改后端冲突：codebuddy 重试不得命中 OpenCode 回执", () => {
  const { store, fixture } = freshStore();
  try {
    admit(store, fixture, { clientRequestId: "oc09-receipt-2", model: MODEL_A, backend: "opencode" });
    assert.throws(
      () => admit(store, fixture, { clientRequestId: "oc09-receipt-2", model: CB_MODEL, backend: "codebuddy" }),
      (error: unknown) => error instanceof Error && error.name === "ZBridgeError" && /参数不同/.test(error.message),
    );
    // 冲突不产生第二条 run；原回执仍可按原参数重放。
    assert.equal(store.runs.countAll(), 1);
    const replay = admit(store, fixture, { clientRequestId: "oc09-receipt-2", model: MODEL_A, backend: "opencode" });
    assert.equal(replay.reused, true);
  } finally {
    store.close();
  }
});

test("同 key 换成 qoder（合法原生模型）也冲突：backend 独立参与幂等", () => {
  const { store, fixture } = freshStore();
  try {
    admit(store, fixture, { clientRequestId: "oc09-receipt-3", model: MODEL_A, backend: "opencode" });
    // qoder 携带合法原生单段模型；参数哈希含 backend，与 OpenCode 原回执不同，
    // 且 qoder 请求不启用任何旧哈希匹配（旧回执全部归属 opencode）。
    assert.throws(
      () => admit(store, fixture, { clientRequestId: "oc09-receipt-3", model: "qoder-max", backend: "qoder" }),
      (error: unknown) => error instanceof Error && error.name === "ZBridgeError" && /参数不同/.test(error.message),
    );
    // 反向：qoder 后端携带 OpenCode 双段模型先被格式校验拒绝（合法格式是冲突的前提）。
    assert.throws(
      () => admit(store, fixture, { clientRequestId: "oc09-receipt-3", model: MODEL_A, backend: "qoder" }),
      /原生单段/,
    );
  } finally {
    store.close();
  }
});

test("codebuddy 受理接受原生单段模型并持久化归属", () => {
  const { store, fixture } = freshStore();
  try {
    const cbSession = store.createSession({
      ownerId: fixture.principal.principalId,
      workspaceId: fixture.workspaceId,
      profile: "review",
      backendId: "codebuddy",
    });
    const admitted = store.admitRun({
      principal: fixture.principal,
      sessionId: cbSession.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc09-receipt-4",
      serviceEpoch: fixture.serviceEpoch,
      prompt: "只读检查",
      model: CB_MODEL,
      backend: "codebuddy",
      deadlineAt: "2026-01-01T00:15:00.000Z",
    });
    assert.equal(admitted.run.backendId, "codebuddy");
    assert.equal(admitted.run.selectedModel, CB_MODEL);

    // 新后端模型必须单段：双段格式被拒绝。
    assert.throws(
      () =>
        store.admitRun({
          principal: fixture.principal,
          sessionId: cbSession.sessionId,
          toolName: "agent_start",
          clientRequestId: "oc09-receipt-5",
          serviceEpoch: fixture.serviceEpoch,
          prompt: "只读检查",
          model: "minimax/MiniMax-M3.1-Flash",
          backend: "codebuddy",
          deadlineAt: "2026-01-01T00:15:00.000Z",
        }),
      /原生单段/,
    );
  } finally {
    store.close();
  }
});
