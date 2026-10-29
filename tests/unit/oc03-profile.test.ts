import assert from "node:assert/strict";
import { test } from "node:test";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import {
  LEGACY_MODEL_REF,
  assertPinnedVersion,
  assertResponseIdentity,
  buildControlledConfig,
  buildModelGate,
  collectSecretValues,
  modelRef,
  parseModelRef,
  parseProviderConfigFile,
  permissionRules,
  redactSecrets,
} from "../../src/backend/opencode/profile.ts";
import { buildWorkerEnv } from "../../src/backend/opencode/worker.ts";

const PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  options: { apiKey: "sk-minimax-test-value-123456", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "{env:MINIMAX_API_KEY}" },
  models: { "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash" } },
};

const DEEPSEEK = {
  npm: "@ai-sdk/openai-compatible",
  options: { apiKey: "sk-deepseek-test-value-123456", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "{env:DEEPSEEK_API_KEY}" },
  models: { "deepseek-chat": { name: "chat" } },
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (error) {
    return error instanceof ZBridgeError ? error.code : "not-zbridge";
  }
}

test("parseModelRef：完整引用格式错误一律 INVALID_ARGUMENT", () => {
  assert.deepEqual(parseModelRef("minimax/MiniMax-M3.1-Flash"), { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" });
  assert.deepEqual(parseModelRef("a/b"), { providerID: "a", modelID: "b" });
  for (const bad of ["", "minimax", "/m", "m/", "a/b/c", "a b/c", "http://x/y", "a/b c", "{env:X}/m"]) {
    assert.equal(codeOf(() => parseModelRef(bad)), "INVALID_ARGUMENT", `ref=${JSON.stringify(bad)}`);
  }
});

test("buildModelGate：default 必在、允许列表去重稳定排序、providerIDs 派生", () => {
  const gate = buildModelGate({
    default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
    m3: { providerID: "minimax", modelID: "MiniMax-M3" },
    ds: { providerID: "deepseek", modelID: "deepseek-chat" },
    dup: { providerID: "deepseek", modelID: "deepseek-chat" },
  });
  assert.equal(gate.defaultRef, "minimax/MiniMax-M3.1-Flash");
  assert.deepEqual(gate.allowed, ["deepseek/deepseek-chat", "minimax/MiniMax-M3", "minimax/MiniMax-M3.1-Flash"]);
  assert.deepEqual(gate.providerIDs, ["deepseek", "minimax"]);
  assert.equal(gate.allows("minimax/MiniMax-M3"), true);
  assert.equal(gate.allows("minimax/other"), false);
  assert.equal(codeOf(() => buildModelGate({})), "INVALID_ARGUMENT");
  assert.equal(codeOf(() => buildModelGate({ m3: { providerID: "minimax", modelID: "MiniMax-M3" } })), "INVALID_ARGUMENT");
  assert.equal(modelRef({ providerID: "p", modelID: "m" }), "p/m");
  assert.equal(LEGACY_MODEL_REF, "minimax/MiniMax-M3.1-Flash");
});

test("parseProviderConfigFile：旧单供应商对象等价于 {providers:{minimax:…}}", () => {
  const legacy = parseProviderConfigFile(PROVIDER);
  assert.deepEqual(Object.keys(legacy), ["minimax"]);
  assert.deepEqual(legacy["minimax"], PROVIDER);
});

test("parseProviderConfigFile：多供应商格式逐项校验；混合与结构性字段拒绝", () => {
  const multi = parseProviderConfigFile({ providers: { minimax: PROVIDER, deepseek: DEEPSEEK } });
  assert.deepEqual(Object.keys(multi).sort(), ["deepseek", "minimax"]);
  // 混合格式（providers 与单供应商字段同时出现）
  assert.equal(
    codeOf(() => parseProviderConfigFile({ providers: { minimax: PROVIDER }, npm: "x" })),
    "INVALID_ARGUMENT",
  );
  // 空 providers / 非法键 / 结构性字段
  assert.equal(codeOf(() => parseProviderConfigFile({ providers: {} })), "INVALID_ARGUMENT");
  assert.equal(codeOf(() => parseProviderConfigFile({ providers: { "bad id": PROVIDER } })), "INVALID_ARGUMENT");
  assert.equal(codeOf(() => parseProviderConfigFile({ providers: { minimax: null } })), "INVALID_ARGUMENT");
  for (const key of ["id", "provider", "providers", "enabled_providers", "mcp", "plugin", "model", "small_model"]) {
    assert.equal(
      codeOf(() => parseProviderConfigFile({ providers: { minimax: { ...PROVIDER, [key]: "x" } } })),
      "INVALID_ARGUMENT",
      `key=${key}`,
    );
  }
  assert.equal(codeOf(() => parseProviderConfigFile(null)), "INVALID_ARGUMENT");
  assert.equal(codeOf(() => parseProviderConfigFile([PROVIDER])), "INVALID_ARGUMENT");
});

test("受控配置只含登记供应商；model/small_model 固定为 default 引用", () => {
  const config = buildControlledConfig({
    providers: { minimax: PROVIDER, deepseek: DEEPSEEK },
    defaultModelRef: "minimax/MiniMax-M3.1-Flash",
    policyProfile: "review",
  });
  assert.deepEqual(Object.keys(config["provider"] as Record<string, unknown>), ["deepseek", "minimax"]);
  assert.deepEqual(config["enabled_providers"], ["deepseek", "minimax"]);
  assert.equal(config["model"], "minimax/MiniMax-M3.1-Flash");
  assert.equal(config["small_model"], "minimax/MiniMax-M3.1-Flash");
  assert.deepEqual(config["plugin"], []);
  assert.deepEqual(config["mcp"], {});
  assert.equal(config["autoupdate"], false);
  assert.equal(config["snapshot"], false);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes("anthropic"), false, "配置不能引用未登记供应商");
  // default 供应商不在集合内 / 空集合 / 非法引用都拒绝
  assert.equal(
    codeOf(() => buildControlledConfig({ providers: { minimax: PROVIDER }, defaultModelRef: "deepseek/deepseek-chat", policyProfile: "review" })),
    "INVALID_ARGUMENT",
  );
  assert.equal(
    codeOf(() => buildControlledConfig({ providers: {}, defaultModelRef: "minimax/MiniMax-M3.1-Flash", policyProfile: "review" })),
    "INVALID_ARGUMENT",
  );
});

test("review 拒绝写入与 shell；edit 只把写入改为 ask（仍需本地审批）", () => {
  const review = permissionRules("review");
  assert.deepEqual(
    review.map((rule) => `${rule.permission}:${rule.action}`),
    ["*:deny", "read:allow", "edit:deny", "bash:deny", "shell:deny"],
  );
  const edit = permissionRules("edit");
  assert.equal(edit.find((rule) => rule.permission === "edit")?.action, "ask");
  assert.equal(edit.find((rule) => rule.permission === "bash")?.action, "ask");
  assert.equal(edit[0]?.action, "deny", "默认仍是拒绝，不是全开");
});

test("版本与响应身份必须与本次选定的模型一致（参数化校验）", () => {
  assert.equal(assertPinnedVersion("1.18.32"), "1.18.32");
  for (const version of ["1.18.31", "1.19.0", "1.18", null, ""]) {
    assert.equal(codeOf(() => assertPinnedVersion(version)), "BACKEND_PROTOCOL_MISMATCH", `version=${version}`);
  }

  const selected = { providerID: "minimax", modelID: "MiniMax-M3" };
  assert.equal(codeOf(() => assertResponseIdentity("minimax", "MiniMax-M3", "test", selected)), "no-error");
  assert.equal(codeOf(() => assertResponseIdentity("minimax", "MiniMax-M3.1-Flash", "test", selected)), "BACKEND_PROTOCOL_MISMATCH");
  assert.equal(codeOf(() => assertResponseIdentity("deepseek", "deepseek-chat", "test", selected)), "BACKEND_PROTOCOL_MISMATCH");
  assert.equal(codeOf(() => assertResponseIdentity(null, null, "test", selected)), "BACKEND_PROTOCOL_MISMATCH");
  try {
    assertResponseIdentity("deepseek", "deepseek-chat", "assistant 消息", selected);
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /选定/);
    assert.equal(message.includes("sk-"), false);
  }
});

