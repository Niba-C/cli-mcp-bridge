/**
 * OC-05 EOF-only 断连：宿主只关闭 gateway 的 stdin（不发信号、不 close 客户端）。
 *
 * 已安装 SDK 的 StdioServerTransport 不监听 end/close，gateway 必须自己兜底：
 * stdin end → 主动 mcp.close() → 在途请求 AbortSignal 触发 → IPC 等待收尾 →
 * gateway 进程退出；daemon 侧 run 不受影响（状态与 revision 不变）。
 * 覆盖宿主只关闭 stdin 的断连回归。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cleanupHarness,
  CLI_MAIN,
  sleep,
  startDaemon,
} from "../helpers/oc04-harness.ts";

test("宿主仅关闭 stdin 时 gateway 2 秒内退出且 run 不受影响", async () => {
  const harness = await startDaemon({ scenario: "text-happy" });
  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;
  try {
    const accepted = (await harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "EOF fixture",
      clientRequestId: `oc05-eof-${Date.now()}`,
    })) as { runId: string };
    const terminal = await harness.waitFor("terminal run", async () => {
      const snapshot = (await harness.client("run.get", { runId: accepted.runId })) as { state: string; revision: number };
      return snapshot.state === "completed" ? snapshot : null;
    });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot],
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    client = new Client({ name: "oc05-eof-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    // _process 是 StdioClientTransport 的内部字段，测试用它观察 gateway 退出。
    const child = (transport as unknown as { _process: import("node:child_process").ChildProcess })._process;
    assert.ok(child, "gateway 子进程已启动");

    // 挂一个 25 秒的 agent_wait（无新变化，会一直等到超时或中止）。
    const pending = client
      .callTool({ name: "agent_wait", arguments: { runs: [{ runId: accepted.runId, afterRevision: terminal.revision }], returnWhen: "any_change", timeoutMs: 25_000 } })
      .catch(() => null);
    await sleep(250);

    // EOF-only 断连：只关 stdin，不发 SIGTERM、不调 client.close()。
    const startedAt = Date.now();
    child.stdin?.end();
    let exited = false;
    const exitDeadline = Date.now() + 2_000;
    while (Date.now() < exitDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        exited = true;
        break;
      }
      await sleep(50);
    }
    assert.equal(exited, true, `gateway 必须在 2 秒内响应 EOF 退出（耗时 ${Date.now() - startedAt}ms）`);

    // run 不被取消：状态与 revision 保持不变。
    const after = (await harness.client("run.get", { runId: accepted.runId })) as { state: string; revision: number };
    assert.equal(after.state, terminal.state);
    assert.equal(after.revision, terminal.revision);
    await pending;
  } finally {
    // 有界回收：任何失败路径也不留下 gateway 子进程。
    const child = (transport as unknown as { _process?: import("node:child_process").ChildProcess } | null)?._process;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await client?.close().catch(() => undefined);
    await harness.shutdown();
    cleanupHarness(harness);
  }
});
