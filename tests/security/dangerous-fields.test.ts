import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentStartInput,
  FORBIDDEN_INPUT_KEYS,
  findForbiddenKey,
  TOOL_MANIFEST,
} from "../../src/contracts/tools.ts";

const WS = "ws_123e4567-e89b-42d3-a456-426614174000";

test("每个工具的 schema 都拒绝顶层危险字段", () => {
  for (const tool of TOOL_MANIFEST) {
    const parsed = tool.schema.safeParse({ cwd: "/tmp", env: { A: "1" }, command: "rm -rf /" });
    assert.equal(parsed.success, false, `${tool.name} 应拒绝危险字段`);
  }
});

test("黑名单规模固定：42 个键（改清单必须同步文档与测试）", () => {
  assert.equal(FORBIDDEN_INPUT_KEYS.length, 42);
  assert.equal(new Set(FORBIDDEN_INPUT_KEYS).size, 42, "黑名单不允许重复项");
  for (const key of FORBIDDEN_INPUT_KEYS) {
    assert.equal(key, key.toLowerCase(), `${key} 必须是小写无分隔符形式`);
    assert.equal(/[^a-z0-9]/.test(key), false, `${key} 不能含分隔符`);
  }
});

test("黑名单里的每个键都能被识别（顶层）", () => {
  for (const key of FORBIDDEN_INPUT_KEYS) {
    const hit = findForbiddenKey({ [key]: "x" });
    assert.equal(hit?.normalized, key, `未拦截 ${key}`);
  }
});

test("大小写与分隔符变形仍被识别", () => {
  for (const key of ["CWD", "Work_Dir", "provider-key", "API_KEY", "Working-Directory"]) {
    assert.ok(findForbiddenKey({ [key]: "x" }), `未拦截 ${key}`);
  }
});

test("嵌套在普通字段里的危险键同样被拒绝", () => {
  const parsed = agentStartInput.safeParse({
    workspaceId: WS,
    prompt: "hi",
    clientRequestId: "req-20261021-0002",
    serviceEpoch: 0,
    contextArtifactIds: ["art_123e4567-e89b-42d3-a456-426614174000"],
    extra: { deep: [{ env: { HOME: "/" } }] },
  });
  assert.equal(parsed.success, false);
});

test("prompt 正文里出现 cwd/env 字样不算危险字段（避免误杀正常提问）", () => {
  const parsed = agentStartInput.safeParse({
    workspaceId: WS,
    prompt: "这个脚本里为什么要改 cwd 和 env？请解释一下，不要执行任何命令。",
    clientRequestId: "req-20261021-0003",
    serviceEpoch: 0,
  });
  assert.equal(parsed.success, true);
});

test("sessionId / workspaceId 这类合法标识不被误判", () => {
  assert.equal(findForbiddenKey({ workspaceId: WS }), null);
  assert.equal(findForbiddenKey({ sessionId: "ses_123e4567-e89b-42d3-a456-426614174000" }), null);
});

test("OC-08：model 只在 agent_start 顶层豁免；其它工具与嵌套位置仍被拒绝", () => {
  // 黑名单本身不变：model 仍在清单里，手工扫描仍命中。
  assert.ok(findForbiddenKey({ model: "a/b" }));
  // agent_start 顶层接受合法字符串（服务端再校验格式与允许列表）。
  const agentStartOk = agentStartInput.safeParse({
    workspaceId: WS,
    prompt: "hi",
    clientRequestId: "req-20261024-0001",
    serviceEpoch: 1,
    model: "minimax/MiniMax-M3",
  });
  assert.equal(agentStartOk.success, true, "agent_start.model 是唯一豁免的顶层字段");
  // 非字符串形状仍被 schema 拒绝（model 不能变成对象/数组载体）。
  for (const bad of [{ providerID: "x" }, ["a/b"], 42, { env: {} }]) {
    const parsed = agentStartInput.safeParse({
      workspaceId: WS,
      prompt: "hi",
      clientRequestId: "req-20261024-0002",
      serviceEpoch: 1,
      model: bad,
    });
    assert.equal(parsed.success, false, `model=${JSON.stringify(bad)}`);
  }
  // 其它工具不接受 model（strict schema + 黑名单双重拒绝）。
  const other = TOOL_MANIFEST.find((tool) => tool.name === "agent_get");
  assert.ok(other !== undefined);
  assert.equal(other.schema.safeParse({ runId: "run_123e4567-e89b-42d3-a456-426614174000", model: "a/b" }).success, false);
  // agent_start 其余字段保持原样：基线请求仍合法（豁免不改变其它校验）。
  const baseline = agentStartInput.safeParse({
    workspaceId: WS,
    prompt: "hi",
    clientRequestId: "req-20261024-0003",
    serviceEpoch: 1,
    profile: "review",
    contextArtifactIds: [],
    timeoutMs: 900_000,
  });
  assert.equal(baseline.success, true);
});

test("OC-08：豁免不外溢——嵌套在 runs 项里的 model 仍被拒绝", () => {
  // agent_wait 的 runs 数组项是 strict 对象；把 model 藏进去必须被拒，
  // 且不因顶层的 agent_start 豁免而放松（豁免只作用于 depth 0 的指定键）。
  const wait = TOOL_MANIFEST.find((tool) => tool.name === "agent_wait");
  assert.ok(wait !== undefined);
  const parsed = wait.schema.safeParse({
    runs: [{ runId: "run_123e4567-e89b-42d3-a456-426614174000", model: "a/b" }],
  });
  assert.equal(parsed.success, false, "嵌套 model 必须被 strict schema + 黑名单拒绝");
});