test("worker 环境只转发登记供应商引用的变量；未登记供应商一律拒绝", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/someone",
    TMPDIR: "/var/folders/x",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "sk-openai-should-not-leak",
    DEEPSEEK_API_KEY: "sk-deepseek-should-not-leak",
    ANTHROPIC_API_KEY: "sk-anthropic-should-not-leak",
    MINIMAX_API_KEY: "sk-minimax-test-value-123456",
    OPENCODE_SERVER_PASSWORD: "inherited-password-must-not-leak",
    OPENCODE_CONFIG: "/Users/someone/.config/opencode/opencode.jsonc",
    RANDOM_UNRELATED: "nope",
  };
  const common = {
    runDir: "/tmp/oc03-run",
    configPath: "/tmp/oc03-run/opencode.json",
    password: "fresh-password",
    baseEnv,
  };

  // 只登记 minimax：登记供应商自己的变量放行；引用了未登记供应商品牌的变量被拒绝。
  const minimaxOnly = buildWorkerEnv({
    providerConfigs: { minimax: { options: { apiKey: "{env:MINIMAX_API_KEY}", backup: "{env:DEEPSEEK_API_KEY}" } } },
    registeredProviderIDs: ["minimax"],
    ...common,
  });
  assert.equal(minimaxOnly.env["MINIMAX_API_KEY"], "sk-minimax-test-value-123456");
  assert.equal(minimaxOnly.env["DEEPSEEK_API_KEY"], undefined);
  assert.equal(minimaxOnly.env["OPENAI_API_KEY"], undefined);
  assert.deepEqual(minimaxOnly.rejectedForeign, ["DEEPSEEK_API_KEY"]);

  // 登记 minimax+deepseek：deepseek 的引用变量放行，未登记的 OPENAI 仍拒绝。
  const both = buildWorkerEnv({
    providerConfigs: {
      minimax: { options: { apiKey: "{env:MINIMAX_API_KEY}" } },
      deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" } },
    },
    registeredProviderIDs: ["minimax", "deepseek"],
    ...common,
  });
  assert.equal(both.env["DEEPSEEK_API_KEY"], "sk-deepseek-should-not-leak");
  assert.equal(both.env["OPENAI_API_KEY"], undefined);
  assert.deepEqual(both.rejectedForeign, []);
  assert.equal(both.env["OPENCODE_SERVER_PASSWORD"], "fresh-password", "必须覆盖继承值");
  assert.equal(both.env["OPENCODE_CONFIG"], "/tmp/oc03-run/opencode.json");
  assert.equal(both.env["HOME"], "/tmp/oc03-run/home");
  const serialized = JSON.stringify(both);
  assert.equal(serialized.includes("sk-openai-should-not-leak"), false);
  assert.equal(serialized.includes("sk-anthropic-should-not-leak"), false);
  assert.equal(serialized.includes("inherited-password-must-not-leak"), false);
});

test("日志脱敏覆盖已知密钥值与常见键名", () => {
  const secrets = collectSecretValues(PROVIDER);
  assert.ok(secrets.some((value) => value.startsWith("sk-minimax")));
  const line = JSON.stringify({ options: PROVIDER.options, note: "sk-minimax-test-value-123456" });
  const redacted = redactSecrets(line, secrets);
  assert.equal(redacted.includes("sk-minimax-test-value-123456"), false);
  assert.equal(redactSecrets('{"apiKey":"abc-secret-value"}', []).includes("abc-secret-value"), false);
  assert.equal(redactSecrets('{"password":"hunter2-value"}', []).includes("hunter2-value"), false);
  assert.equal(redactSecrets('{"authorization":"Bearer abc"}', []).includes("Bearer abc"), false);
});
