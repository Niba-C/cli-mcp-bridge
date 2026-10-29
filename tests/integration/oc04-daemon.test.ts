import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect } from "node:net";
import { cleanupHarness, sleep, startDaemon, type DaemonHarness } from "../helpers/oc04-harness.ts";
import { readRequests } from "../helpers/oc03-harness.ts";

interface RunStart {
  readonly clientRequestId: string;
  readonly runId: string;
  readonly queued: boolean;
  readonly reused: boolean;
  readonly state: string;
  readonly deadlineAt: string;
}

let harness: DaemonHarness;

before(async () => {
  // 主环境：text-happy —— 正常完成、幂等、断连继续。
  harness = await startDaemon({
    scenario: "text-happy",
    runTimeoutMs: 15_000,
    queueTtlMs: 15_000,
  });
});

after(async () => {
  await harness.shutdown();
  cleanupHarness(harness);
});

test("闭环：run.start 稳定 runId → 完成 → 结果可读（真实 adapter/coordinator 路径）", async () => {
  const started = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "只回复 READY",
    clientRequestId: "req-happy-1",
    waitMs: 15_000,
  })) as RunStart;
  assert.equal(started.reused, false);
  assert.match(started.runId, /^run_[0-9a-f-]{36}$/u);
  assert.equal(started.state, "completed");
  // 原期限在受理时固定并随响应返回。
  assert.ok(Number.isFinite(Date.parse(started.deadlineAt)));

  const result = (await harness.client("run.result", { runId: started.runId })) as {
    manifestId: string;
    observed: readonly string[];
    verified: boolean;
  };
  assert.match(result.manifestId, /^res_/u);
  // verification 通道为空：不冒充已验证。
  assert.equal(result.verified, false);
  assert.ok(result.observed.length > 0);
});

test("回执重试：同 key 同参数返回原 run/原期限，不二次执行", async () => {
  const original = (await harness.client("run.get", { clientRequestId: "req-happy-1" })) as { runId: string; deadlineAt: string };
  const again = (await harness.client("run.start", {
    workspaceSlug: "main",
    prompt: "只回复 READY",
    clientRequestId: "req-happy-1",
  })) as RunStart;
  assert.equal(again.reused, true);
  assert.equal(again.runId, original.runId);
  assert.equal(again.deadlineAt, original.deadlineAt, "重试沿用原 deadline");
  const prompts = readRequests(harness.paths.backendLog).filter(
    (entry) => typeof entry["route"] === "string" && (entry["route"] as string).includes("prompt_async"),
  );
  assert.equal(prompts.length, 1, "重试不得重新执行");
});

