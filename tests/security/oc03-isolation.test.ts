import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ZBridgeError } from "../../src/contracts/errors.ts";
import { assertLoopbackUrl, pinnedServeCommand } from "../../src/backend/opencode/worker.ts";
import { buildControlledConfig } from "../../src/backend/opencode/profile.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const adapterDir = join(repoRoot, "src", "backend", "opencode");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => path.endsWith(".ts"));
}

test("adapter 自身不写死安装路径，也不接受外部 baseUrl", () => {
  const files = sourceFiles(adapterDir);
  assert.ok(files.length >= 8, "缺少 adapter 分层文件");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("/opt/homebrew/bin/opencode"), false, `${file} 不能写死真实安装路径`);
  }
  // 地址只能来自「自己 spawn 出来的 worker」；adapter 选项里没有 baseUrl/url 字段。
  const adapter = readFileSync(join(adapterDir, "adapter.ts"), "utf8");
  assert.equal(adapter.includes("options.baseUrl"), false, "adapter 不能从调用方选项读 baseUrl");
  assert.equal(/readonly\s+baseUrl\?/.test(adapter), false, "adapter 选项不能暴露 baseUrl");
  assert.equal(/readonly\s+url\?/.test(adapter), false, "adapter 选项不能暴露 url");
});

test("worker 命令固定：hostname 只允许 127.0.0.1，参数不可注入", () => {
  const command = pinnedServeCommand("/opt/homebrew/bin/opencode");
  assert.deepEqual([...command.args], [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
    "--pure",
    "--log-level",
    "WARN",
  ]);
  assert.equal(command.args.includes("--hostname"), true);
  assert.equal(command.args[command.args.indexOf("--hostname") + 1], "127.0.0.1");
});

test("拒绝非 loopback 与 https 地址（不接受共享服务或远程地址）", () => {
  assert.equal(assertLoopbackUrl("http://127.0.0.1:4096"), "http://127.0.0.1:4096");
  assert.equal(assertLoopbackUrl("http://[::1]:4096"), "http://[::1]:4096");
  for (const url of [
    "http://0.0.0.0:4096",
    "http://192.168.1.10:4096",
    "http://localhost:4096",
    "https://127.0.0.1:4096",
    "http://evil.example.com:4096",
  ]) {
    assert.throws(
      () => assertLoopbackUrl(url),
      (error: unknown) => error instanceof ZBridgeError && error.code === "BACKEND_PROTOCOL_MISMATCH",
      url,
    );
  }
});

test("受控配置不引用其它供应商，也不带任何凭据字段", () => {
  const config = buildControlledConfig({
    providers: { minimax: { options: { apiKey: "sk-test-placeholder-not-real" } } },
    defaultModelRef: "minimax/MiniMax-M3.1-Flash",
    policyProfile: "review",
  });
  assert.deepEqual(Object.keys(config["provider"] as Record<string, unknown>), ["minimax"]);
  assert.deepEqual(config["enabled_providers"], ["minimax"]);
  const permission = config["permission"] as Record<string, string>;
  assert.equal(Array.isArray(permission), false);
  assert.equal(permission["*"], "deny");
  // 顶层不能出现凭证字段（provider.options 是供应商自己的配置，不属于这里）。
  for (const key of ["apiKey", "token", "password", "auth"]) {
    assert.equal(Object.hasOwn(config, key), false, `顶层不能有 ${key}`);
  }
});

test("live 入口默认拒绝：没有显式开关时不能触发任何真实调用", () => {
  for (const file of ["tests/live/live-guard.ts"]) {
    const env = { ...process.env };
    delete env["ZB_LIVE"];
    const refused = spawnSync(process.execPath, [join(repoRoot, file)], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(refused.status, 3, `${file} 未设置开关时必须退出 3`);

    const enabled = spawnSync(process.execPath, [join(repoRoot, file)], {
      env: { ...process.env, ZB_LIVE: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    // 旧闸门在开关打开时仍然拒绝；新入口要求专用开关且必须在 npm test 之外运行。
    assert.equal(enabled.status, 3, `${file} 打开 ZB_LIVE 也不能静默执行产品真实验证`);
  }
});

test("OC-03 live 入口默认拒绝：没有 ZB_OC03_LIVE=1 时不启动任何东西", () => {
  const env = { ...process.env };
  delete env["ZB_OC03_LIVE"];
  const refused = spawnSync(process.execPath, [join(repoRoot, "tests", "live", "oc03-live.ts")], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /拒绝执行/);

  // 打开开关但缺少受控供应商配置：仍然停在参数校验，不启动 OpenCode。
  const missingConfig = spawnSync(process.execPath, [join(repoRoot, "tests", "live", "oc03-live.ts")], {
    env: { ...process.env, ZB_OC03_LIVE: "1" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(missingConfig.status, 4);
  assert.match(missingConfig.stderr, /provider-config/);
});

test("OC-09 真实 MCP 验收默认关闭，普通测试不会发起模型任务", () => {
  const env = { ...process.env };
  delete env["ZB_OC09_LIVE"];
  const refused = spawnSync(process.execPath, [join(repoRoot, "tests", "live", "oc09-mcp-live.mjs")], {
    env, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /ZB_OC09_LIVE/);
});

test("offline 测试不把真实安装路径当可执行文件：只有 live 入口可以", () => {
  const self = fileURLToPath(import.meta.url);
  const offenders = sourceFiles(join(repoRoot, "tests"))
    .filter((file) => !file.includes(`${join("tests", "live")}`) && file !== self)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        /executable\s*:\s*"\/opt\/homebrew\/bin\/opencode"/.test(source) ||
        /pinnedServeCommand\(\s*"\/opt\/homebrew/.test(source) ||
        /spawn\(\s*"\/opt\/homebrew/.test(source)
      );
    });
  assert.deepEqual(offenders, [], "离线测试不能把真实 opencode 安装路径交给进程或 worker");
});
