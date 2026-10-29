import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configTemplate, validateConfigObject } from "../../src/contracts/config.ts";
import { defaultDataRoot, resolveDataPaths } from "../../src/core/paths.ts";
import { CONFIG_SCHEMA_VERSION } from "../../src/contracts/version.ts";

const SECRET_PATTERNS = [/api[-_]?key/i, /"token"/i, /secret/i, /bearer/i, /password/i, /credential/i];

test("示例配置里没有任何凭证字段", () => {
  const text = readFileSync(new URL("../../config/example.config.json", import.meta.url), "utf8");
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.test(text), false, `示例配置命中 ${pattern}`);
  }
});

test("配置里夹带凭证会被 strict schema 拒绝", () => {
  const config = JSON.parse(JSON.stringify(configTemplate())) as Record<string, unknown>;
  const opencode = (config["backends"] as Record<string, Record<string, unknown>>)["opencode"]!;
  opencode["apiKey"] = "sk-live-xxx";
  const result = validateConfigObject(config);
  assert.equal(result.ok, false);
});

test("配置 schema 版本不匹配时拒绝启动", () => {
  const config = JSON.parse(JSON.stringify(configTemplate())) as Record<string, unknown>;
  config["schemaVersion"] = CONFIG_SCHEMA_VERSION + 1;
  assert.equal(validateConfigObject(config).ok, false);
});

test("数据目录各子目录互相独立（为分身份留边界）", () => {
  const paths = resolveDataPaths("/opt/zb-data");
  const dirs = [
    paths.configDir,
    paths.dataDir,
    paths.artifactsDir,
    paths.operatorDir,
    paths.logsDir,
    paths.backendDir,
  ];
  assert.equal(new Set(dirs).size, dirs.length);
  assert.equal(dirs.every((dir) => dir.startsWith("/opt/zb-data/")), true);
});

test("默认数据根是 OpenCodeBridge，不沿用旧 ZCodeBridge 目录", () => {
  const root = defaultDataRoot("/Users/tester");
  assert.equal(root, "/Users/tester/Library/Application Support/OpenCodeBridge");
  assert.equal(root.includes("ZCodeBridge"), false);
  const paths = resolveDataPaths(root);
  assert.match(paths.dbFile, /opencode-bridge\.sqlite$/);
  assert.equal(paths.backendRunDir, `${root}/backend/run`);
});

test("配置里的 workspace 不接受相对路径、家目录简写、通配符或 .. 段", () => {
  for (const root of ["./proj", "~/proj", "/opt/*", "/opt/../etc"]) {
    const config = JSON.parse(JSON.stringify(configTemplate())) as Record<string, unknown>;
    config["workspaces"] = [{ id: "demo", root, profiles: ["review"] }];
    const result = validateConfigObject(config);
    assert.equal(result.ok, false, `root=${root} 应被拒绝`);
  }
});
