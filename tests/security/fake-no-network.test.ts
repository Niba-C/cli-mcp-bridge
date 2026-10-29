import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeBackend } from "../../src/backend/fake/index.ts";
import type { BackendEvent, BackendEventSink } from "../../src/contracts/backend.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fakeDir = join(repoRoot, "src", "backend", "fake");

function fakeSourceFiles(): string[] {
  return readdirSync(fakeDir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(fakeDir, entry))
    .filter((path) => path.endsWith(".ts"));
}

test("fake 源码不引用网络模块或发起请求", () => {
  const forbidden = [
    /from\s+["']node:(net|http|https|http2|dns|tls)["']/,
    /from\s+["'](undici|axios|node-fetch|got)["']/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
  ];
  const files = fakeSourceFiles();
  assert.ok(files.length > 0, "未找到 fake 源码");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} 命中 ${pattern}`);
    }
  }
});

test("运行期把 fetch 换成会抛错的桩，fake 仍能跑完", async () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (() => {
    called += 1;
    throw new Error("fake 不应该发起网络请求");
  }) as typeof globalThis.fetch;

  try {
    const backend = new FakeBackend({ scenario: "happy-path" });
    const events: BackendEvent[] = [];
    const sink: BackendEventSink = {
      emit(event) {
        events.push(event);
      },
      async requestApproval() {
        return { decision: "allow_once", actor: "operator" };
      },
      async requestInput() {
        return "unsupported";
      },
    };
    const session = await backend.createSession({
      workspaceRoot: "/nonexistent/fake",
      profile: "review",
      policyProfile: "review",
      model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
      runDir: "/nonexistent/run",
    });
    const outcome = await backend.execute(
      {
        runId: "run_00000000-0000-4000-8000-000000000006",
        session,
        prompt: "no network",
        model: { backendId: "opencode", modelRef: "minimax/MiniMax-M3.1-Flash", opencode: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
        deadlineAt: "2026-01-01T00:01:00.000Z",
      },
      sink,
    );
    assert.equal(outcome.kind, "completed");
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("fake 的能力声明不得冒充真机安全证据", async () => {
  const backend = new FakeBackend({ scenario: "happy-path" });
  const capabilities = await backend.probe();

  assert.equal(capabilities.adapterId, "fake");
  assert.equal(capabilities.policyProfile, "review");
  assert.equal(capabilities.runDirRef, "fake:run");

  assert.equal(capabilities.reviewWriteBlocked.support, "unknown");
  assert.equal(capabilities.writeSandbox.support, "unknown");
  assert.equal(capabilities.controlChannelIsolation.support, "unknown");
  assert.equal(capabilities.reviewWriteBlocked.evidenceRef, null);
  assert.equal(capabilities.usageSource, "unavailable");
  assert.equal(capabilities.hardBudget.support, "unsupported");
  assert.equal(capabilities.internalRetry.support, "unknown");
  assert.equal(capabilities.internalRetry.evidenceRef, null);
  assert.equal(capabilities.sessionResume.support, "unknown");
  assert.equal(capabilities.sessionResume.evidenceRef, null);

  // 版本字段只描述 adapter 自身；OpenCode server 与 API schema 没有证据，必须 unknown。
  assert.match(capabilities.versions.adapter.version ?? "", /^fake-/);
  assert.equal(capabilities.versions.backendServer.support, "unknown");
  assert.equal(capabilities.versions.backendServer.version, null);
  assert.equal(capabilities.versions.apiSchema.support, "unknown");
  assert.equal(capabilities.versions.apiSchema.version, null);
  assert.equal(capabilities.versions.apiSchema.sourceRef, null);

  // 停止、事件与恢复都不能拿 fake 当协议证据。
  assert.equal(capabilities.methods.stop.support, "unknown");
  assert.equal(capabilities.methods.loadSession.support, "unknown");
  assert.equal(capabilities.methods.events.support, "unknown");
});

test("fake 不声称停止已被确认（confirmed 必须是 false）", async () => {
  const backend = new FakeBackend({ scenario: "happy-path" });
  const session = await backend.createSession({
    workspaceRoot: "/nonexistent/fake",
    profile: "review",
    policyProfile: "review",
    model: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    runDir: "/nonexistent/run",
  });
  const stopOutcome = await backend.stop({
    runId: "run_00000000-0000-4000-8000-000000000011",
    session,
    intent: "cancel",
    graceMs: 1000,
  });
  assert.equal(stopOutcome.confirmed, false);
  assert.equal(stopOutcome.method, "none");
  assert.match(stopOutcome.detail, /fake/);
});
