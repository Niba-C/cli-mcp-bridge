/** 在线目录的受管入口：SDK/CLI 在独占进程组内运行，返回前确认已收尾。 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OnlineCatalogError, type CatalogErrorCode, type OnlineCatalogInput, type OnlineCatalogResult } from "./model-catalog-worker.ts";

export { OnlineCatalogError };
export type { CatalogErrorCode, OnlineCatalogInput, OnlineCatalogResult };

const WORKER = fileURLToPath(new URL("./model-catalog-worker.ts", import.meta.url));
const MESSAGES: Record<CatalogErrorCode, string> = {
  unsupported: "锁定 SDK 不提供所需的模型目录接口",
  auth: "SDK 目录认证失败，请核对本机认证配置",
  timeout: "在线模型目录查询超时，目录进程已回收",
  failed: "SDK 目录查询或清理失败，保留最近一次成功缓存",
};
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as { code?: string }).code !== "ESRCH"; }
}

async function reclaim(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!groupAlive(pid)) return;
    try { process.kill(-pid, signal); } catch { /* 最后以存活检查确认 */ }
    const deadline = Date.now() + (signal === "SIGTERM" ? 400 : 1_000);
    while (groupAlive(pid) && Date.now() < deadline) await delay(25);
  }
  if (groupAlive(pid)) throw new OnlineCatalogError("failed", "目录进程尚未确认退出，未更新缓存");
}

function decode(output: string, backendId: OnlineCatalogInput["backendId"]): OnlineCatalogResult {
  for (const line of output.trim().split("\n").reverse()) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (raw === null || typeof raw !== "object") continue;
    const reply = raw as Record<string, unknown>;
    if (reply["catalogProtocol"] !== 1) continue;
    const code = reply["error"];
    if (typeof code === "string" && Object.hasOwn(MESSAGES, code)) {
      throw new OnlineCatalogError(code as CatalogErrorCode, MESSAGES[code as CatalogErrorCode]);
    }
    const result = reply["result"] as OnlineCatalogResult | undefined;
    if (result?.backendId === backendId && result.source === "sdk_catalog" && typeof result.discoveredAt === "string" &&
      Array.isArray(result.models) && result.models.every((model) => typeof model === "string")) return result;
    break;
  }
  throw new OnlineCatalogError("failed", MESSAGES.failed);
}

/** 总期限覆盖 SDK import、CLI 启动、目录查询和清理；查询不发送 prompt。 */
export async function fetchOnlineModelCatalog(input: OnlineCatalogInput): Promise<OnlineCatalogResult> {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-catalog-run-"));
  const inputFile = join(root, "request.json");
  writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600 });
  const worker = spawn(process.execPath, [WORKER, inputFile], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, TMPDIR: root,
      ...(input.backendId === "qoder" && input.authFile === null ? {} : { QODER_CONFIG_DIR: join(root, "qoder"), QODERCN_CONFIG_DIR: join(root, "qoder") }),
      QODER_SKIP_DOWNLOAD: "1" },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      timer = setTimeout(() => reject(new OnlineCatalogError("timeout", MESSAGES.timeout)), input.timeoutMs ?? 30_000);
      worker.stdout!.setEncoding("utf8");
      worker.stdout!.on("data", (chunk: string) => {
        if (stdout.length + chunk.length > 1_048_576) {
          reject(new OnlineCatalogError("failed", "SDK 目录响应超过大小限制"));
          return;
        }
        stdout += chunk;
      });
      worker.once("error", () => reject(new OnlineCatalogError("failed", MESSAGES.failed)));
      worker.once("close", (code) => code === 0 ? resolve(stdout) : reject(new OnlineCatalogError("failed", MESSAGES.failed)));
    });
    return decode(output, input.backendId);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await reclaim(worker.pid); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}
