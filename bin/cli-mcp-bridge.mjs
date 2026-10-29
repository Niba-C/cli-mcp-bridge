#!/usr/bin/env node
// 主命令；Node 24 直接运行 TypeScript 源码。
import("../src/cli/main.ts").catch((error) => {
  process.stderr.write(`cli-mcp-bridge 启动失败: ${error?.message ?? error}\n`);
  process.exit(1);
});
