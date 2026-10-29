/**
 * 在线模型目录探测（仅 operator 显式 --online）。
 *
 * 只调用锁定 SDK 的目录/账户握手：CodeBuddy `Query.supportedModels()`，
 * Qoder `Daemon.getModels({fetchStrategy:"live"})`。不发送用户 prompt、
 * 不写允许列表、不改默认模型。目录结果由调用方写入缓存并标注来源。
 *
 * 失败分类：SDK 不提供目录接口 → unsupported；认证失败 → auth；
 * 超时 → timeout；其它 → failed。调用方据此给出稳定退出码与错误码。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;

export type CatalogErrorCode = "unsupported" | "auth" | "timeout" | "failed";

export class OnlineCatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "OnlineCatalogError";
    this.code = code;
  }
}

export interface OnlineCatalogInput {
  readonly backendId: "codebuddy" | "qoder";
  readonly executable: string;
  /** Qoder PAT 文件；cli-login 使用 null（CodeBuddy 或 Qoder 浏览器登录）。 */
  readonly authFile: string | null;
  readonly timeoutMs?: number;
  /** **仅供离线测试**：fake SDK 模块绝对路径；生产省略时用锁定包名。 */
  readonly testSdkModuleId?: string;
}

export interface OnlineCatalogResult {
  readonly backendId: "codebuddy" | "qoder";
  readonly source: "sdk_catalog";
  readonly discoveredAt: string;
  readonly models: readonly string[];
}

const MODULE_ID: Readonly<Record<OnlineCatalogInput["backendId"], string>> = {
  codebuddy: "@tencent-ai/agent-sdk",
  qoder: "@qoder-ai/qoder-agent-sdk",
};

