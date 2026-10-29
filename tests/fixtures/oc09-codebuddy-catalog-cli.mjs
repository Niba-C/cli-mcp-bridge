#!/usr/bin/env node
// 锁定的真实 SDK 连接此受控 CLI；只实现目录握手，不接触账户或网络。
import fs from "node:fs";
import { createInterface } from "node:readline";
const log = (value) => fs.appendFileSync(process.env.ZB_CATALOG_LIFECYCLE_LOG, `${JSON.stringify(value)}\n`);
log({ kind: "spawn", pid: process.pid });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  log({ kind: "request", type: message.type, subtype: message.request?.subtype });
  if (message.type === "control_request") {
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id,
      // 真实 CodeBuddy CLI 2.173.0 的 initialize.models 使用 id/name。
      response: { models: [{ id: "actual-sdk-catalog-model", name: "Offline fixture" }], commands: [] },
    } })}\n`);
  }
});
lines.on("close", () => process.exit(0));
