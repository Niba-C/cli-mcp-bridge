/**
 * OC-09-06：ocbridge 管理命令三后端矩阵（C01–C16）。
 *
 * 配置／数据目录与 fake CLI／fake SDK 使用临时目录；产品工作区因拒绝 $TMPDIR，
 * 放在 `~/.opencode-bridge-oc09-management-tests` 专用前缀，并只删除本次创建的子目录。
 * 不读取用户正式配置、不操作用户 daemon、不联网、不调用模型。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/cli/args.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { cleanupHarness, mkTestRoot, startDaemon, type TestEnv } from "../helpers/oc04-harness.ts";

const CB_CLI = fileURLToPath(new URL("../fixtures/oc09-fake-codebuddy-cli.mjs", import.meta.url));
const QD_CLI = fileURLToPath(new URL("../fixtures/oc09-fake-qoder-cli.mjs", import.meta.url));
const CB_CATALOG = fileURLToPath(new URL("../fixtures/codebuddy-fake-catalog.mjs", import.meta.url));
const QD_CATALOG = fileURLToPath(new URL("../fixtures/qoder-fake-catalog.mjs", import.meta.url));
const OC_SHIM = fileURLToPath(new URL("../fixtures/oc04-opencode-shim.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/ocbridge.mjs", import.meta.url));
const ZBIN = fileURLToPath(new URL("../../bin/zbridge.mjs", import.meta.url));

interface JsonCall {
  readonly exitCode: number;
  readonly value: Record<string, unknown>;
  readonly output: string;
}

async function call(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const parsed = parseArgs(args);
  return runCommand(parsed.positional, parsed.flags);
}

async function callJson(args: readonly string[]): Promise<JsonCall> {
  const result = await call([...args, "--json"]);
  const parsed: unknown = JSON.parse(result.output);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), result.output);
  return { exitCode: result.exitCode, value: parsed as Record<string, unknown>, output: result.output };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function backupFiles(env: TestEnv): string[] {
  return readdirSync(env.root).filter((name) => name.includes(".bak-"));
}

function authFile(env: TestEnv, backend: string, token: string): string {
  const file = join(env.root, `${backend}-auth.json`);
  writeFileSync(file, `${JSON.stringify({ accessToken: token })}\n`, { mode: 0o600 });
  return file;
}

function flagsOf(env: TestEnv): string[] {
  return ["--config", env.configPath, "--data-dir", env.dataRoot];
}

function opencodeFlagsOf(env: TestEnv): string[] {
  return [...flagsOf(env), "--provider-config", env.providerConfigPath];
}

function makeWorkspace(label: string): string {
  const base = join(homedir(), ".opencode-bridge-oc09-management-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, `${label}-`));
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  return dir;
}

function sdkOnlyEnv(id: "codebuddy" | "qoder"): TestEnv {
  const root = mkdtempSync(join(tmpdir(), `oc09-mgmt-${id}-`));
  const workspace = makeWorkspace(`${id}-only`);
  const configPath = join(root, "config.json");
  const providerConfigPath = join(root, "provider.json");
  const dataRoot = join(root, "data");
  const executable = id === "codebuddy" ? CB_CLI : QD_CLI;
  const pinnedVersion = id === "codebuddy" ? "2.173.0" : "1.1.78";
  const adapter = id === "codebuddy" ? "codebuddy-sdk" : "qoder-sdk";
  const auth = join(root, `${id}-auth.json`);
  writeFileSync(auth, `${JSON.stringify({ accessToken: `oc09-fake-${id}-pat` })}\n`, { mode: 0o600 });
  const authConfig = id === "codebuddy" ? { mode: "cli-login" } : { mode: "credential-file", file: auth };
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 3,
      mode: "personal",
      defaultBackend: id,
      backends: {
        [id]: {
          adapter,
          enabled: true,
          pinnedVersion,
          executable,
          auth: authConfig,
          models: { default: "native-model-1", allowed: ["native-model-1"] },
        },
      },
      workspaces: [{ id: "main", name: "main", root: workspace, profiles: ["review"] }],
      limits: { activeRuns: 1 },
      transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
    })}\n`,
    { mode: 0o600 },
  );
  // 故意提供不存在的 OpenCode 供应商路径：只启用新后端时不得要求它存在。
  return {
    root,
    workspaceDir: workspace,
    altWorkspaceDir: workspace,
    dataRoot,
    paths: {} as TestEnv["paths"],
    configPath,
    providerConfigPath,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

async function stopQuietly(dataRoot: string): Promise<void> {
  await call(["stop", "--data-dir", dataRoot, "--force", "--json"]).catch(() => undefined);
}

// ---------------------------------------------------------------- C02/C05/C13/C14

test("C02/C05/C13/C14：configure 校验、v2→v3 迁移、重复 no-op、probe 本地缓存、错误与脱敏", async () => {
  const env = mkTestRoot("oc09mgmt");
  const token = "oc09-fake-qoder-pat-do-not-print";
  const auth = authFile(env, "qoder", token);
  const originalConfig = readFileSync(env.configPath, "utf8");
  const originalProvider = readFileSync(env.providerConfigPath, "utf8");
  const outputs: string[] = [];
  try {
    const configured = await callJson([
      "backends", "configure", "codebuddy",
      "--executable", CB_CLI,
      "--auth", "cli-login",
      "--model", "glm-5.3",
      ...flagsOf(env),
    ]);
    outputs.push(configured.output);
    assert.equal(configured.exitCode, 0, configured.output);
    assert.equal(configured.value["changed"], true);
    assert.equal(configured.value["migratedFrom"], 2);
    assert.equal(configured.value["enabled"], false, "首次 configure 默认禁用");
    assert.equal(typeof configured.value["backup"], "string");
    assert.notEqual(readFileSync(env.configPath, "utf8"), originalConfig);
    const migrated = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(migrated["schemaVersion"], 3);
    assert.equal(migrated["defaultBackend"], "opencode");
    assert.equal((migrated["backends"] as Record<string, Record<string, unknown>>)["codebuddy"]!["enabled"], false);
    assert.equal(modeOf(configured.value["backup"] as string), 0o600);
    assert.equal(modeOf(env.configPath), 0o600);
    assert.equal(readFileSync(env.providerConfigPath, "utf8"), originalProvider, "configure 不碰 OpenCode provider");

    const backupsBefore = backupFiles(env).length;
    const noop = await callJson([
      "backends", "configure", "codebuddy",
      "--executable", CB_CLI,
      "--auth", "cli-login",
      ...flagsOf(env),
    ]);
    outputs.push(noop.output);
    assert.equal(noop.exitCode, 0);
    assert.equal(noop.value["changed"], false);
    assert.equal(noop.value["backup"], null);
    assert.equal(backupFiles(env).length, backupsBefore, "重复相同配置不增加备份");

    const versionMismatch = await callJson([
      "backends", "configure", "qoder",
      "--executable", CB_CLI,
      "--auth", "credential-file", "--auth-file", auth,
      "--model", "qwen3-coder",
      ...flagsOf(env),
    ]);
    assert.equal(versionMismatch.exitCode, 4, versionMismatch.output);
    assert.equal((versionMismatch.value["error"] as Record<string, unknown>)["code"], "CLI_VERSION_MISMATCH");

    const cliLogin = await callJson([
      "backends", "configure", "qoder",
      "--executable", QD_CLI,
      "--auth", "cli-login",
      "--model", "qwen3-coder",
      ...flagsOf(env),
    ]);
    assert.equal(cliLogin.exitCode, 0, "Qoder cli-login 通过 daemon 账号面复用浏览器登录");
    const browserProbe = await callJson(["backends", "probe", "qoder", "--online", "--test-sdk-module", QD_CATALOG, ...flagsOf(env)]);
    assert.equal(browserProbe.exitCode, 0, browserProbe.output);
    assert.deepEqual((browserProbe.value["models"] as Record<string, unknown>)["available"], ["qd-catalog-1", "qd-catalog-2"]);

    const cbCredential = await callJson([
      "backends", "configure", "codebuddy",
      "--executable", CB_CLI,
      "--auth", "credential-file", "--auth-file", auth,
      ...flagsOf(env),
    ]);
    assert.equal(cbCredential.exitCode, 5, "CodeBuddy credential-file 执行链路尚未接入");
    assert.equal((cbCredential.value["error"] as Record<string, unknown>)["code"], "AUTH_MODE_UNSUPPORTED");

    const badFlag = await callJson([
      "backends", "configure", "codebuddy",
      "--executable", CB_CLI,
      "--auth", "cli-login",
      "--from", env.providerConfigPath,
      ...flagsOf(env),
    ]);
    assert.equal(badFlag.exitCode, 2);
    assert.equal((badFlag.value["error"] as Record<string, unknown>)["code"], "USAGE");

    const providerForSdk = await callJson([
      "backends", "configure", "codebuddy",
      "--provider-config", env.providerConfigPath,
      ...flagsOf(env),
    ]);
    assert.equal(providerForSdk.exitCode, 2);

    const unknownBackend = await callJson(["backends", "show", "claude", ...flagsOf(env)]);
    assert.equal(unknownBackend.exitCode, 2);

    const probe = await callJson(["backends", "probe", "codebuddy", ...flagsOf(env)]);
    outputs.push(probe.output);
    assert.equal(probe.exitCode, 0, probe.output);
    assert.equal(probe.value["source"], "local_cli_probe");
    assert.equal(probe.value["observedVersion"], "2.173.0");
    assert.equal((probe.value["models"] as Record<string, unknown>)["source"], "unavailable");
    assert.equal(modeOf(probe.value["cachePath"] as string), 0o600);

    const online = await callJson([
      "backends", "probe", "codebuddy", "--online", "--test-sdk-module", CB_CATALOG,
      ...flagsOf(env),
    ]);
    outputs.push(online.output);
    assert.equal(online.exitCode, 0, online.output);
    assert.equal(online.value["online"], true);
    assert.equal(online.value["source"], "sdk_catalog_probe");
    assert.deepEqual((online.value["models"] as Record<string, unknown>)["available"], ["cb-catalog-1", "cb-catalog-2"]);
    const onlineModelsPath = join(env.dataRoot, "management", "backends", "codebuddy", "models.json");
    assert.equal(modeOf(onlineModelsPath), 0o600);
    const onlineCache = JSON.parse(readFileSync(onlineModelsPath, "utf8")) as Record<string, unknown>;
    assert.equal(onlineCache["source"], "sdk_catalog");

    const enabled = await callJson(["backends", "enable", "codebuddy", ...flagsOf(env)]);
    assert.equal(enabled.exitCode, 0, enabled.output);
    assert.equal(enabled.value["enabled"], true);
    assert.equal(enabled.value["default"], false, "enable 不自动设为默认");

    const list = await callJson(["backends", "list", ...flagsOf(env)]);
    const view = (list.value["backends"] as Array<Record<string, unknown>>).find((item) => item["id"] === "codebuddy")!;
    assert.equal(view["configured"], true);
    assert.equal(view["enabled"], true);
    assert.equal(view["loaded"], false);
    assert.equal(view["restartRequired"], false, "服务未运行，改动是下次启动生效");

    const show = await callJson(["backends", "show", "qoder", ...flagsOf(env)]);
    assert.equal(show.value["configured"], true, "Qoder cli-login 已完成登记");

    // 禁用默认项必须给 replacement；enable 后设默认，再禁用。
    assert.equal((await callJson(["backends", "default", "codebuddy", ...flagsOf(env)])).exitCode, 0);
    const noReplacement = await callJson(["backends", "disable", "codebuddy", ...flagsOf(env)]);
    assert.equal(noReplacement.exitCode, 2, noReplacement.output);
    assert.equal((noReplacement.value["error"] as Record<string, unknown>)["code"], "USAGE");
    const disabled = await callJson(["backends", "disable", "codebuddy", "--replacement", "opencode", ...flagsOf(env)]);
    assert.equal(disabled.exitCode, 0, disabled.output);
    assert.equal(disabled.value["defaultBackend"], "opencode");
    assert.equal(disabled.value["enabled"], false);
    assert.equal(readFileSync(env.providerConfigPath, "utf8"), originalProvider);

    const qoderConfigured = await callJson([
      "backends", "configure", "qoder",
      "--executable", QD_CLI,
      "--auth", "credential-file", "--auth-file", auth,
      ...flagsOf(env),
    ]);
    outputs.push(qoderConfigured.output);
    assert.equal(qoderConfigured.exitCode, 0, qoderConfigured.output);
    assert.equal(qoderConfigured.value["enabled"], false);

    // C02：两个新后端都要各自完成 configure→probe→enable。
    const qoderProbe = await callJson(["backends", "probe", "qoder", ...flagsOf(env)]);
    outputs.push(qoderProbe.output);
    assert.equal(qoderProbe.exitCode, 0, qoderProbe.output);
    assert.equal(qoderProbe.value["observedVersion"], "1.1.78");
    const qoderEnabled = await callJson(["backends", "enable", "qoder", ...flagsOf(env)]);
    assert.equal(qoderEnabled.exitCode, 0, qoderEnabled.output);
    assert.equal(qoderEnabled.value["enabled"], true);

    const combined = outputs.join("\n");
    assert.doesNotMatch(combined, new RegExp(token));
    assert.doesNotMatch(combined, /apiKey/);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------- C01/C03/C04

test("C01/C03/C04：SDK 模型 add/default/remove 独立于 OpenCode；默认后端切换不改旧 models 目标", async () => {
  const env = mkTestRoot("oc09models");
  const originalProvider = readFileSync(env.providerConfigPath, "utf8");
  try {
    await callJson([
      "backends", "configure", "codebuddy",
      "--executable", CB_CLI,
      "--auth", "cli-login",
      "--model", "glm-5.3",
      ...flagsOf(env),
    ]);
    await callJson(["backends", "enable", "codebuddy", ...flagsOf(env)]);
    await callJson(["backends", "default", "codebuddy", ...flagsOf(env)]);

    // 旧 models 命令省略 --backend 时仍固定 OpenCode，与 defaultBackend 无关。
    const opencodeList = await callJson(["models", "list", ...opencodeFlagsOf(env)]);
    assert.equal(opencodeList.exitCode, 0, opencodeList.output);
    assert.equal(opencodeList.value["backendId"], "opencode");
    assert.equal(opencodeList.value["default"], "minimax/MiniMax-M3.1-Flash");

    const added = await callJson(["models", "add", "glm-5.4", "--backend", "codebuddy", ...flagsOf(env)]);
    assert.equal(added.exitCode, 0, added.output);
    assert.equal(added.value["changed"], true);
    assert.deepEqual(added.value["allowedModels"], ["glm-5.3", "glm-5.4"]);

    const duplicate = await callJson(["models", "add", "glm-5.4", "--backend", "codebuddy", ...flagsOf(env)]);
    assert.equal(duplicate.value["changed"], false);

    const defaults = await callJson(["models", "default", "glm-5.4", "--backend", "codebuddy", ...flagsOf(env)]);
    assert.equal(defaults.exitCode, 0, defaults.output);
    assert.equal(defaults.value["default"], "glm-5.4");

    const listed = await callJson(["models", "list", "--backend", "codebuddy", ...flagsOf(env)]);
    assert.equal(listed.value["default"], "glm-5.4");
    const modelRows = listed.value["models"] as Array<Record<string, unknown>>;
    assert.equal(modelRows.find((row) => row["model"] === "glm-5.4")!["default"], true);
    assert.equal(modelRows.find((row) => row["model"] === "glm-5.3")!["default"], false);

    const removed = await callJson([
      "models", "remove", "glm-5.4", "--backend", "codebuddy",
      "--replacement", "glm-5.3", ...flagsOf(env),
    ]);
    assert.equal(removed.exitCode, 0, removed.output);
    assert.equal(removed.value["default"], "glm-5.3");
    assert.deepEqual(removed.value["allowedModels"], ["glm-5.3"]);

    // C04：Qoder 也要独立完成 add/default/remove，不能只测 CodeBuddy。
    const qoderAuth = authFile(env, "qoder", "oc09-fake-qoder-pat");
    const qoderConfigured = await callJson([
      "backends", "configure", "qoder",
      "--executable", QD_CLI,
      "--auth", "credential-file", "--auth-file", qoderAuth,
      "--model", "qwen3-coder",
      ...flagsOf(env),
    ]);
    assert.equal(qoderConfigured.exitCode, 0, qoderConfigured.output);
    const qoderAdded = await callJson(["models", "add", "qwen3-max", "--backend", "qoder", ...flagsOf(env)]);
    assert.equal(qoderAdded.exitCode, 0, qoderAdded.output);
    assert.deepEqual(qoderAdded.value["allowedModels"], ["qwen3-coder", "qwen3-max"]);
    const qoderDefault = await callJson(["models", "default", "qwen3-max", "--backend", "qoder", ...flagsOf(env)]);
    assert.equal(qoderDefault.exitCode, 0, qoderDefault.output);
    assert.equal(qoderDefault.value["default"], "qwen3-max");
    const qoderListed = await callJson(["models", "list", "--backend", "qoder", ...flagsOf(env)]);
    assert.equal(qoderListed.value["default"], "qwen3-max");
    const qoderRemoved = await callJson([
      "models", "remove", "qwen3-max", "--backend", "qoder",
      "--replacement", "qwen3-coder", ...flagsOf(env),
    ]);
    assert.equal(qoderRemoved.exitCode, 0, qoderRemoved.output);
    assert.equal(qoderRemoved.value["default"], "qwen3-coder");
    assert.deepEqual(qoderRemoved.value["allowedModels"], ["qwen3-coder"]);

    for (const args of [
      ["models", "add", "glm-5.5", "--backend", "codebuddy", "--from", env.providerConfigPath],
      ["models", "add", "glm-5.5", "--backend", "codebuddy", "--provider-config", env.providerConfigPath],
      ["models", "add", "https://bad/model", "--backend", "codebuddy"],
      ["models", "add", "glm-5.5", "--backend", "codebuddy", "--default"],
      ["models", "add", "glm-5.5", "--backend", "opencode", "--from", env.providerConfigPath],
    ]) {
      const failed = await callJson([...args, ...(args.includes("opencode") ? opencodeFlagsOf(env) : flagsOf(env))]);
      assert.equal(failed.exitCode, 2, `${args.join(" ")}: ${failed.output}`);
    }

    const defaultMissing = await callJson(["models", "default", "not-allowed", "--backend", "codebuddy", ...flagsOf(env)]);
    assert.equal(defaultMissing.exitCode, 2);

    assert.equal(readFileSync(env.providerConfigPath, "utf8"), originalProvider, "SDK 模型操作不读写 OpenCode provider");
    const persisted = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted["defaultBackend"], "codebuddy");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------- C06/C09/C16

test("C06/C09/C16：仅 CodeBuddy／Qoder 的实例可启停重启；不要求 OpenCode 二进制或 provider", async () => {
  for (const id of ["codebuddy", "qoder"] as const) {
    const env = sdkOnlyEnv(id);
    const serviceFlags = ["--config", env.configPath, "--data-dir", env.dataRoot];
    try {
      // 服务命令不接受 --backend；只有 status 可过滤（C13）。
      const rejected = await callJson(["start", "--backend", id, ...serviceFlags]);
      assert.equal(rejected.exitCode, 2, rejected.output);
      assert.equal((rejected.value["error"] as Record<string, unknown>)["code"], "USAGE");

      const started = await callJson(["start", ...serviceFlags]);
      assert.equal(started.exitCode, 0, started.output);
      assert.equal(started.value["state"], "running");
      assert.equal(started.value["defaultBackend"], id);

      const status = await callJson(["status", ...serviceFlags]);
      assert.equal(status.exitCode, 0, status.output);
      assert.equal(status.value["running"], true);
      assert.equal(status.value["defaultBackend"], id);
      assert.equal(status.value["loadedDefaultBackend"], id);
      assert.equal(status.value["restartRequired"], false, status.output);
      const backends = status.value["backends"] as Array<Record<string, unknown>>;
      assert.equal(backends.find((item) => item["id"] === "opencode")!["configured"], false);
      const view = backends.find((item) => item["id"] === id)!;
      assert.equal(view["loaded"], true);
      assert.equal(view["runtimeState"], "not_started", "启服务不等于启动 SDK worker");

      const filtered = await callJson(["status", "--backend", id, ...serviceFlags]);
      const filteredBackends = filtered.value["backends"] as Array<Record<string, unknown>>;
      assert.equal(filteredBackends.length, 1);
      assert.equal(filteredBackends[0]!["id"], id);

      const again = await callJson(["start", ...serviceFlags]);
      assert.equal(again.exitCode, 0);
      assert.equal(again.value["pid"], started.value["pid"]);
      assert.equal(again.value["alreadyRunning"], true);

      const restarted = await callJson(["restart", ...serviceFlags]);
      assert.equal(restarted.exitCode, 0, restarted.output);
      assert.notEqual(restarted.value["pid"], started.value["pid"]);
      assert.equal(restarted.value["serviceEpoch"], 2);
      assert.equal(typeof restarted.value["backupDir"], "string");

      const stopped = await callJson(["stop", "--data-dir", env.dataRoot]);
      assert.equal(stopped.exitCode, 0, stopped.output);
      const stoppedAgain = await callJson(["stop", "--data-dir", env.dataRoot]);
      assert.equal(stoppedAgain.exitCode, 0);
      assert.equal(stoppedAgain.value["alreadyStopped"], true);
      const finalStatus = await callJson(["status", ...serviceFlags]);
      assert.equal(finalStatus.value["running"], false);
      assert.equal(finalStatus.value["appliesOnNextStart"], true);
    } finally {
      await stopQuietly(env.dataRoot);
      env.cleanup();
    }
  }
});

// ---------------------------------------------------------------- C07/C08

test("C07/C08：启用后端前置条件错误时 restart 失败且保留旧 daemon；禁用项不阻塞；差异可诊断", async () => {
  const harness = await startDaemon({ scenario: "text-happy" });
  try {
    const config = JSON.parse(readFileSync(harness.configPath, "utf8")) as Record<string, unknown>;
    const backends = config["backends"] as Record<string, Record<string, unknown>>;
    backends["codebuddy"] = {
      adapter: "codebuddy-sdk",
      enabled: true,
      pinnedVersion: "2.173.0",
      executable: join(harness.root, "missing-cli"),
      auth: { mode: "cli-login" },
      models: { default: "glm-5.3", allowed: ["glm-5.3"] },
    };
    writeFileSync(harness.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

    const flags = [
      "--config", harness.configPath,
      "--data-dir", harness.dataRoot,
      "--opencode", OC_SHIM,
      "--provider-config", harness.providerConfigPath,
    ];
    const before = await harness.status();
    const failed = await callJson(["restart", ...flags]);
    assert.equal(failed.exitCode, 4, failed.output);
    assert.equal((failed.value["error"] as Record<string, unknown>)["code"], "EXECUTABLE_NOT_FOUND");
    const after = await harness.status();
    assert.equal(after["pid"], before["pid"], "坏配置不能停掉旧 daemon");

    const status = await callJson(["status", "--config", harness.configPath, "--data-dir", harness.dataRoot]);
    assert.equal(status.exitCode, 0, status.output);
    const view = (status.value["backends"] as Array<Record<string, unknown>>).find((item) => item["id"] === "codebuddy")!;
    assert.equal(view["loaded"], false);
    assert.equal(view["restartRequired"], true);
    assert.ok((view["differences"] as string[]).length > 0, "磁盘与已加载快照的差异要可诊断");

    // 禁用错误项后，重启不再被它阻塞。
    const disabled = await callJson([
      "backends", "disable", "codebuddy",
      "--config", harness.configPath, "--data-dir", harness.dataRoot,
    ]);
    assert.equal(disabled.exitCode, 0, disabled.output);
    const restarted = await callJson(["restart", ...flags]);
    assert.equal(restarted.exitCode, 0, restarted.output);
    assert.notEqual(restarted.value["pid"], before["pid"]);
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

// ---------------------------------------------------------------- C10/C11/C14

test("C10/C11/C14：备份按需复制、SQLite 含 WAL 数据、0600/0700；查询与 probe 不触发推理", async () => {
  const harness = await startDaemon({ scenario: "text-happy" });
  try {
    await harness.client("run.start", {
      workspaceSlug: "main",
      prompt: "SCENARIO:text",
      clientRequestId: "oc09-mgmt-backup",
      waitMs: 25_000,
    });
    const flags = [
      "--config", harness.configPath,
      "--data-dir", harness.dataRoot,
      "--opencode", OC_SHIM,
      "--provider-config", harness.providerConfigPath,
    ];

    const baseFlags = ["--config", harness.configPath, "--data-dir", harness.dataRoot];
    const dbPath = join(harness.dataRoot, "data", "opencode-bridge.sqlite");
    const inferenceEvidence = (): { runs: number; dispatches: number } => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const runs = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as Record<string, unknown>;
        const dispatches = db.prepare("SELECT COUNT(*) AS n FROM dispatch_intents").get() as Record<string, unknown>;
        return { runs: Number(runs["n"]), dispatches: Number(dispatches["n"]) };
      } finally {
        db.close();
      }
    };
    const workerDirsBefore = existsSync(join(harness.dataRoot, "backends"))
      ? readdirSync(join(harness.dataRoot, "backends")).sort()
      : [];
    const countsBefore = inferenceEvidence();
    const list = await callJson(["backends", "list", ...baseFlags]);
    assert.equal(list.exitCode, 0);
    await callJson(["backends", "show", "opencode", ...baseFlags]);
    await callJson(["status", ...baseFlags]);
    await callJson(["config", "validate", "--config", harness.configPath]);
    const workerDirsAfter = existsSync(join(harness.dataRoot, "backends"))
      ? readdirSync(join(harness.dataRoot, "backends")).sort()
      : [];
    assert.deepEqual(workerDirsAfter, workerDirsBefore, "查询不启动 SDK worker");
    // C11：查询与 probe 不得新增持久 dispatch，也不得产生新的后端推理。
    assert.deepEqual(inferenceEvidence(), countsBefore, "查询／probe 前后 runs 与 dispatch_intents 必须不变");

    const restarted = await callJson(["restart", ...flags]);
    assert.equal(restarted.exitCode, 0, restarted.output);
    const backupDir = restarted.value["backupDir"] as string;
    assert.equal(modeOf(backupDir), 0o700);
    for (const file of ["config.json", "opencode-provider.json", "opencode-bridge.sqlite"]) {
      const path = join(backupDir, file);
      assert.equal(existsSync(path), true, `缺少备份 ${file}`);
      assert.equal(modeOf(path), 0o600, `${file} 必须是 0600`);
    }
    const db = new (await import("node:sqlite")).DatabaseSync(join(backupDir, "opencode-bridge.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as Record<string, unknown>;
      assert.ok(Number(row["n"]) >= 1, "SQLite backup 必须包含已完成 run（含 WAL）");
    } finally {
      db.close();
    }
    assert.equal(readFileSync(join(backupDir, "opencode-provider.json"), "utf8"), readFileSync(harness.providerConfigPath, "utf8"));

    // 无关的 provider 文件缺失不影响只有新后端的实例（C10）。
    const sdkEnv = sdkOnlyEnv("codebuddy");
    try {
      const sdkFlags = ["--config", sdkEnv.configPath, "--data-dir", sdkEnv.dataRoot];
      // C11：list/show/status/validate/probe 与 start 均不得创建后端推理证据。
      assert.equal((await callJson(["backends", "list", ...sdkFlags])).exitCode, 0);
      assert.equal((await callJson(["backends", "show", "codebuddy", ...sdkFlags])).exitCode, 0);
      assert.equal((await callJson(["status", ...sdkFlags])).exitCode, 0);
      assert.equal((await callJson(["config", "validate", "--config", sdkEnv.configPath])).exitCode, 0);
      const sdkProbe = await callJson(["backends", "probe", "codebuddy", ...sdkFlags]);
      assert.equal(sdkProbe.exitCode, 0, sdkProbe.output);
      assert.equal(sdkProbe.value["observedVersion"], "2.173.0");
      assert.equal(existsSync(join(sdkEnv.dataRoot, "backends")), false, "查询与 probe 不创建 SDK 运行目录");

      const started = await callJson(["start", ...sdkFlags]);
      assert.equal(started.exitCode, 0, started.output);
      const sdkStatus = await callJson(["status", ...sdkFlags]);
      assert.equal(sdkStatus.exitCode, 0, sdkStatus.output);
      const sdkView = (sdkStatus.value["backends"] as Array<Record<string, unknown>>).find((item) => item["id"] === "codebuddy")!;
      assert.equal(sdkView["runtimeState"], "not_started", "服务启动不等于 worker 已创建");
      const sdkBackendState = join(sdkEnv.dataRoot, "backends", "codebuddy");
      assert.equal(existsSync(sdkBackendState) ? readdirSync(sdkBackendState).length : 0, 0, "start 不创建会话级 SDK worker 目录");
      const sdkDbPath = join(sdkEnv.dataRoot, "data", "opencode-bridge.sqlite");
      if (existsSync(sdkDbPath)) {
        const sdkDb = new DatabaseSync(sdkDbPath, { readOnly: true });
        try {
          const runs = sdkDb.prepare("SELECT COUNT(*) AS n FROM runs").get() as Record<string, unknown>;
          const dispatches = sdkDb.prepare("SELECT COUNT(*) AS n FROM dispatch_intents").get() as Record<string, unknown>;
          assert.equal(Number(runs["n"]), 0, "查询／probe／start 不产生 run");
          assert.equal(Number(dispatches["n"]), 0, "查询／probe／start 不产生后端派发");
        } finally {
          sdkDb.close();
        }
      }
    } finally {
      await stopQuietly(sdkEnv.dataRoot);
      sdkEnv.cleanup();
    }
  } finally {
    await harness.shutdown();
    cleanupHarness(harness);
  }
});

// ---------------------------------------------------------------- C12/C15

test("C12/C15：available 不冒充 allowed／verified；zbridge 入口与管理命令一致", async () => {
  const env = mkTestRoot("oc09available");
  const auth = authFile(env, "qoder", "oc09-qoder-secret");
  try {
    await callJson([
      "backends", "configure", "qoder",
      "--executable", QD_CLI,
      "--auth", "credential-file", "--auth-file", auth,
      "--model", "qwen3-coder",
      ...flagsOf(env),
    ]);
    const empty = await callJson(["models", "list", "--available", "--backend", "qoder", ...flagsOf(env)]);
    assert.equal(empty.exitCode, 0, empty.output);
    assert.equal(empty.value["source"], "unavailable");
    assert.deepEqual(empty.value["models"], []);
    assert.deepEqual(empty.value["allowed"], ["qwen3-coder"]);
    assert.equal(empty.value["discoveredAt"], null);

    const online = await callJson([
      "models", "list", "--available", "--online", "--backend", "qoder",
      "--test-sdk-module", QD_CATALOG,
      ...flagsOf(env),
    ]);
    assert.equal(online.exitCode, 0, online.output);
    assert.equal(online.value["source"], "sdk_catalog");
    assert.deepEqual((online.value["models"] as Array<Record<string, unknown>>).map((row) => row["model"]), ["qd-catalog-1", "qd-catalog-2"]);
    assert.deepEqual(online.value["allowed"], ["qwen3-coder"], "在线目录不改允许列表");
    assert.equal((online.value["models"] as Array<Record<string, unknown>>).every((row) => row["verified"] === false), true);
    const onlineCachePath = join(env.dataRoot, "management", "backends", "qoder", "models.json");
    assert.equal(modeOf(onlineCachePath), 0o600);

    // 模拟最近一次明确发现：available 模型不必在 allowed 内，也不能被标为 verified。
    const cachePath = join(env.dataRoot, "management", "backends", "qoder", "models.json");
    mkdirSync(join(env.dataRoot, "management", "backends", "qoder"), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, `${JSON.stringify({ source: "sdk_catalog", discoveredAt: "2026-10-25T00:00:00.000Z", models: ["qwen3-coder", "qwen3-max"] })}\n`, { mode: 0o600 });
    const cached = await callJson(["models", "list", "--available", "--backend", "qoder", ...flagsOf(env)]);
    assert.equal(cached.value["source"], "sdk_catalog");
    assert.equal(cached.value["discoveredAt"], "2026-10-25T00:00:00.000Z");
    const rows = cached.value["models"] as Array<Record<string, unknown>>;
    assert.equal(rows.find((row) => row["model"] === "qwen3-coder")!["allowed"], true);
    assert.equal(rows.find((row) => row["model"] === "qwen3-max")!["allowed"], false);
    assert.equal(rows.every((row) => row["verified"] === false), true);
    const config = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    const qoder = (config["backends"] as Record<string, Record<string, unknown>>)["qoder"]!;
    assert.deepEqual((qoder["models"] as Record<string, unknown>)["allowed"], ["qwen3-coder"], "目录查询不改允许列表");

    const bin = spawnSync(process.execPath, [BIN, "backends", "list", ...flagsOf(env), "--json"], { encoding: "utf8" });
    assert.equal(bin.status, 0, bin.stderr);
    const binPayload = JSON.parse(bin.stdout) as Record<string, unknown>;
    assert.equal((binPayload["backends"] as unknown[]).length, 3);
    // C15：兼容入口 zbridge 也必须能执行新命令，而不是只测 version。
    const zbin = spawnSync(process.execPath, [ZBIN, "backends", "list", ...flagsOf(env), "--json"], { encoding: "utf8" });
    assert.equal(zbin.status, 0, zbin.stderr);
    assert.deepEqual(JSON.parse(zbin.stdout), binPayload);
    const zmodels = spawnSync(process.execPath, [ZBIN, "models", "list", "--available", "--backend", "qoder", ...flagsOf(env), "--json"], { encoding: "utf8" });
    assert.equal(zmodels.status, 0, zmodels.stderr);
    assert.deepEqual(JSON.parse(zmodels.stdout), cached.value);
    const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    assert.match(help.stdout, /backends list/);
    assert.match(help.stdout, /schemaVersion=3/);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------- C12 online errors

test("C12：在线目录空目录/不支持/认证失败都有明确来源且不碰允许列表", async () => {
  const env = sdkOnlyEnv("codebuddy");
  const previous = process.env["ZB_CATALOG_SCENARIO"];
  const onlineArgs = ["models", "list", "--available", "--online", "--backend", "codebuddy", "--test-sdk-module", CB_CATALOG, ...flagsOf(env)];
  try {
    process.env["ZB_CATALOG_SCENARIO"] = "empty";
    const empty = await callJson(onlineArgs);
    assert.equal(empty.exitCode, 0, empty.output);
    assert.equal(empty.value["source"], "sdk_catalog");
    assert.deepEqual(empty.value["models"], []);
    assert.deepEqual(empty.value["allowed"], ["native-model-1"], "空目录不改允许列表");

    process.env["ZB_CATALOG_SCENARIO"] = "unsupported";
    const unsupported = await callJson(onlineArgs);
    assert.equal(unsupported.exitCode, 5, unsupported.output);
    assert.equal((unsupported.value["error"] as Record<string, unknown>)["code"], "CATALOG_UNSUPPORTED");

    process.env["ZB_CATALOG_SCENARIO"] = "auth";
    const denied = await callJson(onlineArgs);
    assert.equal(denied.exitCode, 4, denied.output);
    assert.equal((denied.value["error"] as Record<string, unknown>)["code"], "CATALOG_AUTH_FAILED");

    // 失败不覆盖最近一次成功的目录缓存，也不改配置里的允许列表。
    const cache = JSON.parse(readFileSync(join(env.dataRoot, "management", "backends", "codebuddy", "models.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cache["source"], "sdk_catalog");
    assert.deepEqual(cache["models"], []);
    const config = JSON.parse(readFileSync(env.configPath, "utf8")) as Record<string, unknown>;
    const codebuddy = (config["backends"] as Record<string, Record<string, unknown>>)["codebuddy"]!;
    assert.deepEqual((codebuddy["models"] as Record<string, unknown>)["allowed"], ["native-model-1"], "目录失败不得改允许列表");

    const badFlag = await callJson(["models", "list", "--available", "--backend", "codebuddy", "--test-sdk-module", CB_CATALOG, ...flagsOf(env)]);
    assert.equal(badFlag.exitCode, 2, "--test-sdk-module 只允许与 --online 配合");
  } finally {
    if (previous === undefined) delete process.env["ZB_CATALOG_SCENARIO"];
    else process.env["ZB_CATALOG_SCENARIO"] = previous;
    env.cleanup();
  }
});