test("同 key 改参：IDEMPOTENCY_CONFLICT（存储层哈希校验，不重新执行）", async () => {
  await assert.rejects(
    harness.client("run.start", { workspaceSlug: "main", prompt: "改成别的了", clientRequestId: "req-happy-1" }),
    (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
  );
  // 同 key 换 workspace 同样必须冲突（原 session 的 workspace 是请求的一部分）。
  await assert.rejects(
    harness.client("run.start", { workspaceSlug: "alt", prompt: "只回复 READY", clientRequestId: "req-happy-1" }),
    (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
  );
});

test("客户端断连不取消 run；重连后凭 clientRequestId 拿到原结果", async () => {
  // 独立 daemon：模拟服务的时间线每个进程只执行一次，独占环境最清晰。
  const solo = await startDaemon({ scenario: "text-happy", runTimeoutMs: 20_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(solo.paths.clientSocket);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          v: 1,
          id: "raw1",
          kind: "run.start",
          payload: { workspaceSlug: "main", prompt: "只回复 READY", clientRequestId: "req-disconnect-1" },
        })}\n`, () => {
          // 帧已写入内核缓冲后再断开：验证的是「断连不取消 run」，不是「请求丢失」。
          socket.destroy();
          resolve();
        });
      });
      socket.on("error", (error: Error) => reject(error));
    });
    const snapshot = await solo.waitFor(
      "断连后的 run 完成",
      async () => {
        const result = (await solo.client("run.get", { clientRequestId: "req-disconnect-1" })) as { state: string; runId: string };
        return result.state === "completed" ? result : null;
      },
      20_000,
    );
    assert.match(snapshot.runId, /^run_/u);
  } finally {
    await solo.shutdown().catch(() => undefined);
    cleanupHarness(solo);
  }
});

test("run.get 未知 ID 返回 not_found 而不是编造状态", async () => {
  const snap = (await harness.client("run.get", { clientRequestId: "no-such-request" })) as { state: string };
  assert.equal(snap.state, "not_found");
});

test("忙碌 session 拒绝追加 prompt（SESSION_BUSY），取消后释放", async () => {
  // 长任务环境：abort-ignore 挂到被取消/期限为止，保证 busy 窗口确定。
  const slow = await startDaemon({ scenario: "abort-ignore", runTimeoutMs: 30_000 });
  try {
    const first = (await slow.client("run.start", {
      workspaceSlug: "main",
      prompt: "长任务",
      clientRequestId: "req-busy-1",
    })) as RunStart;
    assert.equal(first.queued, false, "全局空闲时应立即开始");
    await slow.waitFor(
      "run 进入 running/busy",
      async () => {
        const snap = (await slow.client("run.get", { runId: first.runId })) as { state: string };
        return ["starting", "running"].includes(snap.state) ? snap : null;
      },
      10_000,
    );

    const session = (await slow.client("run.get", { runId: first.runId })) as { sessionId: string };
    await assert.rejects(
      slow.client("run.start", { sessionId: session.sessionId, prompt: "追加", clientRequestId: "req-busy-2" }),
      (error: unknown) => (error as { code?: string }).code === "SESSION_BUSY",
    );

    const stopped = (await slow.client("run.stop", { runId: first.runId, intent: "cancel" })) as { found: string };
    assert.equal(stopped.found, "run");
    await slow.waitFor(
      "取消收敛",
      async () => {
        const snap = (await slow.client("run.get", { runId: first.runId })) as { state: string };
        return snap.state === "cancelled" ? snap : null;
      },
      20_000,
    );
  } finally {
    await slow.shutdown().catch(() => undefined);
    cleanupHarness(slow);
  }
});

test("全局活动上限 1：跨 session 排队且稳定 runId 全程可查；队列取消落库 cancelled", async () => {
  const queued = await startDaemon({ scenario: "abort-ignore", runTimeoutMs: 30_000, queueTtlMs: 15_000 });
  try {
    const first = (await queued.client("run.start", {
      workspaceSlug: "main",
      prompt: "占位长任务",
      clientRequestId: "req-queue-1",
    })) as RunStart;
    await queued.waitFor(
      "占位 run 启动",
      async () => {
        const snap = (await queued.client("run.get", { runId: first.runId })) as { state: string };
        return ["starting", "running"].includes(snap.state) ? snap : null;
      },
      10_000,
    );

    // 另一个自动 session 的 run：进入队列，但已持久化、有稳定 runId。
    const second = (await queued.client("run.start", {
      workspaceSlug: "main",
      prompt: "队列任务",
      clientRequestId: "req-queue-2",
    })) as RunStart;
    assert.equal(second.queued, true);
    assert.match(second.runId, /^run_/u);
    const status = (await queued.status()) as { queue: unknown[]; activeRunId: string };
    assert.equal(status.queue.length >= 1, true);
    assert.equal(status.activeRunId, first.runId);

    // 队列里的 run 立即取消：落库 cancelled（此时未派发，backend 无第二次 prompt_async）。
    const cancelQueued = (await queued.client("run.stop", { runId: second.runId, intent: "cancel" })) as { found: string };
    assert.equal(cancelQueued.found, "queued");
    const cancelledSnap = (await queued.client("run.get", { runId: second.runId })) as { state: string };
    assert.equal(cancelledSnap.state, "cancelled");

    // 取消占位 run，槽位释放。
    await queued.client("run.stop", { runId: first.runId, intent: "cancel" });
    await queued.waitFor(
      "占位 run 取消完成",
      async () => {
        const snap = (await queued.client("run.get", { runId: first.runId })) as { state: string };
        return snap.state === "cancelled" ? snap : null;
      },
      20_000,
    );
    await sleep(200);
    const finalStatus = (await queued.status()) as { activeRunId: string | null; queue: unknown[] };
    assert.equal(finalStatus.activeRunId, null);
    assert.equal(finalStatus.queue.length, 0);
    const prompts = readRequests(queued.paths.backendLog).filter(
      (entry) => typeof entry["route"] === "string" && (entry["route"] as string).includes("prompt_async"),
    );
    assert.equal(prompts.length, 1, "被取消的排队任务不得派发");
  } finally {
    await queued.shutdown().catch(() => undefined);
    cleanupHarness(queued);
  }
});
