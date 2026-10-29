import fs from "node:fs";
import { spawn } from "node:child_process";

const scenario = () => process.env.ZB_CATALOG_LIFECYCLE_SCENARIO ?? "ok";
const log = (value) => fs.appendFileSync(process.env.ZB_CATALOG_LIFECYCLE_LOG, `${JSON.stringify(value)}\n`);

class Catalog {
  constructor(options) {
    this.options = options;
    this.child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    log({ kind: "spawn", pid: this.child.pid });
  }
  async connect() {
    if (scenario() === "hang-connect") await new Promise(() => {});
  }
  async supportedModels() {
    if (scenario() === "malformed") return { error: "invalid catalog" };
    if (scenario() === "hang-query") await new Promise(() => {});
    return [{ value: "lifecycle-model" }];
  }
  async getModels() { return this.supportedModels(); }
  async return() {
    // 锁定 CodeBuddy SDK 的 return 只中断，不关闭 transport。
    log({ kind: "interrupt", receiver: this instanceof Catalog });
  }
  cleanup() {
    this.child.kill("SIGKILL");
    log({ kind: "closed", backend: "codebuddy" });
  }
  async stop() {
    if (scenario() === "hang-cleanup") await new Promise(() => {});
    this.child.kill("SIGKILL");
    log({ kind: "closed", backend: "qoder" });
  }
}

export function query(params) { return new Catalog(params.options); }
export async function startDaemon(options) {
  if (scenario() === "startup-auth") throw new Error("authentication_failed: controlled offline error");
  const created = new Catalog(options);
  if (scenario() === "hang-start") await new Promise(() => {});
  return created;
}
