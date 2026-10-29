/**
 * OC-09 第三轮复核闭合：SDK 路线的取消/关停必须经 stopping 收敛，
 * 且停止之后晚到的后端 completed 不得被记为成功（A05）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeStore } from "../../src/storage/index.ts";
import { SdkRunCoordinator, type ManagedAdapter } from "../../src/backend/registry.ts";
import type {
  BackendCapabilities,
  BackendEventSink,
  BackendModelSelection,
  BackendSessionRef,
  SessionSpec,
  StopOutcome,
  StopSpec,
  TurnOutcome,
  TurnSpec,
} from "../../src/contracts/backend.ts";
import type { RunId } from "../../src/contracts/ids.ts";

const T0 = "2026-10-26T00:00:00.000Z";
const T_EXP = "2026-10-26T01:00:00.000Z";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "ws_00000000-0000-4000-8000-000000000002";
const SESSION_ID = "ses_00000000-0000-4000-8000-000000000003";
const RUN_ID = "run_00000000-0000-4000-8000-000000000004";

const MODEL: BackendModelSelection = { backendId: "codebuddy", modelRef: "glm-5.3", opencode: null };

function completedOutcome(): TurnOutcome {
  return {
    kind: "completed",
    stopReason: "turn_complete",
    serverEpoch: 1,
    terminalObservedAfterStop: false,
    agentReported: "后端自称已完成",
    observedModel: "glm-5.3",
    usage: { source: "unavailable", inputTokens: null, outputTokens: null },
    error: null,
    startedAt: T0,
    endedAt: T0,
  };
}

/** 受控 fake adapter：execute 的终态由测试决定何时到达，stop 的确认性可配置。 */
class FakeAdapter {
  readonly backendId = "codebuddy" as const;
  readonly isWorkerAlive = true;
  readonly workerPid: number | null = null;
  private resolveExecute: ((outcome: TurnOutcome) => void) | null = null;
  private stopCalls = 0;
  stopConfirmed = true;

  get stopCallCount(): number {
    return this.stopCalls;
  }

  ownedProcessIds(): readonly number[] {
    return [];
  }

  probe(): Promise<BackendCapabilities> {
    throw new Error("unit 场景不探测能力");
  }

  createSession(_spec: SessionSpec): Promise<BackendSessionRef> {
    throw new Error("unit 场景不建会话");
  }

  loadSession(ref: BackendSessionRef): Promise<BackendSessionRef> {
    return Promise.resolve(ref);
  }

