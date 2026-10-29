#!/usr/bin/env node
// 兼容入口；Node 24 直接运行 TypeScript 源码。
import("../src/cli/main.ts").catch((error) => {
  process.stderr.write(`zbridge 启动失败: ${error?.message ?? error}\n`);
  process.exit(1);
});
