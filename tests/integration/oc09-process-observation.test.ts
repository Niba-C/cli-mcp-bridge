import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CodebuddyAdapter } from "../../src/backend/codebuddy/adapter.ts";
import { QoderAdapter } from "../../src/backend/qoder/adapter.ts";
import type { TurnSpec } from "../../src/contracts/backend.ts";

for (const backendId of ["codebuddy", "qoder"] as const) {
  test(`停止 ${backendId}：进程表不可读时不能把未上报后代当成静止`, async () => {
    const root = mkdtempSync(join(tmpdir(), "oc09-no-ps-"));
    const state = join(root, "state");
    const authFile = join(root, "auth.json");
    writeFileSync(authFile, JSON.stringify({ accessToken: "offline-fake" }), { mode: 0o600 });
    const options = { executable: process.execPath, workspaceRoot: root, stateRoot: state, serverEpoch: 1,
      sdkModuleId: fileURLToPath(new URL(`../fixtures/${backendId}-fake-sdk.mjs`, import.meta.url)), authFile };
    const adapter = backendId === "codebuddy" ? new CodebuddyAdapter(options) : new QoderAdapter(options);
    const spec: TurnSpec = { runId: "run_00000000-0000-4000-8000-000000000001", session: { backendSessionId: "native-test", serverEpoch: 1, backendVersion: null },
      prompt: "SCENARIO:bg-writer", model: { backendId, modelRef: "test-model", opencode: null }, deadlineAt: new Date(Date.now() + 30_000).toISOString() };
    const oldPath = process.env["PATH"];
    try {
      const turn = adapter.execute(spec, { emit() {}, async requestApproval() { return { decision: "deny", actor: "operator" }; }, async requestInput() { return "unsupported"; } });
      const marker = join(state, "background-marker");
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(marker), "后台写入必须已开始");
      const emptyPath = join(root, "no-executables"); mkdirSync(emptyPath);
      process.env["PATH"] = emptyPath;
      const stop = await adapter.stop({ runId: spec.runId, session: spec.session, intent: "cancel", graceMs: 300 });
      await turn;
      assert.equal(stop.confirmed, false, "进程表不可读，不能凭空确认停止");
      const before = readFileSync(marker).length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(readFileSync(marker).length, before, "无法确认时也应尽力回收自己的进程组");
    } finally {
      if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
      await adapter.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