  execute(_spec: TurnSpec, _sink: BackendEventSink): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      this.resolveExecute = resolve;
    });
  }

  stop(_spec: StopSpec): Promise<StopOutcome> {
    this.stopCalls += 1;
    return Promise.resolve({
      confirmed: this.stopConfirmed,
      method: this.stopConfirmed ? "protocol" : "none",
      settledAt: this.stopConfirmed ? T0 : null,
      detail: `fake stop #${this.stopCalls}`,
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** 测试在 stop 之后才放行后端终态，构造「晚到的 completed」。 */
  finish(outcome: TurnOutcome): void {
    const resolve = this.resolveExecute;
    if (resolve === null) throw new Error("execute 尚未开始");
    resolve(outcome);
  }
}

interface World {
  readonly store: BridgeStore;
  readonly adapter: FakeAdapter & ManagedAdapter;
  readonly coordinator: SdkRunCoordinator;
}

function setup(): World {
  const store = BridgeStore.openMemory({ now: () => T0 });
  store.beginService({ at: T0 });
  store.beginServerInstance({ serviceEpoch: 1, at: T0 });
  store.createWorkspace({
    workspaceId: WORKSPACE_ID as never,
    name: "main",
    canonicalRoot: "/tmp/oc09-sdk-stop",
    profiles: ["review"],
    at: T0,
  });
  store.createSession({
    sessionId: SESSION_ID as never,
    ownerId: PRINCIPAL_ID as never,
    workspaceId: WORKSPACE_ID as never,
    profile: "review",
    at: T0,
  });
  store.bindSessionBackend(SESSION_ID as never, "cb-native-1", 1, T0);
  store.runs.insert({
    runId: RUN_ID as never,
    sessionId: SESSION_ID as never,
    ownerId: PRINCIPAL_ID as never,
    workspaceId: WORKSPACE_ID as never,
    requestId: "req-1",
    requestHash: "sha256:" + "0".repeat(64),
    requestTool: "agent_start",
    profile: "review",
    backendId: "codebuddy",
    state: "starting",
    revision: 1,
    lastEventSeq: 1,
    selectedModel: "glm-5.3",
    deadlineAt: T_EXP,
    createdAt: T0,
    updatedAt: T0,
  });
  const adapter = new FakeAdapter() as FakeAdapter & ManagedAdapter;
  const coordinator = new SdkRunCoordinator(adapter, store, null, "policy-unit", () => undefined);
  return { store, adapter, coordinator };
}

interface StartedRun {
  /** adapter.execute 的终态 promise；测试自己决定它何时结算。 */
  readonly settle: Promise<unknown>;
}

async function startRun(world: World): Promise<StartedRun> {
  const settle = world.coordinator.run({ runId: RUN_ID as RunId, prompt: "p", deadlineAt: T_EXP, model: MODEL });
  for (let i = 0; i < 50 && world.store.runs.require(RUN_ID as RunId).state !== "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(world.store.runs.require(RUN_ID as RunId).state, "running", "派发后必须进入 running");
  return { settle };
}

function eventTypes(store: BridgeStore): string[] {
  const rows = store
    .readEvents(RUN_ID as RunId, { limit: 500 })
    .events.map((event: { type: string }) => event.type);
  return rows;
}

test("SDK 取消：confirmed stop 经 stopping 收敛为 cancelled，晚到的 completed 只作审计", async () => {
  const world = setup();
  const started = await startRun(world);

  const stopped = await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "cancel", graceMs: 10 });
  assert.equal(stopped.confirmed, true);

  // 停止已定终态后，后端才回来说「成功」——不能改写终态。
  world.adapter.finish(completedOutcome());
  await started.settle;

  const run = world.store.runs.require(RUN_ID as RunId);
  assert.equal(run.state, "cancelled", `停止确认后必须落 cancelled，实际 ${run.state}`);

  const types = eventTypes(world.store);
  const stopIndex = types.indexOf("run.stop_requested");
  assert.ok(stopIndex >= 0, `必须先看到停止意图：${JSON.stringify(types)}`);
  assert.ok(!types.slice(stopIndex + 1).includes("run.state"), `停止后不得回跳 running：${JSON.stringify(types)}`);
  const terminal = world.store
    .readEvents(RUN_ID as RunId, { limit: 500 })
    .events.find((event: { type: string }) => event.type === "run.terminal") as { state?: string } | undefined;
  assert.equal(terminal?.state, "cancelled");
  assert.equal(world.store.runs.get(RUN_ID as RunId)?.resultManifestId, null, "晚到的 completed 不得写入结果清单");
});

test("SDK 取消：interrupt 意图收敛为 interrupted", async () => {
  const world = setup();
  const started = await startRun(world);

  await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "interrupt", graceMs: 10 });
  world.adapter.finish(completedOutcome());
  await started.settle;

  assert.equal(world.store.runs.require(RUN_ID as RunId).state, "interrupted");
});

test("SDK 取消：stop 未确认时落 unknown，不假报 cancelled", async () => {
  const world = setup();
  world.adapter.stopConfirmed = false;
  const started = await startRun(world);

  const stopped = await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "cancel", graceMs: 10 });
  assert.equal(stopped.confirmed, false);
  world.adapter.finish(completedOutcome());
  await started.settle;

  const run = world.store.runs.require(RUN_ID as RunId);
  assert.equal(run.state, "unknown");
  const session = world.store.sessions.require(SESSION_ID as never);
  assert.notEqual(session.blockedReason, null, "结果不明必须持续阻塞会话");
});

test("SDK 待批中取消：事件顺序为 waiting_approval → stopping → 终态，不回跳 running", async () => {
  const world = setup();
  const started = await startRun(world);
  world.store.transitionRun(RUN_ID as RunId, "waiting_approval", { payload: { tool: "Read" } });

  await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "cancel", graceMs: 10 });
  world.adapter.finish(completedOutcome());
  await started.settle;

  const types = eventTypes(world.store);
  const waitIndex = types.lastIndexOf("run.approval_required");
  const stopIndex = types.indexOf("run.stop_requested");
  assert.ok(waitIndex >= 0 && stopIndex > waitIndex, `待批必须先于停止：${JSON.stringify(types)}`);
  assert.ok(!types.slice(waitIndex + 1, stopIndex).includes("run.state"), `待批直迁 stopping，不得先绕 running：${JSON.stringify(types)}`);
  assert.ok(!types.slice(stopIndex + 1).includes("run.state"), `停止后不得出现 running 事件：${JSON.stringify(types)}`);
  assert.equal(world.store.runs.require(RUN_ID as RunId).state, "cancelled");
});

test("SDK 终态不可改写：cancelled 后晚到结果与重复 stop 都不能复活 run", async () => {
  const world = setup();
  const started = await startRun(world);
  await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "cancel", graceMs: 10 });
  world.adapter.finish(completedOutcome());
  await started.settle;

  // 再走一次取消路径：终态必须原样保留。
  const again = await world.coordinator.stop({ runId: RUN_ID as RunId, intent: "cancel", graceMs: 10 });
  assert.equal(again.confirmed, false);
  assert.equal(again.method, "none");
  assert.equal(world.adapter.stopCallCount, 1, "终态后不得再触碰 adapter");
  assert.equal(world.store.runs.require(RUN_ID as RunId).state, "cancelled");
});
