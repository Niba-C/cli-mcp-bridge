import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const workDir = join(repoRoot, ".tmp", `cli-${process.pid}`);

function cli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(repoRoot, "src", "cli", "main.ts"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("version --json 报告契约版本、配置版本与基线", () => {
  const { status, stdout } = cli(["version", "--json"]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(payload["contractVersion"], "2");
  assert.equal(payload["name"], "cli-mcp-bridge");
  assert.equal(payload["displayName"], "CLI MCP Bridge");
  assert.equal(payload["configSchemaVersion"], 3);
  assert.equal(typeof payload["nodeVersion"], "string");
});

test("tools list 显示 12 个已实现工具（OC-05 后与 MCP tools/list 集合一致）", () => {
  const { status, stdout } = cli(["tools", "list", "--json"]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout) as { registrableCount: number; tools: Array<{ implemented: boolean }> };
  assert.equal(payload.registrableCount, 12);
  assert.ok(payload.tools.length >= 12);
  assert.equal(payload.tools.every((tool) => tool.implemented === true), true);
});

test("fake run 输出确定性的终态摘要", () => {
  const first = cli(["fake", "run", "--scenario", "happy-path", "--json"]);
  const second = cli(["fake", "run", "--scenario", "happy-path", "--json"]);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout, "同一场景两次 CLI 输出应完全一致");
  const payload = JSON.parse(first.stdout) as { state: string; stopReason: string };
  assert.equal(payload.state, "completed");
  assert.equal(payload.stopReason, "turn_complete");
});

test("late-terminal：CLI 输出的是归约后的状态，不是后端自报的 completed", () => {
  const { status, stdout } = cli([
    "fake",
    "run",
    "--scenario",
    "late-terminal",
    "--stop-after-ms",
    "200",
    "--json",
  ]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout) as {
    state: string;
    backendReportedState: string;
    terminalObservedAfterStop: boolean;
    rejectedTerminal: string | null;
    transitions: string[];
  };
  assert.equal(payload.terminalObservedAfterStop, true);
  assert.equal(payload.backendReportedState, "completed");
  assert.equal(payload.state, "cancelled", "产品状态必须是 cancelled，不能被晚到终态改写");
  assert.equal(payload.rejectedTerminal, "completed");
  assert.deepEqual(payload.transitions, ["stopping", "cancelled"]);
});

test("未知参数不再被静默接受（exit 2）", () => {
  // 逐项覆盖在 tests/unit/args.test.ts（纯函数）；这里只留一个端到端代表用例，
  // 避免为此多起 4 个进程（本机每次冷启动约 3.8 s）。
  const { status, stderr } = cli(["tools", "list", "--bogus", "x"]);
  assert.equal(status, 2);
  assert.match(stderr, /未知参数 --bogus/);
});

test("缺值参数同样是用法错误（exit 2）", () => {
  const { status } = cli(["fake", "run", "--scenario", "happy-path", "--dry-run"]);
  assert.equal(status, 2);
});

test("未知场景是用法错误（exit 2），不是内部错误", () => {
  const { status, stderr } = cli(["fake", "run", "--scenario", "nope"]);
  assert.equal(status, 2);
  assert.match(stderr, /未知场景/);
});

test("非法的 --stop-intent 也是用法错误", () => {
  const { status } = cli(["fake", "run", "--scenario", "happy-path", "--stop-intent", "yolo"]);
  assert.equal(status, 2);
});

test("未知命令返回用法错误码 2", () => {
  const { status, stderr } = cli(["deploy-everything"]);
  assert.equal(status, 2);
  assert.match(stderr, /未知命令/);
});

test("config init 不覆盖已有文件，validate 能读回", () => {
  mkdirSync(workDir, { recursive: true });
  const configPath = join(workDir, "config.json");

  const created = cli(["config", "init", "--out", configPath]);
  assert.equal(created.status, 0);
  assert.equal(existsSync(configPath), true);

  const again = cli(["config", "init", "--out", configPath]);
  assert.equal(again.status, 4, "默认拒绝覆盖");

  const validated = cli(["config", "validate", "--file", configPath, "--json"]);
  assert.equal(validated.status, 0);
  const payload = JSON.parse(validated.stdout) as { ok: boolean; schemaVersion: number };
  assert.equal(payload.ok, true);
  assert.equal(payload.schemaVersion, 3);

  const content = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(content["mode"], "personal");
  assert.equal(content["defaultBackend"], "opencode");
  assert.deepEqual(content["backends"], {
    opencode: {
      adapter: "opencode-http",
      enabled: true,
      pinnedVersion: "1.18.32",
      executable: null,
      providerConfigFile: null,
      modelProfiles: { default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" } },
    },
  });
});

test("旧 schemaVersion=1 的配置被明确拒绝，不静默迁移", () => {
  mkdirSync(workDir, { recursive: true });
  const badPath = join(workDir, "legacy.json");
  writeFileSync(
    badPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "personal",
      backend: { adapter: "zcode-acp", pinnedVersion: "0.72.0", modelProfiles: ["default"] },
      workspaces: [],
    }),
    "utf8",
  );
  const { status, stdout } = cli(["config", "validate", "--file", badPath, "--json"]);
  assert.equal(status, 4);
  const payload = JSON.parse(stdout) as { ok: boolean; issues: string[] };
  assert.equal(payload.ok, false);
  assert.ok(payload.issues.some((issue) => issue.includes("schemaVersion") && issue.includes("重建")));
  assert.ok(payload.issues.some((issue) => issue.includes("旧后端已归档")));
});

test("结构不完整的配置返回前置条件失败 4 并指出问题", () => {
  mkdirSync(workDir, { recursive: true });
  const badPath = join(workDir, "bad.json");
  writeFileSync(badPath, JSON.stringify({ schemaVersion: 2, mode: "personal", backend: {}, workspaces: [] }), "utf8");
  const { status, stdout } = cli(["config", "validate", "--file", badPath, "--json"]);
  assert.equal(status, 4);
  const payload = JSON.parse(stdout) as { ok: boolean; issues: string[] };
  assert.equal(payload.ok, false);
  assert.ok(payload.issues.length > 0);
});

test("bin/zbridge.mjs 可执行入口与源码入口行为一致", () => {
  const result = spawnSync(process.execPath, [join(repoRoot, "bin", "zbridge.mjs"), "version", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout)["contractVersion"], "2");
});
