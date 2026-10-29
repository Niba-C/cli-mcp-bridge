import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configTemplate } from "../../src/contracts/config.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { cleanupHarness, startDaemon } from "../helpers/oc04-harness.ts";

const A = "minimax/MiniMax-M3.1-Flash";
const B = "minimax/MiniMax-M3";
const C = "deepseek/deepseek-chat";
const SECRET = "fake-original-key-no-network";
const SHIM = fileURLToPath(new URL("../fixtures/oc04-opencode-shim.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/ocbridge.mjs", import.meta.url));
async function command(args: readonly string[]) {
  const parsed = parseArgs(args);
  return runCommand(parsed.positional, parsed.flags);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocmanage-"));
  const config = join(root, "config.json");
  const provider = join(root, "providers.json");
  const data = join(root, "data");
  writeFileSync(config, JSON.stringify({ ...configTemplate(), workspaces: [] }) + "\n", { mode: 0o600 });
  writeFileSync(provider, JSON.stringify({ options: { apiKey: SECRET, baseURL: "http://127.0.0.1:1/v1" }, models: { "MiniMax-M3.1-Flash": { name: "A" } } }) + "\n", { mode: 0o600 });
  const flags = ["--config", config, "--provider-config", provider, "--data-dir", data];
  return { root, config, provider, data, flags, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("模型管理：JSONC 选择性导入、跨供应商、默认切换和移除；保留其他配置并备份私有文件", async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.config, "utf8");
    const source = join(f.root, "opencode.jsonc");
    const importSecret = "fake-import-key-do-not-print";
    writeFileSync(source, `{
      // 只导入所选模型，不合并全局 MCP/plugin
      "plugin": ["must-not-import"], "mcp": {"unrelated":{}},
      "provider": {
        "minimax": {"options":{"apiKey":"${importSecret}"},"models":{"MiniMax-M3":{"name":"B"},"unselected":{"name":"other"}}},
        "deepseek": {"options":{"apiKey":"${importSecret}"},"models":{"deepseek-chat":{"name":"C"},"not-imported":{}}},
      },
    }`);
    let result = await command(["models", "add", B, "--from", source, ...f.flags, "--json"]);
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.output, new RegExp(`${SECRET}|${importSecret}|apiKey`));
    const afterB = JSON.parse(readFileSync(f.provider, "utf8"));
    assert.equal(afterB.options.apiKey, SECRET, "同供应商导入新模型时保留原凭据");
    assert.deepEqual(Object.keys(afterB.models).sort(), ["MiniMax-M3", "MiniMax-M3.1-Flash"]);
    const backupCount = readdirSync(f.root).filter(p => p.includes(".bak-")).length;
    const duplicate = JSON.parse((await command(["models", "add", B, "--from", source, ...f.flags, "--json"])).output);
    assert.equal(duplicate.changed, false, "同一来源重复导入保持不变");
    assert.equal(readdirSync(f.root).filter(p => p.includes(".bak-")).length, backupCount);
    result = await command(["models", "add", C, "--from", source, "--default", ...f.flags, "--json"]);
    assert.equal(result.exitCode, 0);
    const wrapped = JSON.parse(readFileSync(f.provider, "utf8"));
    assert.deepEqual(Object.keys(wrapped), ["providers"]);
    assert.deepEqual(Object.keys(wrapped.providers.deepseek.models), ["deepseek-chat"]);
    assert.equal(wrapped.providers.minimax.options.apiKey, SECRET);
    const listed = JSON.parse((await command(["models", "list", ...f.flags, "--json"])).output);
    assert.equal(listed.default, C);
    assert.equal(listed.models.length, 3);
    await command(["models", "default", B, ...f.flags]);
    await assert.rejects(command(["models", "remove", B, ...f.flags]), /replacement/);
    await command(["models", "remove", B, "--replacement", A, ...f.flags]);
    const final = JSON.parse((await command(["models", "list", ...f.flags, "--json"])).output);
    assert.equal(final.default, A);
    assert.deepEqual(final.models.map((m: { model: string }) => m.model), [C, A].sort());
    const current = JSON.parse(readFileSync(f.config, "utf8"));
    assert.deepEqual(current.workspaces, JSON.parse(original).workspaces);
    assert.deepEqual(current.limits, JSON.parse(original).limits);
    const backups = readdirSync(f.root).filter(p => p.includes(".bak-"));
    assert.ok(backups.some(p => readFileSync(join(f.root, p), "utf8") === original));
    for (const path of [...backups, "config.json", "providers.json"]) assert.equal(statSync(join(f.root, path)).mode & 0o777, 0o600);
    assert.ok(JSON.parse(readFileSync(f.provider, "utf8")).providers.minimax.models["MiniMax-M3"], "移除允许项不销毁供应商定义和凭据");
    assert.equal(readFileSync(source, "utf8").includes("must-not-import"), true, "原 OpenCode 配置不变");
  } finally { f.cleanup(); }
});

