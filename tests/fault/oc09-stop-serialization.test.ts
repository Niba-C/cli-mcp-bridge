import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startDaemon, cleanupHarness, type DaemonHarness } from "../helpers/oc04-harness.ts";
import { isProcessAlive } from "../../src/core/proc.ts";

function stateDir(harness: DaemonHarness, backend: string): string | null {
  const root = join(harness.dataRoot, "backends", backend);
  if (!existsSync(root)) return null;
  const session = readdirSync(root).find((name) => name.startsWith("ses-"));
  return session === undefined ? null : join(root, session);
}

for (const backend of ["codebuddy", "qoder"] as const) {
  test(`取消回收 ${backend}：终态先到也必须等实际停止再派发另一会话`, async () => {
    const fakeModule = fileURLToPath(new URL(`../fixtures/${backend}-fake-sdk.mjs`, import.meta.url));
    const harness = await startDaemon({ scenario: "text-happy", sdkBackends: { [backend]: { executable: process.execPath, model: "test-model", fakeModule } } });
    try {
      const first = await harness.client<Record<string, unknown>>("run.start", { workspaceSlug: "main", backend, prompt: "SCENARIO:bg-writer", clientRequestId: "cancel-first", waitMs: 1 });
      const state = await harness.waitFor("旧轮开始后台写入", async () => {
        const dir = stateDir(harness, backend);
        return dir !== null && existsSync(join(dir, "background-marker")) ? dir : null;
      });
      const logName = backend === "codebuddy" ? "fake-sdk.json" : "fake-qoder-sdk.json";
      const pid = Number(JSON.parse(readFileSync(join(state, logName), "utf8"))["cliChildPid"]);
      const second = await harness.client<Record<string, unknown>>("run.start", { workspaceSlug: "main", backend, prompt: "SCENARIO:text", clientRequestId: "cancel-second", waitMs: 1 });
      assert.equal(second["state"], "queued");
      const stopping = harness.client<Record<string, unknown>>("run.stop", { runId: first["runId"], intent: "cancel" });
      const next = await harness.waitFor("下一轮完成", async () => {
        const run = await harness.client<Record<string, unknown>>("run.get", { runId: second["runId"] });
        return run["state"] === "completed" ? run : null;
      });
      const oldStillAlive = isProcessAlive(pid);
      const bytes = readFileSync(join(state, "background-marker")).length;
      const stop = await stopping;
      assert.equal(stop["confirmed"], true);
      assert.equal(next["state"], "completed");
      assert.equal(oldStillAlive, false, "第二轮完成时，正在取消的旧 CLI 必须已经停止");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(readFileSync(join(state, "background-marker")).length, bytes);
    } finally { await harness.shutdown(); cleanupHarness(harness); }
  });
}

test("超时停止无法确认：暂停全局队列，原回执仍可重放", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc09-stop-unconfirmed-"));
  const failFile = join(root, "ps-unavailable");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process'); if(fs.existsSync(${JSON.stringify(failFile)})) process.exit(1); cp.execFileSync('/bin/ps',process.argv.slice(2),{stdio:'inherit'});\n`, { mode: 0o755 });
  const oldPath = process.env["PATH"];
  let harness: DaemonHarness | undefined;
  try {
    process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
    harness = await startDaemon({ scenario: "text-happy", runTimeoutMs: 10_000, sdkDeadlineGraceMs: 150,
      sdkBackends: { codebuddy: { executable: process.execPath, model: "test-model", fakeModule: fileURLToPath(new URL("../fixtures/codebuddy-fake-sdk.mjs", import.meta.url)) } } });
    if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
    const current = harness;
    const first = await current.client<Record<string, unknown>>("run.start", { workspaceSlug: "main", backend: "codebuddy", prompt: "SCENARIO:stuck-writer", clientRequestId: "unconfirmed-first", waitMs: 1 });
    await current.waitFor("执行已开始", async () => {
      const state = stateDir(current, "codebuddy");
      return state !== null && existsSync(join(state, "background-marker")) ? true : null;
    });
    const second = await current.client<Record<string, unknown>>("run.start", { workspaceSlug: "main", backend: "codebuddy", prompt: "SCENARIO:text", clientRequestId: "unconfirmed-second", waitMs: 1 });
    writeFileSync(failFile, "controlled ps failure");
    await current.waitFor("旧轮结果不明", async () => {
      const run = await current.client<Record<string, unknown>>("run.get", { runId: first["runId"] });
      return run["state"] === "unknown" ? true : null;
    }, 25_000);
    assert.equal((await current.client<Record<string, unknown>>("run.get", { runId: second["runId"] }))["state"], "queued", "停止证据不足时不得继续派发队列");
    await assert.rejects(current.client("run.start", { workspaceSlug: "alt", backend: "codebuddy", prompt: "SCENARIO:text", clientRequestId: "unconfirmed-third" }), (error: unknown) => (error as {code?: string}).code === "STOP_UNCONFIRMED");
    const replay = await current.client<Record<string, unknown>>("run.start", { workspaceSlug: "main", backend: "codebuddy", prompt: "SCENARIO:stuck-writer", clientRequestId: "unconfirmed-first", waitMs: 1 });
    assert.equal(replay["runId"], first["runId"]);
    assert.equal(replay["reused"], true);
  } finally {
    if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
    rmSync(failFile, { force: true });
    if (harness !== undefined) { await harness.shutdown(); cleanupHarness(harness); }
    rmSync(root, { recursive: true, force: true });
  }
});
