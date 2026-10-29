#!/usr/bin/env node
// 本机管理入口；与兼容命令 zbridge 共用实现。
import("../src/cli/main.ts").catch((error) => {
  process.stderr.write(`ocbridge 启动失败: ${error?.message ?? error}\n`);
  process.exit(1);
});
