#!/usr/bin/env node
// OC-09 管理测试专用 CodeBuddy CLI 替身：只回答锁定版本，不执行任何任务。
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("2.173.0\n");
}
process.exit(0);