async function loadSdk(input: OnlineCatalogInput): Promise<Record<string, unknown>> {
  const specifier = input.testSdkModuleId === undefined
    ? MODULE_ID[input.backendId]
    : pathToFileURL(input.testSdkModuleId).href;
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new OnlineCatalogError(
      "unsupported",
      `无法加载 ${input.backendId} SDK 目录模块：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /auth|forbidden|unauthor/i.test(code)
    ? true
    : /auth|unauthor|forbidden|401|403|login|token|credential/i.test(text);
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          /* 取消信号失败不覆盖超时语义 */
        }
        reject(new OnlineCatalogError("timeout", `在线模型目录查询超过 ${timeoutMs}ms`));
      }, timeoutMs);
      run().then(resolve, reject);
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function normalizeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new OnlineCatalogError("failed", "SDK 返回的模型目录不是数组");
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") throw new OnlineCatalogError("failed", "SDK 返回的模型目录条目不合法");
    const record = item as Record<string, unknown>;
    const value = typeof record["value"] === "string" && record["value"].length > 0
      ? record["value"]
      : typeof record["modelId"] === "string" && record["modelId"].length > 0
        ? record["modelId"]
        // CodeBuddy CLI 2.173.0 的真实 initialize.models 使用 id/name，
        // 与 SDK 类型声明中的 value/displayName 不同。
        : typeof record["id"] === "string" && record["id"].length > 0
          ? record["id"]
          : null;
    if (value === null) throw new OnlineCatalogError("failed", "SDK 返回的模型目录条目缺少 ID");
    seen.add(value);
  }
  return [...seen];
}

async function codebuddyCatalog(input: OnlineCatalogInput, sdk: Record<string, unknown>): Promise<string[]> {
  const query = sdk["query"];
  if (typeof query !== "function") {
    throw new OnlineCatalogError("unsupported", "CodeBuddy SDK 未导出 query()，无法查询模型目录");
  }
  // SDK 的 directExecute 只认 .exe 后缀：与 worker 相同的受控绑定目录。
  const bindingRoot = mkdtempSync(join(tmpdir(), "ocbridge-catalog-"));
  const controller = new AbortController();
  try {
    const binding = join(bindingRoot, "codebuddy.exe");
    symlinkSync(realpathSync(input.executable), binding);
    const created = (query as (params: Record<string, unknown>) => Record<string, unknown>)({
      prompt: "",
      options: {
        pathToCodebuddyCode: binding,
        cwd: process.cwd(),
        settingSources: [],
        permissionMode: "default",
        abortController: controller,
        stderr: () => undefined,
      },
    });
    try {
      if (typeof created["connect"] !== "function" || typeof created["supportedModels"] !== "function") {
        throw new OnlineCatalogError("unsupported", "CodeBuddy SDK 未提供 supportedModels()，该版本不支持目录查询");
      }
      const raw = await withTimeout(async () => {
        await (created["connect"] as () => Promise<void>)();
        return (created["supportedModels"] as () => Promise<unknown>)();
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => controller.abort());
      return normalizeModels(raw);
    } finally {
      // 锁定版本的 return() 只发送 interrupt；目录查询从未迭代，必须显式
      // cleanup() 才会关闭 transport。保留接收者，不能传递未绑定的方法。
      if (typeof created["cleanup"] === "function") {
        await created["cleanup"]();
      } else if (typeof created["return"] === "function") {
        await created["return"]();
      }
    }
  } catch (error) {
    if (error instanceof OnlineCatalogError) throw error;
    throw new OnlineCatalogError(isAuthError(error) ? "auth" : "failed", error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(bindingRoot, { recursive: true, force: true });
  }
}

function qoderToken(authFile: string | null): string {
  if (authFile === null) {
    throw new OnlineCatalogError("auth", "Qoder 在线目录需要 credential-file 认证文件");
  }
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    const token = parsed["accessToken"];
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    /* 下面统一报认证错误，不回显文件内容 */
  }
  throw new OnlineCatalogError("auth", "Qoder 认证文件不可读或缺少 accessToken");
}

async function qoderCatalog(input: OnlineCatalogInput, sdk: Record<string, unknown>): Promise<string[]> {
  const startDaemon = sdk["startDaemon"];
  if (typeof startDaemon !== "function") {
    throw new OnlineCatalogError("unsupported", "Qoder SDK 未导出 startDaemon()，无法查询模型目录");
  }
  let daemon: Record<string, unknown> | null = null;
  try {
    if (input.authFile === null && typeof sdk["qodercliAuth"] !== "function") {
      throw new OnlineCatalogError("unsupported", "Qoder SDK 不支持本机登录复用");
    }
    daemon = await (startDaemon as (options: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      auth: input.authFile === null ? (sdk["qodercliAuth"] as () => unknown)() : { type: "accessToken", accessToken: qoderToken(input.authFile) },
      pathToQoderCLIExecutable: input.executable,
      initializeTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...process.env, QODER_SKIP_DOWNLOAD: "1" },
      debug: true,
      stderr: () => undefined,
    });
    // 真实 CLI 的账号面在显式 auth 完成前可能返回暂时空目录。
    if (typeof daemon["auth"] === "function" && !(await daemon["auth"]())) {
      throw new OnlineCatalogError("auth", "Qoder 本机登录不可用");
    }
    if (typeof daemon["getModels"] !== "function") {
      throw new OnlineCatalogError("unsupported", "Qoder daemon 未提供 getModels()，该版本不支持目录查询");
    }
    const raw = await withTimeout(
      () => (daemon!["getModels"] as (params: Record<string, unknown>) => Promise<unknown>).call(daemon, { fetchStrategy: "live" }),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return normalizeModels(raw);
  } catch (error) {
    if (error instanceof OnlineCatalogError) throw error;
    throw new OnlineCatalogError(isAuthError(error) ? "auth" : "failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (daemon !== null && typeof daemon["stop"] === "function") await daemon["stop"]();
  }
}

/** 查询一次在线模型目录；返回的 models 只含后端原生 ID。 */
async function queryModelCatalog(input: OnlineCatalogInput): Promise<OnlineCatalogResult> {
  const sdk = await loadSdk(input);
  const models = input.backendId === "codebuddy"
    ? await codebuddyCatalog(input, sdk)
    : await qoderCatalog(input, sdk);
  return {
    backendId: input.backendId,
    source: "sdk_catalog",
    discoveredAt: new Date().toISOString(),
    models,
  };
}

// 目录查询也会启动 CLI；单独进程使 import、启动握手、查询和清理均受父进程
// 的总期限与进程组回收约束。不进入消息迭代器，不发送用户 prompt。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as OnlineCatalogInput;
      const result = await queryModelCatalog(input);
      process.stdout.write(`${JSON.stringify({ catalogProtocol: 1, result })}\n`, () => process.exit(0));
    } catch (error) {
      const code = error instanceof OnlineCatalogError ? error.code : isAuthError(error) ? "auth" : "failed";
      // SDK 错误文本可能含 token；只把稳定分类送给管理命令。
      process.stdout.write(`${JSON.stringify({ catalogProtocol: 1, error: code })}\n`, () => process.exit(0));
    }
  })();
}
