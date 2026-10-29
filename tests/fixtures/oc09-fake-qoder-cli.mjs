#!/usr/bin/env node
// OC-09 管理测试专用 Qoder CLI 替身：只回答锁定版本，不执行任何任务。
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("1.1.78\n");
}
process.exit(0);