test("模型管理拒绝未配置／非法模型与第九个 profile，失败不修改文件；重复添加不重写", async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.config, "utf8");
    const originalProvider = readFileSync(f.provider, "utf8");
    await assert.rejects(command(["models", "add", B, ...f.flags]), /--from/);
    await assert.rejects(command(["models", "add", "https://bad/model", ...f.flags]));
    await assert.rejects(command(["models", "remove", A, ...f.flags]), /replacement/);
    await assert.rejects(command(["models", "list", ...f.flags, "--typo", "x"]), /未知参数/);
    assert.equal(readFileSync(f.config, "utf8"), original);
    assert.equal(readFileSync(f.provider, "utf8"), originalProvider);
    const noop = JSON.parse((await command(["models", "add", A, ...f.flags, "--json"])).output);
    assert.equal(noop.changed, false);
    assert.equal(readdirSync(f.root).some(p => p.includes(".bak-")), false);
    const raw = JSON.parse(original);
    for (let i = 1; i <= 7; i++) raw.backends.opencode.modelProfiles[`extra-${i}`] = { providerID: "minimax", modelID: `model-${i}` };
    writeFileSync(f.config, JSON.stringify(raw));
    await assert.rejects(command(["models", "add", B, ...f.flags]), /上限/);
    assert.equal(readFileSync(f.config, "utf8"), JSON.stringify(raw));
  } finally { f.cleanup(); }
});

test("ocbridge 可执行入口可查帮助、可列出来源模型，错误输出不泄露配置内容", () => {
  const f = fixture();
  try {
    let result = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /models add/);
    result = spawnSync(process.execPath, [BIN, "models", "list", "--available", ...f.flags, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).models[0].model, A);
    const mixed = join(f.root, "mixed.json");
    writeFileSync(mixed, JSON.stringify({ provider: { minimax: { models: { "MiniMax-M3": {} } }, local: { models: { "/Users/example/model": {} } } } }));
    result = spawnSync(process.execPath, [BIN, "models", "list", "--available", "--from", mixed, ...f.flags, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).models[0].model, B);
    assert.deepEqual(JSON.parse(result.stdout).unsupportedModels, ["local//Users/example/model"]);
    const bad = join(f.root, "invalid.json");
    writeFileSync(bad, '{"apiKey":"NEVER-ECHO-THIS-FAKE-KEY",BAD}');
    result = spawnSync(process.execPath, [BIN, "models", "add", B, "--from", bad, ...f.flags], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /NEVER-ECHO/);
  } finally { f.cleanup(); }
});

test("服务管理：启动幂等、真实 IPC 状态、重启加载新模型、SQLite 备份和重复停止（无模型调用）", async () => {
  const f = fixture();
  try {
    const args = [...f.flags, "--opencode", SHIM, "--json"];
    const first = await command(["start", ...args]);
    assert.equal(first.exitCode, 0, first.output);
    const pid = JSON.parse(first.output).pid;
    const second = JSON.parse((await command(["start", ...args])).output);
    assert.equal(second.pid, pid);
    assert.equal(second.alreadyRunning, true);
    const statusFlags = ["--data-dir", f.data, "--json"];
    assert.equal(JSON.parse((await command(["status", ...statusFlags])).output).running, true);
    const source = join(f.root, "extra.json");
    writeFileSync(source, JSON.stringify({ models: { "MiniMax-M3": { name: "B" } } }));
    await command(["models", "add", B, "--from", source, "--default", ...f.flags]);
    assert.equal(JSON.parse((await command(["models", "list", ...f.flags, "--json"])).output).restartRequired, true);
    const restart = await command(["restart", ...args]);
    assert.equal(restart.exitCode, 0, restart.output);
    const loaded = JSON.parse(restart.output);
    assert.notEqual(loaded.pid, pid);
    assert.equal(loaded.models.default, B);
    assert.equal(loaded.serviceEpoch, 2);
    const snapshot = join(loaded.backupDir, "opencode-bridge.sqlite");
    assert.equal(existsSync(snapshot), true);
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get()!["n"], 0); } finally { db.close(); }
    assert.equal(JSON.parse((await command(["models", "list", ...f.flags, "--json"])).output).restartRequired, false);
    assert.equal(existsSync(join(f.data, "daemon", "backend-requests.jsonl")), false, "管理命令没有启动 worker");
    assert.equal((await command(["stop", ...statusFlags])).exitCode, 0);
    assert.equal(JSON.parse((await command(["stop", ...statusFlags])).output).alreadyStopped, true);
    assert.equal(JSON.parse((await command(["status", ...statusFlags])).output).running, false);
  } finally {
    await command(["stop", "--data-dir", f.data, "--force"]).catch(() => undefined);
    f.cleanup();
  }
});

test("服务管理：活动任务时拒绝重启，坏配置不会停掉原服务", async () => {
  const h = await startDaemon({ scenario: "never-terminal" });
  try {
    await h.client("run.start", { workspaceSlug: "main", prompt: "fake only", clientRequestId: "manage-busy", waitMs: 1 });
    const before = await h.status();
    const flags = ["--config", h.configPath, "--provider-config", h.providerConfigPath, "--data-dir", h.dataRoot, "--opencode", SHIM];
    const refused = await command(["restart", ...flags]);
    assert.equal(refused.exitCode, 3, refused.output);
    assert.equal((await h.status())["pid"], before["pid"]);
    await assert.rejects(command(["restart", ...flags, "--config", join(h.root, "missing.json")]), /无法读取/);
    assert.equal((await h.status())["pid"], before["pid"]);
    const forced = await command(["stop", "--data-dir", h.dataRoot, "--force", "--json"]);
    assert.equal(forced.exitCode, 0, forced.output);
  } finally { await h.shutdown(); cleanupHarness(h); }
});
