/**
 * OC-08 存储层单测：模型选择持久化、幂等（含迁移前旧回执的双哈希重放）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { payloadHash } from "../../src/contracts/json.ts";
import { BridgeStore } from "../../src/storage/store.ts";
import { admit, bootstrap, driveToDraining, makeTempDb, T1, type Fixture } from "../helpers/storage-fixture.ts";

const MODEL_A = "minimax/MiniMax-M3.1-Flash";
const MODEL_B = "minimax/MiniMax-M3";
const MODEL_C = "deepseek/deepseek-chat";

function freshStore(): { store: BridgeStore; fixture: Fixture } {
  const store = BridgeStore.openMemory();
  const fixture = bootstrap(store);
  return { store, fixture };
}

test("受理持久化 selected_model，并更新会话 last_selected_model", () => {
  const { store, fixture } = freshStore();
  try {
    const admitted = admit(store, fixture, { clientRequestId: "oc08-persist-1", model: MODEL_B });
    assert.equal(admitted.run.selectedModel, MODEL_B);
    assert.equal(admitted.run.observedModel, null);
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, MODEL_B);
    // 初始事件携带模型选择。
    const page = store.readEvents(admitted.run.runId);
    assert.equal(page.events[0]?.payload["model"], MODEL_B);
  } finally {
    store.close();
  }
});

test("同 key 同模型重试返回原 run；改模型 IDEMPOTENCY_CONFLICT", () => {
  const { store, fixture } = freshStore();
  try {
    const first = admit(store, fixture, { clientRequestId: "oc08-idem-1", model: MODEL_A });
    const retry = admit(store, fixture, { clientRequestId: "oc08-idem-1", model: MODEL_A });
    assert.equal(retry.reused, true);
    assert.equal(retry.run.runId, first.run.runId);
    assert.throws(
      () => admit(store, fixture, { clientRequestId: "oc08-idem-1", model: MODEL_B }),
      /参数不同/,
    );
    assert.equal(store.runs.countAll(), 1);
  } finally {
    store.close();
  }
});

test("重放不把会话当前模型改回旧值", () => {
  const { store, fixture } = freshStore();
  try {
    const first = admit(store, fixture, { clientRequestId: "oc08-keep-1", model: MODEL_A });
    // 第一轮收尾（completed），会话回到 idle 才能受理第二个 run。
    driveToDraining(store, first.run.runId);
    store.completeRunWithResult(first.run.runId, { agentReported: [{ text: "done" }] }, { at: T1 });
    const second = admit(store, fixture, { clientRequestId: "oc08-keep-2", model: MODEL_C });
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, MODEL_C);
    // 会话切到 C 之后重试第一个 key（A）：重放原回执，会话选择仍是 C。
    const replay = admit(store, fixture, { clientRequestId: "oc08-keep-1", model: MODEL_A });
    assert.equal(replay.reused, true);
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, MODEL_C);
    assert.equal(second.run.state, "queued");
  } finally {
    store.close();
  }
});

test("迁移前的旧回执（哈希不含 model）仍可重放；selected_model NULL 不回填", () => {
  const { store, fixture } = freshStore();
  try {
    const admitted = admit(store, fixture, { clientRequestId: "oc08-legacy-1", model: MODEL_A });
    const runId = admitted.run.runId;
    // 模拟迁移前数据：回执哈希按旧形状（无 model），run 无模型列值，会话无最近选择。
    const legacyHash = payloadHash({
      toolName: "agent_start",
      sessionId: fixture.session.sessionId,
      profile: null,
      prompt: "总结这个仓库的入口",
      deadlineAt: "2026-01-01T00:15:00.000Z",
    });
    store.transaction(() => {
      store.receipts.insert(
        {
          principalId: fixture.principal.principalId,
          toolName: "agent_start",
          clientRequestId: "oc08-legacy-2",
          serviceEpoch: fixture.serviceEpoch,
        },
        legacyHash,
        runId,
        T1,
      );
      store.connection.raw.prepare("UPDATE runs SET selected_model = NULL WHERE run_id = ?").run(runId);
      store.connection.raw
        .prepare("UPDATE sessions SET last_selected_model = NULL WHERE session_id = ?")
        .run(fixture.session.sessionId);
    });
    // 旧回执重试：模型按「固定 MiniMax」解释（调度层传入 LEGACY 值），重放成功。
    const replay = store.admitRun({
      principal: fixture.principal,
      sessionId: fixture.session.sessionId,
      toolName: "agent_start",
      clientRequestId: "oc08-legacy-2",
      serviceEpoch: fixture.serviceEpoch,
      prompt: "总结这个仓库的入口",
      deadlineAt: "2026-01-01T00:15:00.000Z",
      model: MODEL_A,
    backend: "opencode",
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.run.runId, runId);
    assert.equal(replay.run.selectedModel, null, "历史行不回填");
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, null, "重放不改写会话选择");
    // 纵深防御：旧格式回执重放时传入非历史解释值的 model（直连 admitRun 的路径）必须冲突。
    assert.throws(
      () =>
        store.admitRun({
          principal: fixture.principal,
          sessionId: fixture.session.sessionId,
          toolName: "agent_start",
          clientRequestId: "oc08-legacy-2",
          serviceEpoch: fixture.serviceEpoch,
          prompt: "总结这个仓库的入口",
          deadlineAt: "2026-01-01T00:15:00.000Z",
          model: MODEL_C,
    backend: "opencode",
        }),
      /参数不同/,
    );
  } finally {
    store.close();
  }
});

test("model 缺失或形状不对的新受理被拒绝；observed_model 可独立更新", () => {
  const { store, fixture } = freshStore();
  try {
    assert.throws(
      () =>
        store.admitRun({
          principal: fixture.principal,
          sessionId: fixture.session.sessionId,
          toolName: "agent_start",
          clientRequestId: "oc08-bad-1",
          serviceEpoch: fixture.serviceEpoch,
          prompt: "p",
          deadlineAt: "2026-01-01T00:15:00.000Z",
          model: "",
    backend: "opencode",
        }),
      /已解析的完整模型标识/,
    );
    const admitted = admit(store, fixture, { clientRequestId: "oc08-bad-2", model: MODEL_A });
    const updated = store.runs.setObservedModel(admitted.run.runId, MODEL_A, T1);
    assert.equal(updated.observedModel, MODEL_A);
    assert.equal(updated.state, "queued", "观测身份不改变状态机");
  } finally {
    store.close();
  }
});

test("lastBySession 返回会话最近受理的 run（旧会话继承的事实来源）", () => {
  const { store, fixture } = freshStore();
  try {
    assert.equal(store.runs.lastBySession(fixture.session.sessionId), null, "从未受理过任务的会话没有可继承选择");
    const first = admit(store, fixture, { clientRequestId: "oc08-last-1", model: MODEL_A });
    driveToDraining(store, first.run.runId);
    store.completeRunWithResult(first.run.runId, { agentReported: [{ text: "done" }] }, { at: T1 });
    const second = admit(store, fixture, { clientRequestId: "oc08-last-2", model: MODEL_C });
    const last = store.runs.lastBySession(fixture.session.sessionId);
    assert.equal(last?.runId, second.run.runId);
    assert.equal(last?.selectedModel, MODEL_C);
  } finally {
    store.close();
  }
});

test("文件库跨打开保留模型列（migration v4 兼容）", () => {
  const temp = makeTempDb();
  try {
    let store = BridgeStore.open(temp.path);
    const fixture = bootstrap(store);
    const admitted = admit(store, fixture, { clientRequestId: "oc08-file-1", model: MODEL_C });
    const runId = admitted.run.runId;
    store.close();
    store = BridgeStore.open(temp.path);
    const run = store.runs.require(runId);
    assert.equal(run.selectedModel, MODEL_C);
    assert.equal(store.sessions.require(fixture.session.sessionId).lastSelectedModel, MODEL_C);
    store.close();
  } finally {
    temp.cleanup();
  }
});
