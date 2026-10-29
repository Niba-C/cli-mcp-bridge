#!/usr/bin/env node
/**
 * OC-04 生产入口测试用的 OpenCode 可执行替身（**只用于离线测试**）。
 *
 * daemon start --opencode <本文件> 时，worker.ts 会以固定的
 * `serve --hostname 127.0.0.1 --port 0 --pure --log-level WARN` 参数和最小 env
 * （OPENCODE_CONFIG／OPENCODE_SERVER_PASSWORD 等）启动它。替身把调用转给
 * `tests/fixtures/oc03-fake-opencode.ts`（完全不联网、不调用模型），并把它的
 * stdout（监听地址行）原样转发给 worker 解析。
 *
 * 场景可用环境变量 ZB_OC04_SHIM_SCENARIO 覆盖，默认 text-happy。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 管理命令会先跑 `<exe> --version` 校验锁定版本；替身必须在启动服务前回答。
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("1.18.32\n");
  process.exit(0);
}

const fixture = fileURLToPath(new URL("./oc03-fake-opencode.ts", import.meta.url));
const scenario = process.env["ZB_OC04_SHIM_SCENARIO"] ?? "text-happy";
const logDir = mkdtempSync(join(tmpdir(), "oc04-shim-log-"));
const logPath = join(logDir, "requests.jsonl");
writeFileSync(logPath, "");

const child = spawn(process.execPath, [fixture, "--log", logPath, "--scenario", scenario], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.setEncoding("utf8");
child.stdout?.on("data", (chunk) => {
  // worker 从自身 stdout 解析监听地址：必须原样转发。
  process.stdout.write(chunk);
});
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // 已退出。
    }
  });
}
child.on("exit", () => {
  try {
    rmSync(logDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响退出码。
  }
  process.exit(0);
});

