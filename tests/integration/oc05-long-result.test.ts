/** 长正文必须能经过 adapter/coordinator 落库，而不是只给分页器种入合法清单。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanupHarness, CLI_MAIN, startDaemon } from "../helpers/oc04-harness.ts";

test("OC-05 长中文 emoji 正文经真实 gateway 落库，截断标记计入存储上限", async (t) => {
  const harness = await startDaemon({ scenario: "oc05-long-unicode" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI_MAIN, "mcp", "serve", "--data-dir", harness.dataRoot], stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "oc05-long-result", version: "1" }, { capabilities: {} });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await harness.shutdown();
    cleanupHarness(harness);
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(response.structuredContent);
    return response.structuredContent as Record<string, unknown>;
  };
  const caps = await call("agent_capabilities");
  const workspaces = await call("workspace_list");
  const workspace = (workspaces["workspaces"] as Array<{ workspaceId: string }>)[0]!;
  const accepted = await call("agent_start", {
    workspaceId: workspace.workspaceId, prompt: "offline long fixture", clientRequestId: "oc05-long-result",
    serviceEpoch: caps["serviceEpoch"],
  });
  const waited = await call("agent_wait", { runs: [{ runId: accepted["runId"] }], returnWhen: "all_terminal", timeoutMs: 25_000 });
  assert.equal((waited["runs"] as Array<{ state: string }>)[0]?.state, "completed");
  const result = await call("agent_result", { runId: accepted["runId"], section: "agentReported" });
  const text = (result["page"] as { text: string }).text;
  assert.ok(text.startsWith("中中文🙂"));
  assert.ok(text.endsWith("…[truncated]"));
  assert.ok(text.length <= 16_000, "截断标记也必须计入存储条目上限");
  assert.ok(!text.includes("\uFFFD"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), "不能切断 emoji 的代理对");
});
