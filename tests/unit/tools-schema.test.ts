import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentStartInput,
  agentWaitInput,
  artifactReadInput,
  findForbiddenKey,
  registrableTools,
  TOOL_MANIFEST,
  unimplementedTools,
} from "../../src/contracts/tools.ts";
import type { WorkspaceId } from "../../src/contracts/ids.ts";

const WS = "ws_123e4567-e89b-42d3-a456-426614174000" as WorkspaceId;

const validStart = {
  workspaceId: WS,
  prompt: "看一下这个仓库的构建脚本",
  clientRequestId: "req-20261021-0001",
  serviceEpoch: 0,
};

test("合法输入通过校验", () => {
  const parsed = agentStartInput.safeParse(validStart);
  assert.equal(parsed.success, true);
});

test("未知字段一律拒绝", () => {
  const parsed = agentStartInput.safeParse({ ...validStart, extraOption: true });
  assert.equal(parsed.success, false);
});

test("危险字段在顶层与嵌套层都被拒绝", () => {
  for (const key of ["cwd", "env", "command", "providerKey", "apiKey", "argv", "path", "workspaceRoot"]) {
    const top = agentStartInput.safeParse({ ...validStart, [key]: "/tmp/x" });
    assert.equal(top.success, false, `顶层 ${key} 应被拒绝`);
  }

  const nested = agentStartInput.safeParse({ ...validStart, prompt: "x", metadata: { env: { TOKEN: "1" } } });
  assert.equal(nested.success, false, "嵌套 env 应被拒绝");
});

test("findForbiddenKey 能定位嵌套数组里的危险键", () => {
  const hit = findForbiddenKey({ a: [{ b: { cwd: "/" } }] });
  assert.equal(hit?.normalized, "cwd");
  assert.equal(hit?.path, "$.a[0].b.cwd");
});

test("深度过大的结构直接视为可疑", () => {
  let value: Record<string, unknown> = { ok: 1 };
  for (let i = 0; i < 8; i += 1) value = { nested: value };
  assert.ok(findForbiddenKey(value));
});

test("artifact_read 只接受 artifactId，不接受 path/url", () => {
  const art = "art_123e4567-e89b-42d3-a456-426614174000";
  assert.equal(artifactReadInput.safeParse({ artifactId: art }).success, true);
  assert.equal(artifactReadInput.safeParse({ artifactId: art, path: "/etc/passwd" }).success, false);
  assert.equal(artifactReadInput.safeParse({ artifactId: art, url: "http://x" }).success, false);
});

test("agent_wait 的边界：最多 8 个 run、timeout ≤25000", () => {
  const run = (n: number) => ({ runId: `run_00000000-0000-4000-8000-00000000000${n}` });
  const eight = Array.from({ length: 8 }, (_, i) => run(i));
  assert.equal(agentWaitInput.safeParse({ runs: eight }).success, true);
  assert.equal(agentWaitInput.safeParse({ runs: [...eight, run(9)] }).success, false);
  assert.equal(agentWaitInput.safeParse({ runs: [run(1)], timeoutMs: 25_000 }).success, true);
  assert.equal(agentWaitInput.safeParse({ runs: [run(1)], timeoutMs: 25_001 }).success, false);
});

test("未实现的工具不注册（OC-01 阶段注册表为空）", () => {
  const none = registrableTools(new Set());
  assert.deepEqual(none, []);
  assert.equal(unimplementedTools(new Set()).length, TOOL_MANIFEST.length);

  const one = registrableTools(new Set(["agent_get"]));
  assert.deepEqual(
    one.map((tool) => tool.name),
    ["agent_get"],
  );
});

test("每个 v0.1 工具都声明了 annotations 与实现任务", () => {
  for (const tool of TOOL_MANIFEST) {
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
    assert.ok(tool.implementedIn.length > 0, tool.name);
    // OC-01 迁移了任务标签：不再指向已归档的 T07。
    assert.match(tool.implementedIn, /^OC-0[1-7]$/, tool.name);
    assert.ok(tool.summary.length > 0, tool.name);
  }
  // 只读工具不得标成破坏性；变更工具不得标成只读。
  for (const tool of TOOL_MANIFEST) {
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});
