/** 本机操作者的便捷入口；复用 daemon 命令，不向 MCP 暴露管理操作。 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  buildModelGate,
  MODEL_REF_RE,
  modelRef,
  parseModelRef,
  parseProviderConfigFile,
} from "../backend/opencode/profile.ts";
import type { ModelSelection } from "../contracts/backend.ts";
import {
  checkNativeModelId,
  configTemplate,
  validateConfigObject,
  type BackendConfigEntry,
  type ProductConfig,
} from "../contracts/config.ts";
import { canonicalJson } from "../contracts/json.ts";
import {
  CODEBUDDY_ADAPTER_ID,
  CODEBUDDY_PINNED_CLI_VERSION,
  CONFIG_SCHEMA_VERSION,
  OPENCODE_ADAPTER_ID,
  OPENCODE_PINNED_VERSION,
  QODER_ADAPTER_ID,
  QODER_PINNED_CLI_VERSION,
  isBackendId,
  type BackendId,
} from "../contracts/version.ts";
import { backendEntryFingerprint, privateFileDigest, providerEntriesDigest } from "../core/config-fingerprint.ts";
import { defaultDataRoot, resolveDataPaths } from "../core/paths.ts";
import { ipcCall } from "../daemon/ipc.ts";
import { resolveDaemonPaths } from "../daemon/layout.ts";
import { InstanceLock, isProcessAlive } from "../daemon/lock.ts";
import { assertKnownFlags, optionalString, UsageError, type ParsedArgs } from "./args.ts";
import { fetchOnlineModelCatalog, OnlineCatalogError, type OnlineCatalogResult } from "./model-catalog.ts";
import type { CommandResult } from "./commands.ts";

type Flags = ParsedArgs["flags"];
type Delegate = (positional: readonly string[], flags: Flags) => Promise<CommandResult>;
type ObjectValue = Record<string, unknown>;

const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  refused: 3,
  precondition: 4,
  unsupported: 5,
} as const;

const PATH_FLAGS = ["config", "data-dir", "provider-config"];
const BACKEND_KEYS = ["opencode", "codebuddy", "qoder"] as const;
const PINNED_VERSION: Readonly<Record<BackendId, string>> = {
  opencode: OPENCODE_PINNED_VERSION,
  codebuddy: CODEBUDDY_PINNED_CLI_VERSION,
  qoder: QODER_PINNED_CLI_VERSION,
};
const ADAPTER_ID: Readonly<Record<BackendId, string>> = {
  opencode: OPENCODE_ADAPTER_ID,
  codebuddy: CODEBUDDY_ADAPTER_ID,
  qoder: QODER_ADAPTER_ID,
};
const RESTART_NOTE = "配置已保存；执行 ocbridge restart 后生效（已有会话保留原选择）。";

/** 管理命令的可预期失败：带稳定退出码与错误码，不把内部异常直接抛给入口。 */
class ManagementError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly details: ObjectValue | undefined;

  constructor(exitCode: number, code: string, message: string, details?: ObjectValue) {
    super(message);
    this.name = "ManagementError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export function managementPaths(flags: Flags, home: string = homedir()) {
  const dir = join(home, ".config", "opencode-bridge");
  return {
    config: resolve(optionalString(flags, "config") ?? join(dir, "config.json")),
    data: resolve(optionalString(flags, "data-dir") ?? defaultDataRoot(home)),
    provider: resolve(optionalString(flags, "provider-config") ?? join(dir, "minimax-provider.json")),
  };
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSONC 的注释／尾逗号只在字符串外处理；错误不回显可能含凭据的原文。 */
export function parseJsonc(text: string): unknown {
  const chars = [...text.replace(/^\uFEFF/, "")];
  let inString = false;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "/" && chars[i + 1] === "/") {
      for (; i < chars.length && chars[i] !== "\n"; i += 1) chars[i] = " ";
    } else if (c === "/" && chars[i + 1] === "*") {
      chars[i++] = " ";
      chars[i++] = " ";
      for (; i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/"); i += 1) chars[i] = " ";
      if (i >= chars.length) throw new UsageError("JSONC 块注释未结束");
      chars[i] = " ";
      chars[++i] = " ";
    }
  }
  inString = false;
  for (let i = 0; i < chars.length; i += 1) {
    if (inString) {
      if (chars[i] === "\\") i += 1;
      else if (chars[i] === '"') inString = false;
    } else if (chars[i] === '"') inString = true;
    else if (chars[i] === ",") {
      let next = i + 1;
      while (/\s/.test(chars[next] ?? "x")) next += 1;
      if (chars[next] === "]" || chars[next] === "}") chars[i] = " ";
    }
  }
  try {
    return JSON.parse(chars.join(""));
  } catch {
    throw new UsageError("JSON/JSONC 格式不合法；请检查文件，内容未输出");
  }
}

function readObject(path: string): ObjectValue {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`无法读取配置文件 ${path}`);
  }
  const value = parseJsonc(raw);
  if (!object(value)) throw new UsageError(`配置文件必须是 JSON 对象：${path}`);
  return value;
}

interface LoadedProduct {
  readonly raw: ObjectValue;
  readonly config: ProductConfig;
  readonly sourceSchemaVersion: number;
}

function product(path: string): LoadedProduct {
  let raw: ObjectValue;
  try {
    raw = readObject(path);
  } catch (error) {
    throw new ManagementError(EXIT.precondition, "CONFIG_UNREADABLE", error instanceof Error ? error.message : String(error));
  }
  const checked = validateConfigObject(raw);
  if (!checked.ok) {
    throw new ManagementError(EXIT.precondition, "CONFIG_INVALID", `桥接配置不合法：${checked.issues.join("；")}`);
  }
  return { raw, config: checked.config, sourceSchemaVersion: checked.sourceSchemaVersion };
}

type DiskConfig =
  | ({ readonly ok: true; readonly error: null } & LoadedProduct)
  | { readonly ok: false; readonly error: string; readonly missing: boolean };

function diskConfig(path: string): DiskConfig {
  if (!existsSync(path)) return { ok: false, error: `无法读取配置文件（不存在）: ${path}`, missing: true };
  try {
    const loaded = product(path);
    return { ok: true, error: null, ...loaded };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), missing: false };
  }
}

function requireDiskConfig(path: string): LoadedProduct {
  const disk = diskConfig(path);
  if (!disk.ok) throw new ManagementError(EXIT.precondition, "CONFIG_UNREADABLE", disk.error);
  return disk;
}

function opencodeEntry(config: ProductConfig): Extract<BackendConfigEntry, { adapter: "opencode-http" }> {
  const entry = config.backends["opencode"];
  if (entry === undefined || entry.adapter !== OPENCODE_ADAPTER_ID) {
    throw new ManagementError(
      EXIT.precondition,
      "BACKEND_NOT_CONFIGURED",
      "配置未包含 OpenCode 后端；models 省略 --backend 时固定操作 OpenCode，不静默切换其它后端",
    );
  }
  return entry;
}

function sdkEntry(config: ProductConfig, id: BackendId): Extract<BackendConfigEntry, { adapter: "codebuddy-sdk" | "qoder-sdk" }> {
  const entry = config.backends[id];
  if (entry === undefined) {
    throw new ManagementError(EXIT.precondition, "BACKEND_NOT_CONFIGURED", `后端 ${id} 尚未配置；先执行 backends configure ${id}`);
  }
  if (entry.adapter !== CODEBUDDY_ADAPTER_ID && entry.adapter !== QODER_ADAPTER_ID) {
    throw new ManagementError(EXIT.precondition, "BACKEND_NOT_CONFIGURED", `后端 ${id} 不是 SDK 后端`);
  }
  return entry;
}

function parseBackendId(value: string, label = "--backend"): BackendId {
  if (!isBackendId(value)) throw new UsageError(`${label} 只接受 opencode|codebuddy|qoder`);
  return value;
}

/** 修改 modelProfiles 后写回：v2 磁盘文件保持 v2 结构，v3 写 v3 结构；不趁机强制迁移。 */
function withOpencodeProfiles(raw: ObjectValue, profiles: Record<string, ModelSelection>): ObjectValue {
  if (raw["schemaVersion"] === 2) {
    const backend = object(raw["backend"]) ? raw["backend"] : {};
    return { ...raw, backend: { ...backend, modelProfiles: profiles } };
  }
  const backends = object(raw["backends"]) ? raw["backends"] : {};
  const opencode = object(backends["opencode"]) ? backends["opencode"] : {};
  return { ...raw, backends: { ...backends, opencode: { ...opencode, modelProfiles: profiles } } };
}

function response(flags: Flags, value: ObjectValue, text: string, exitCode: number = EXIT.ok): CommandResult {
  return { exitCode, output: flags["json"] === true ? JSON.stringify(value, null, 2) : text };
}

function failure(flags: Flags, error: ManagementError): CommandResult {
  const body: ObjectValue = {
    ok: false,
    error: {
      code: error.code,
      reason: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return response(flags, body, error.message, error.exitCode);
}

function usageFailure(flags: Flags, error: UsageError): CommandResult {
  return failure(
    flags,
    new ManagementError(EXIT.usage, "USAGE", error.message),
  );
}

async function guarded(flags: Flags, run: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ManagementError) {
      if (flags["json"] === true) return failure(flags, error);
      throw error;
    }
    if (error instanceof UsageError) {
      if (flags["json"] === true) return usageFailure(flags, error);
      throw error;
    }
    throw error;
  }
}

interface ServiceState {
  readonly state: "running" | "stopped" | "unavailable";
  readonly status: ObjectValue | null;
  /** 旧 daemon 不认 management.status；此时只用 daemon.status 的兼容字段。 */
  readonly legacy: boolean;
}

async function serviceState(data: string): Promise<ServiceState> {
  const paths = resolveDaemonPaths(data);
  try {
    const status = (await ipcCall(paths.operatorSocket, "management.status", {}, { timeoutMs: 3_000 })) as ObjectValue;
    return { state: "running", status, legacy: false };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "INVALID_ARGUMENT") {
      try {
        const status = (await ipcCall(paths.operatorSocket, "daemon.status", {}, { timeoutMs: 3_000 })) as ObjectValue;
        return { state: "running", status, legacy: true };
      } catch {
        // 继续按锁/进程判断，下面统一返回 unavailable。
      }
    }
    const held = new InstanceLock(paths.lockFile).peek();
    if (held !== null && !isProcessAlive(held.pid)) return { state: "stopped", status: null, legacy: false };
    return { state: held !== null || existsSync(paths.lockFile) ? "unavailable" : "stopped", status: null, legacy: false };
  }
}

function saveFile(path: string, text: string): string | null {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const backupPath = existsSync(path) ? `${path}.bak-${suffix}` : null;
  if (backupPath !== null) {
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
    chmodSync(backupPath, 0o600);
  }
  const temp = `${path}.${suffix}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return backupPath;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configuredModels(value: unknown): ObjectValue {
  return object(value) && object(value["models"]) ? value["models"] : {};
}

function hasModel(providers: Readonly<ObjectValue>, ref: string): boolean {
  const { providerID, modelID } = parseModelRef(ref);
  return Object.hasOwn(configuredModels(providers[providerID]), modelID);
}

function requireAbsoluteFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new UsageError(`${label}必须是绝对路径`);
  const absolute = resolve(path);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new ManagementError(EXIT.precondition, "FILE_NOT_FOUND", `${label}不存在: ${absolute}`);
  }
  if (!statSync(real).isFile()) throw new ManagementError(EXIT.precondition, "FILE_NOT_REGULAR", `${label}不是普通文件: ${absolute}`);
  return real;
}

function requireAbsoluteExecutable(path: string, label: string): string {
  if (!isAbsolute(path)) throw new UsageError(`${label}必须是绝对路径`);
  const absolute = resolve(path);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new ManagementError(EXIT.precondition, "EXECUTABLE_NOT_FOUND", `${label}不存在: ${absolute}`);
  }
  try {
    accessSync(real, constants.X_OK);
  } catch {
    throw new ManagementError(EXIT.precondition, "EXECUTABLE_NOT_EXECUTABLE", `${label}不可执行: ${absolute}`);
  }
  if (!statSync(real).isFile()) throw new ManagementError(EXIT.precondition, "EXECUTABLE_NOT_FILE", `${label}不是普通文件: ${absolute}`);
  return real;
}

/** 只读取版本号，不进入交互；输出里的其它内容一律不打印。 */
function observedCliVersion(executable: string, expected: string): string {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  if (result.error !== undefined) {
    throw new ManagementError(EXIT.precondition, "CLI_VERSION_UNAVAILABLE", `无法运行 ${executable} --version: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ManagementError(EXIT.precondition, "CLI_VERSION_UNAVAILABLE", `${executable} --version 退出码 ${String(result.status)}`);
  }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/.exec(text);
  const observed = match?.[1];
  if (observed === undefined) {
    throw new ManagementError(EXIT.precondition, "CLI_VERSION_UNKNOWN", `${executable} --version 未输出可识别的语义版本`);
  }
  if (observed !== expected) {
    throw new ManagementError(EXIT.precondition, "CLI_VERSION_MISMATCH", `${executable} 版本为 ${observed}，本适配器只支持 ${expected}`, {
      expected,
      observed,
    });
  }
  return observed;
}

interface CheckedExecutable {
  readonly path: string;
  readonly version: string;
}

function checkedExecutable(raw: string, expected: string): CheckedExecutable {
  const path = requireAbsoluteExecutable(raw, "CLI 可执行文件");
  return { path, version: observedCliVersion(path, expected) };
}

interface SdkAuth {
  readonly mode: "cli-login";
}
interface SdkAuthFile {
  readonly mode: "credential-file";
  readonly file: string;
}
type AuthConfig = SdkAuth | SdkAuthFile;
type SdkEntry = Extract<BackendConfigEntry, { adapter: "codebuddy-sdk" | "qoder-sdk" }>;

/** 认证策略：Qoder 支持浏览器登录复用与凭据文件；CodeBuddy 保留 cli-login。 */
function policyAuth(backend: BackendId, mode: string, authFileFlag: string | undefined): AuthConfig {
  if (mode === "cli-login") {
    if (authFileFlag !== undefined) throw new UsageError("--auth-file 只能与 --auth credential-file 一起使用");
    return { mode: "cli-login" };
  }
  if (mode === "credential-file") {
    if (backend === "codebuddy") {
      throw new ManagementError(
        EXIT.unsupported,
        "AUTH_MODE_UNSUPPORTED",
        "CodeBuddy 当前执行链路只支持 cli-login；credential-file 尚未接入，不能写入配置冒充可用",
      );
    }
    if (authFileFlag === undefined) throw new UsageError("--auth credential-file 需要 --auth-file <绝对路径>");
    return { mode: "credential-file", file: checkedAuthFile(backend, authFileFlag) };
  }
  throw new UsageError("--auth 只接受 cli-login|credential-file");
}

/** Qoder 的 PAT 文件必须含非空 accessToken；只校验形状，不输出内容。 */
function checkedAuthFile(backend: BackendId, raw: string): string {
  const file = requireAbsoluteFile(raw, "认证文件");
  if (backend === "qoder") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new ManagementError(EXIT.precondition, "AUTH_FILE_INVALID", "Qoder 认证文件不是合法 JSON");
    }
    const token = object(parsed) ? parsed["accessToken"] : undefined;
    if (typeof token !== "string" || token.length === 0) {
      throw new ManagementError(EXIT.precondition, "AUTH_FILE_INVALID", "Qoder 认证文件缺少非空 accessToken 字段");
    }
  }
  return file;
}

function assertAuthUsable(backend: BackendId, auth: SdkEntry["auth"]): void {
  if (backend === "qoder") {
    if (auth.mode === "credential-file") checkedAuthFile("qoder", auth.file);
    return;
  }
  if (auth.mode !== "cli-login") {
    throw new ManagementError(EXIT.unsupported, "AUTH_MODE_UNSUPPORTED", "CodeBuddy 只支持 cli-login；credential-file 执行链路尚未接入");
  }
}

interface ProviderState {
  readonly path: string;
  readonly providers: Readonly<ObjectValue>;
}

function readProviderFile(path: string): ProviderState {
  const file = requireAbsoluteFile(path, "供应商配置文件");
  const raw = (() => {
    try {
      return readObject(file);
    } catch (error) {
      throw new ManagementError(EXIT.precondition, "PROVIDER_CONFIG_UNREADABLE", error instanceof Error ? error.message : String(error));
    }
  })();
  let providers: Readonly<ObjectValue>;
  try {
    providers = parseProviderConfigFile(raw);
  } catch (error) {
    throw new ManagementError(
      EXIT.precondition,
      "PROVIDER_CONFIG_INVALID",
      `供应商配置不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: file, providers };
}

interface OpencodePlan {
  readonly executable: string;
  readonly providerPath: string;
  readonly providers: Readonly<ObjectValue>;
}

function assertOpencodeReady(
  entry: Extract<BackendConfigEntry, { adapter: "opencode-http" }>,
  flags: Flags,
): OpencodePlan {
  const executableRaw = optionalString(flags, "opencode") ?? entry.executable;
  if (executableRaw === null || executableRaw === undefined) {
    throw new ManagementError(EXIT.precondition, "OPENCODE_EXECUTABLE_MISSING", "缺少 OpenCode 可执行文件；用 --opencode <绝对路径> 或 backends configure opencode --executable 指定");
  }
  const executable = checkedExecutable(executableRaw, OPENCODE_PINNED_VERSION).path;
  const providerRaw = optionalString(flags, "provider-config") ?? entry.providerConfigFile;
  if (providerRaw === null || providerRaw === undefined) {
    throw new ManagementError(EXIT.precondition, "PROVIDER_CONFIG_MISSING", "缺少 OpenCode 供应商配置文件；用 --provider-config <绝对路径> 或写入配置后再启动");
  }
  const provider = readProviderFile(providerRaw);
  const gate = buildModelGate(entry.modelProfiles);
  if (!Object.hasOwn(provider.providers, gate.defaultModel.providerID)) {
    throw new ManagementError(EXIT.precondition, "PROVIDER_MODEL_MISSING", `供应商配置缺少 default profile 指向的供应商 ${gate.defaultModel.providerID}`);
  }
  for (const ref of gate.allowed) {
    if (!hasModel(provider.providers, ref)) {
      throw new ManagementError(EXIT.precondition, "PROVIDER_MODEL_MISSING", `供应商配置未声明模型 ${ref}；先用 models add --from 导入`);
    }
  }
  return { executable, providerPath: provider.path, providers: provider.providers };
}

interface StartPlan {
  readonly paths: ReturnType<typeof managementPaths>;
  readonly loaded: LoadedProduct;
  readonly startFlags: Record<string, string | true>;
  readonly providerPath: string | null;
}

function prepareStart(flags: Flags, paths: ReturnType<typeof managementPaths>): StartPlan {
  const loaded = requireDiskConfig(paths.config);
  for (const workspace of loaded.config.workspaces) {
    try {
      if (!statSync(workspace.root).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ManagementError(EXIT.precondition, "WORKSPACE_UNREADABLE", `工作区 ${workspace.id} 的目录不存在或不可读：${workspace.root}`);
    }
  }
  const startFlags: Record<string, string | true> = { config: paths.config, "data-dir": paths.data, json: true };
  const opencode = loaded.config.backends["opencode"];
  const opencodeEnabled = opencode !== undefined && opencode.enabled;
  const mentionsOpencode = optionalString(flags, "opencode") !== undefined || optionalString(flags, "provider-config") !== undefined;
  if (mentionsOpencode && !opencodeEnabled) {
    throw new UsageError("OpenCode 未配置或未启用；--opencode/--provider-config 只覆盖 OpenCode，不会作用于 codebuddy/qoder");
  }
  let providerPath: string | null = null;
  for (const id of BACKEND_KEYS) {
    const entry = loaded.config.backends[id];
    if (entry === undefined || !entry.enabled) continue;
    if (entry.adapter === OPENCODE_ADAPTER_ID) {
      const plan = assertOpencodeReady(entry, flags);
      providerPath = plan.providerPath;
      startFlags["provider-config"] = plan.providerPath;
      startFlags["opencode"] = plan.executable;
    } else {
      checkedExecutable(entry.executable, entry.pinnedVersion);
      assertAuthUsable(id, entry.auth);
    }
  }
  return { paths, loaded, startFlags, providerPath };
}

/** 只在服务确实停止后备份；SQLite backup 包含 WAL，不能只复制主文件。 */
async function startupBackup(paths: ReturnType<typeof managementPaths>, plan: StartPlan): Promise<string | null> {
  const sources: Array<{ readonly name: string; readonly path: string }> = [];
  if (existsSync(paths.config)) sources.push({ name: "config.json", path: paths.config });
  if (plan.providerPath !== null && existsSync(plan.providerPath)) {
    sources.push({ name: "opencode-provider.json", path: plan.providerPath });
  }
  for (const id of ["codebuddy", "qoder"] as const) {
    const entry = plan.loaded.config.backends[id];
    if (entry === undefined || !entry.enabled) continue;
    if (entry.adapter !== CODEBUDDY_ADAPTER_ID && entry.adapter !== QODER_ADAPTER_ID) continue;
    if (entry.auth.mode === "credential-file" && existsSync(entry.auth.file)) {
      sources.push({ name: `${id}-auth.json`, path: entry.auth.file });
    }
  }
  const dbPath = resolveDataPaths(paths.data).dbFile;
  if (sources.length === 0 && !existsSync(dbPath)) return null;
  const dest = join(paths.data, "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  for (const source of sources) {
    const target = join(dest, source.name);
    copyFileSync(source.path, target);
    chmodSync(target, 0o600);
  }
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(db, join(dest, "opencode-bridge.sqlite"));
    } finally {
      db.close();
    }
    chmodSync(join(dest, "opencode-bridge.sqlite"), 0o600);
  }
  return dest;
}

interface BackendView {
  readonly id: BackendId;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly default: boolean;
  readonly loaded: boolean | null;
  readonly runtimeState: "not_started" | "running" | "stopped" | "unknown";
  readonly defaultModel: string | null;
  readonly allowedModels: readonly string[];
  readonly configuredVersion: string | null;
  readonly observedVersion: string | null;
  readonly restartRequired: boolean | null;
  readonly appliesOnNextStart: boolean | null;
  readonly differences: readonly string[];
}

interface Snapshot {
  readonly state: ServiceState["state"];
  readonly legacy: boolean;
  readonly status: ObjectValue | null;
  readonly defaultBackend: BackendId | null;
  readonly loadedDefaultBackend: BackendId | null;
  readonly restartRequired: boolean | null;
  readonly appliesOnNextStart: boolean | null;
  readonly backends: readonly BackendView[];
  readonly warnings: readonly string[];
  readonly configError: string | null;
  readonly loadedConfigPath: string | null;
  readonly overrides: ObjectValue | null;
  readonly configFile: string;
  readonly dataDir: string;
}

function backendManagedDetail(status: ObjectValue | null, id: BackendId): ObjectValue | null {
  if (status === null) return null;
  const details = arrayValue(status["backendDetails"]);
  const found = details.find((item) => object(item) && item["id"] === id);
  return object(found) ? found : null;
}

function normalizePath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

function providerDigest(path: string | null): string | null {
  if (path === null) return null;
  try {
    return providerEntriesDigest(readProviderFile(path).providers);
  } catch {
    return "unreadable";
  }
}

function loadedDifferences(entry: BackendConfigEntry, detail: ObjectValue): string[] {
  const differences: string[] = [];
  if (backendEntryFingerprint(entry) !== stringValue(detail["entryFingerprint"])) differences.push("配置项内容变化");
  if (entry.adapter === OPENCODE_ADAPTER_ID) {
    if (stringValue(detail["executableSource"]) !== "cli_override") {
      if (normalizePath(entry.executable) !== normalizePath(detail["executable"])) differences.push("可执行文件路径变化");
    }
    if (stringValue(detail["providerConfigSource"]) !== "cli_override") {
      if (normalizePath(entry.providerConfigFile) !== normalizePath(detail["providerConfigFile"])) {
        differences.push("供应商配置文件路径变化");
      } else if (providerDigest(entry.providerConfigFile) !== stringValue(detail["providerConfigDigest"])) {
        differences.push("供应商配置文件内容变化");
      }
    }
  } else {
    const digest = entry.auth.mode === "credential-file" ? privateFileDigest(entry.auth.file) : null;
    if (digest !== stringValue(detail["privateConfigDigest"])) differences.push("认证引用或私有文件内容变化");
  }
  return differences;
}

function buildSnapshot(
  disk: DiskConfig,
  service: ServiceState,
  configFile: string,
  dataDir: string,
): Snapshot {
  const status = service.status;
  const loadedDefault =
    status !== null && isBackendId(status["defaultBackend"]) ? status["defaultBackend"] : null;
  const overrides = status !== null && object(status["overrides"]) ? status["overrides"] : null;
  const loadedConfigPath = status === null ? null : stringValue(status["loadedConfigPath"]);
  const running = service.state === "running";
  const diskUsable = disk.ok;
  const warnings: string[] = [];
  if (service.legacy) {
    warnings.push("当前 daemon 是旧版本（不识别 management.status）；后端加载状态 unknown，需重启 daemon 后重新查询");
  }
  if (!disk.ok) warnings.push(disk.error);

  const backends: BackendView[] = [];
  for (const id of BACKEND_KEYS) {
    const entry = disk.ok ? disk.config.backends[id] : undefined;
    const detail = backendManagedDetail(status, id);
    const differences: string[] = [];
    let loaded: boolean | null;
    if (service.state === "stopped") {
      loaded = false;
    } else if (service.state === "unavailable" || !diskUsable || service.legacy) {
      loaded = null;
    } else if (entry === undefined) {
      loaded = false;
      if (detail !== null) differences.push("磁盘配置已移除该项");
    } else if (detail === null) {
      loaded = false;
      differences.push("daemon 未加载该项");
    } else {
      differences.push(...loadedDifferences(entry, detail));
      loaded = differences.length === 0;
    }
    const runtimeStateRaw = stringValue(detail?.["runtimeState"]);
    const runtimeState: BackendView["runtimeState"] =
      runtimeStateRaw === "running" || runtimeStateRaw === "stopped" || runtimeStateRaw === "not_started" || runtimeStateRaw === "unknown"
        ? runtimeStateRaw
        : running
          ? "unknown"
          : "not_started";
    const observedVersion = stringValue(detail?.["observedVersion"]);
    const defaultModel = (() => {
      if (entry === undefined) return stringValue(detail?.["defaultModel"]);
      if (entry.adapter === OPENCODE_ADAPTER_ID) return buildModelGate(entry.modelProfiles).defaultRef;
      return entry.models.default;
    })();
    const allowedModels = (() => {
      if (entry === undefined) {
        return arrayValue(detail?.["allowedModels"]).filter((item): item is string => typeof item === "string");
      }
      if (entry.adapter === OPENCODE_ADAPTER_ID) return buildModelGate(entry.modelProfiles).allowed;
      return entry.models.allowed;
    })();
    const restartRequired =
      running && diskUsable && !service.legacy
        ? loaded === false && (entry !== undefined || differences.length > 0)
        : running
          ? null
          : false;
    const appliesOnNextStart = service.state === "stopped" ? true : service.state === "unavailable" ? null : false;
    backends.push({
      id,
      configured: entry !== undefined,
      enabled: entry?.enabled ?? false,
      default: disk.ok && disk.config.defaultBackend === id,
      loaded,
      runtimeState,
      defaultModel,
      allowedModels,
      configuredVersion: entry?.pinnedVersion ?? null,
      observedVersion,
      restartRequired,
      appliesOnNextStart,
      differences,
    });
  }

  const diskDefault = disk.ok ? disk.config.defaultBackend : null;
  let restartRequired: boolean | null;
  if (service.state === "stopped") restartRequired = false;
  else if (service.state === "unavailable" || service.legacy || !diskUsable) restartRequired = null;
  else {
    const defaultChanged = diskDefault !== loadedDefault;
    const anyUnloaded = backends.some(
      (view) => view.loaded === false && (view.configured || view.differences.length > 0),
    );
    restartRequired = defaultChanged || anyUnloaded;
  }
  if (running && diskUsable && !service.legacy && loadedDefault !== null && diskDefault !== null && loadedDefault !== diskDefault) {
    warnings.push(`默认后端已改为 ${diskDefault}；daemon 仍加载 ${loadedDefault}`);
  }
  if (service.state === "stopped" && disk.ok) {
    warnings.push("服务未运行：当前配置将在下次 start 时加载");
  }
  if (overrides !== null) {
    const executableOverride = stringValue(overrides["executable"]);
    const providerOverride = stringValue(overrides["providerConfigFile"]);
    if (executableOverride !== null || providerOverride !== null) {
      warnings.push("本次运行使用了 OpenCode 命令行覆盖；status 只说明覆盖来源，不回写配置文件");
    }
  }

  return {
    state: service.state,
    legacy: service.legacy,
    status,
    defaultBackend: diskDefault,
    loadedDefaultBackend: running && !service.legacy ? loadedDefault : null,
    restartRequired,
    appliesOnNextStart: service.state === "stopped" ? true : service.state === "unavailable" ? null : false,
    backends,
    warnings,
    configError: disk.ok ? null : disk.error,
    loadedConfigPath,
    overrides,
    configFile,
    dataDir,
  };
}

function snapshotJson(snapshot: Snapshot, filter: BackendId | null): ObjectValue {
  const status = snapshot.status ?? {};
  const views = filter === null ? snapshot.backends : snapshot.backends.filter((view) => view.id === filter);
  return {
    ...status,
    running: snapshot.state === "running",
    state: snapshot.state,
    configFile: snapshot.configFile,
    dataDir: snapshot.dataDir,
    loadedConfigPath: snapshot.loadedConfigPath,
    defaultBackend: snapshot.defaultBackend,
    loadedDefaultBackend: snapshot.loadedDefaultBackend,
    restartRequired: snapshot.restartRequired,
    appliesOnNextStart: snapshot.appliesOnNextStart,
    backends: views.map((view) => ({ ...view })),
    warnings: snapshot.warnings,
    configError: snapshot.configError,
    overrides: snapshot.overrides,
  };
}

function snapshotText(snapshot: Snapshot, filter: BackendId | null): string {
  const status = snapshot.status ?? {};
  const queue = arrayValue(status["queue"]).length;
  const lines: string[] = [];
  if (snapshot.state === "running") {
    lines.push(
      `MCP 后台运行中：pid=${String(status["pid"] ?? "?")}，serviceEpoch=${String(status["serviceEpoch"] ?? "?")}，活动任务=${String(status["activeRunId"] ?? "无")}，排队=${queue}，待批=${String(status["pendingApprovals"] ?? 0)}`,
    );
  } else if (snapshot.state === "stopped") {
    lines.push("MCP 后台未启动；执行 ocbridge start");
  } else {
    lines.push("后台状态无法确认（IPC 无响应且锁仍存在）；请先核对服务，不会另起进程");
  }
  const defaultLine =
    snapshot.defaultBackend === null
      ? "默认后端：未知（配置不可读）"
      : `默认后端：${snapshot.defaultBackend}` +
        (snapshot.state === "running"
          ? `（daemon 已加载：${snapshot.legacy ? "旧 daemon，字段未知" : snapshot.loadedDefaultBackend ?? "未知"}）`
          : "");
  const requirement =
    snapshot.restartRequired === true
      ? "；需要重启"
      : snapshot.restartRequired === null
        ? "；加载状态需人工确认"
        : snapshot.appliesOnNextStart === true
          ? "；下次启动加载"
          : "";
  lines.push(`${defaultLine}${requirement}`);
  const views = filter === null ? snapshot.backends : snapshot.backends.filter((view) => view.id === filter);
  for (const view of views) {
    const stateText = !view.configured
      ? "未配置"
      : view.enabled
        ? "已启用"
        : "已禁用";
    const loadedText = view.loaded === null ? "unknown" : view.loaded ? "已加载" : "未加载";
    const differences = view.differences.length === 0 ? "" : `；差异：${view.differences.join("、")}`;
    lines.push(
      `- ${view.id}: ${stateText}，加载=${loadedText}，运行时=${view.runtimeState}，默认模型=${view.defaultModel ?? "无"}，版本=${view.configuredVersion ?? "无"}（观测 ${view.observedVersion ?? "无"}）${differences}`,
    );
  }
  for (const warning of snapshot.warnings) lines.push(`注意：${warning}`);
  return lines.join("\n");
}

async function waitUntilStopped(data: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await serviceState(data);
    if (state.state === "stopped") return true;
    if (state.state === "unavailable") {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
      continue;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  return false;
}

function busyState(status: ObjectValue | null): boolean {
  if (status === null) return false;
  return (
    status["activeRunId"] != null ||
    arrayValue(status["queue"]).length > 0 ||
    Number(status["pendingApprovals"] ?? 0) > 0
  );
}

async function serviceCommand(action: string, flags: Flags, delegate: Delegate): Promise<CommandResult> {
  const writeAction = action === "start" || action === "restart";
  const allowed =
    action === "status"
      ? ["config", "data-dir", "backend"]
      : writeAction
        ? [...PATH_FLAGS, "opencode", "force"]
        : ["data-dir", "force"];
  assertKnownFlags(flags, allowed);
  if (!["start", "stop", "restart", "status"].includes(action)) throw new UsageError(`未知服务命令 ${action}`);
  const filter = action === "status" && optionalString(flags, "backend") !== undefined
    ? parseBackendId(optionalString(flags, "backend") as string)
    : null;
  const paths = managementPaths(flags);
  const current = await serviceState(paths.data);

  if (action === "status") {
    const snapshot = buildSnapshot(diskConfig(paths.config), current, paths.config, paths.data);
    return response(
      flags,
      snapshotJson(snapshot, filter),
      snapshotText(snapshot, filter),
      current.state === "unavailable" ? EXIT.precondition : EXIT.ok,
    );
  }
  if (current.state === "unavailable") {
    return response(
      flags,
      { ok: false, state: current.state, error: { code: "DAEMON_STATE_UNKNOWN", message: "后台状态无法确认，未停止或启动进程" } },
      "后台状态无法确认，未停止或启动进程；请用 daemon status 核对",
      EXIT.precondition,
    );
  }

  if (action === "start" && current.state === "running") {
    const snapshot = buildSnapshot(diskConfig(paths.config), current, paths.config, paths.data);
    return response(
      flags,
      { ...snapshotJson(snapshot, null), alreadyRunning: true },
      `${snapshotText(snapshot, null)}\nMCP 后台已经运行；加载新配置请用 ocbridge restart`,
    );
  }
  if (action === "stop" && current.state === "stopped") {
    return response(flags, { running: false, alreadyStopped: true }, "MCP 后台已经停止");
  }

  if (action === "start" || action === "restart") {
    // 重启前完整校验；校验失败不停止原服务。
    const plan = prepareStart(flags, paths);
    if (action === "restart" && current.state === "running") {
      if (busyState(current.status) && flags["force"] !== true) {
        return response(
          flags,
          {
            ok: false,
            state: "busy",
            activeRunId: current.status?.["activeRunId"] ?? null,
            queued: arrayValue(current.status?.["queue"]).length,
            pendingApprovals: current.status?.["pendingApprovals"] ?? 0,
          },
          "后台还有任务或待批审批；等待结束，或明确使用 --force 停止",
          EXIT.refused,
        );
      }
      const stopped = await delegate(["daemon", "stop"], { "data-dir": paths.data });
      if (stopped.exitCode !== EXIT.ok) {
        return flags["json"] === true
          ? response(flags, { ok: false, error: { code: "STOP_FAILED", message: stopped.output } }, stopped.output, stopped.exitCode)
          : stopped;
      }
      if (!(await waitUntilStopped(paths.data, 10_000))) {
        return response(
          flags,
          { ok: false, state: "stopping", error: { code: "STOP_UNCONFIRMED", message: "旧 daemon 尚未确认退出；没有启动第二个进程" } },
          "旧 daemon 尚未确认退出，请稍后检查；没有启动第二个进程",
          EXIT.precondition,
        );
      }
    }
    const backupDir = await startupBackup(paths, plan);
    const started = await delegate(["daemon", "start"], plan.startFlags);
    if (started.exitCode !== EXIT.ok) {
      return flags["json"] === true
        ? response(
            flags,
            { ok: false, backupDir, error: { code: "DAEMON_START_FAILED", message: started.output } },
            started.output,
            started.exitCode,
          )
        : started;
    }
    let status: ObjectValue = {};
    try {
      const parsed: unknown = JSON.parse(started.output);
      if (object(parsed)) status = parsed;
    } catch {
      // daemon 已启动但输出不可解析：保持空快照，不伪造字段。
    }
    return response(
      flags,
      {
        ...status,
        state: "running",
        running: true,
        backupDir,
        restartRequired: false,
        appliesOnNextStart: false,
        defaultBackend: plan.loaded.config.defaultBackend,
        loadedDefaultBackend: plan.loaded.config.defaultBackend,
      },
      `MCP 后台已${action === "restart" ? "重启" : "启动"}：pid=${String(status["pid"] ?? "?")}。可以关闭终端。${backupDir === null ? "" : `\n启动前备份：${backupDir}`}`,
    );
  }

  // stop
  if (busyState(current.status) && flags["force"] !== true) {
    return response(
      flags,
      {
        ok: false,
        state: "busy",
        activeRunId: current.status?.["activeRunId"] ?? null,
        queued: arrayValue(current.status?.["queue"]).length,
        pendingApprovals: current.status?.["pendingApprovals"] ?? 0,
      },
      "后台还有任务或待批审批；等待结束，或明确使用 --force 停止",
      EXIT.refused,
    );
  }
  const stopped = await delegate(["daemon", "stop"], { "data-dir": paths.data });
  if (stopped.exitCode !== EXIT.ok) {
    return flags["json"] === true
      ? response(flags, { ok: false, error: { code: "STOP_FAILED", message: stopped.output } }, stopped.output, stopped.exitCode)
      : stopped;
  }
  if (!(await waitUntilStopped(paths.data, 10_000))) {
    return response(
      flags,
      { ok: false, state: "stopping", error: { code: "STOP_UNCONFIRMED", message: "daemon 尚未确认退出" } },
      "daemon 尚未确认退出，请稍后检查",
      EXIT.precondition,
    );
  }
  return response(flags, { running: false, state: "stopped" }, "MCP 后台已停止；桌面应用中的连接会暂时不可用");
}

// ---------------------------------------------------------------- backends

function v3ConfigText(
  raw: ObjectValue,
  loaded: LoadedProduct,
  backends: Record<string, BackendConfigEntry>,
  defaultBackend: BackendId,
): string {
  const next: ObjectValue = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: "personal",
    defaultBackend,
    backends,
    workspaces: raw["workspaces"] ?? loaded.config.workspaces,
    limits: raw["limits"] ?? loaded.config.limits,
    transport: raw["transport"] ?? loaded.config.transport,
  };
  const checked = validateConfigObject(next);
  if (!checked.ok) {
    throw new ManagementError(EXIT.usage, "CONFIG_INVALID", `修改后配置不合法：${checked.issues.join("；")}`);
  }
  return json(next);
}

interface WriteResult {
  readonly changed: boolean;
  readonly backup: string | null;
  readonly migratedFrom: number | null;
}

function writeBackends(
  paths: ReturnType<typeof managementPaths>,
  loaded: LoadedProduct,
  id: BackendId,
  entry: BackendConfigEntry,
  defaultBackend: BackendId = loaded.config.defaultBackend,
): WriteResult {
  const backends: Record<string, BackendConfigEntry> = { ...loaded.config.backends, [id]: entry };
  const text = v3ConfigText(loaded.raw, loaded, backends, defaultBackend);
  const current = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : null;
  if (current === text) return { changed: false, backup: null, migratedFrom: null };
  const backup = saveFile(paths.config, text);
  return {
    changed: true,
    backup,
    migratedFrom: loaded.sourceSchemaVersion === 2 ? 2 : null,
  };
}

function serializeEntry(entry: BackendConfigEntry): BackendConfigEntry {
  return JSON.parse(JSON.stringify(entry)) as BackendConfigEntry;
}

function entriesEqual(a: BackendConfigEntry | undefined, b: BackendConfigEntry): boolean {
  return a !== undefined && canonicalJson(serializeEntry(a)) === canonicalJson(serializeEntry(b));
}

interface ProbeCache {
  readonly backendId: string;
  readonly adapter: string;
  readonly executable: string;
  readonly configuredVersion: string;
  readonly observedVersion: string;
  readonly versionMatch: boolean;
  readonly checkedAt: string;
  readonly online: boolean;
  readonly source: "local_cli_probe" | "sdk_catalog_probe";
  readonly capabilities: ObjectValue;
  readonly models: {
    readonly source: "unavailable" | "sdk_catalog";
    readonly discoveredAt: string | null;
    readonly available: readonly string[];
  };
}

function probeCachePath(dataRoot: string, id: BackendId): string {
  return join(dataRoot, "management", "backends", id, "probe.json");
}

function modelsCachePath(dataRoot: string, id: BackendId): string {
  return join(dataRoot, "management", "backends", id, "models.json");
}

function readProbeCache(dataRoot: string, id: BackendId): ObjectValue | null {
  const path = probeCachePath(dataRoot, id);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeProbeCache(dataRoot: string, id: BackendId, value: ProbeCache): string {
  const path = probeCachePath(dataRoot, id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temp, json(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  chmodSync(path, 0o600);
  return path;
}

interface ModelsCache {
  readonly source: string;
  readonly discoveredAt: string | null;
  readonly models: readonly string[];
  readonly error: string | null;
}

function writeModelsCache(dataRoot: string, id: BackendId, value: { readonly source: string; readonly discoveredAt: string; readonly models: readonly string[] }): string {
  const path = modelsCachePath(dataRoot, id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temp, json({ source: value.source, discoveredAt: value.discoveredAt, models: value.models }), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  chmodSync(path, 0o600);
  return path;
}

function readModelsCache(dataRoot: string, id: BackendId): ModelsCache {
  const path = modelsCachePath(dataRoot, id);
  if (!existsSync(path)) return { source: "unavailable", discoveredAt: null, models: [], error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(parsed)) throw new Error("not object");
    const models = arrayValue(parsed["models"]).filter((item): item is string => typeof item === "string");
    return {
      source: stringValue(parsed["source"]) ?? "unknown",
      discoveredAt: stringValue(parsed["discoveredAt"]),
      models,
      error: null,
    };
  } catch {
    return { source: "unavailable", discoveredAt: null, models: [], error: "模型目录缓存损坏或不可读" };
  }
}

/** 在线目录查询的稳定错误映射：不把 SDK 内部异常直接抛给入口。 */
async function queryOnlineCatalog(
  flags: Flags,
  id: BackendId,
  entry: SdkEntry,
  executable: string,
): Promise<OnlineCatalogResult> {
  const testSdkModule = optionalString(flags, "test-sdk-module");
  if (testSdkModule !== undefined && !isAbsolute(testSdkModule)) {
    throw new UsageError("--test-sdk-module 必须是绝对路径");
  }
  try {
    return await fetchOnlineModelCatalog({
      backendId: id as "codebuddy" | "qoder",
      executable,
      authFile: entry.auth.mode === "credential-file" ? entry.auth.file : null,
      ...(testSdkModule === undefined ? {} : { testSdkModuleId: testSdkModule }),
    });
  } catch (error) {
    if (error instanceof OnlineCatalogError) {
      if (error.code === "unsupported") {
        throw new ManagementError(EXIT.unsupported, "CATALOG_UNSUPPORTED", `在线模型目录不可用：${error.message}`, { backendId: id });
      }
      if (error.code === "auth") {
        throw new ManagementError(EXIT.precondition, "CATALOG_AUTH_FAILED", `在线目录认证失败：${error.message}`, { backendId: id });
      }
      if (error.code === "timeout") {
        throw new ManagementError(EXIT.precondition, "CATALOG_TIMEOUT", `在线目录查询超时：${error.message}`, { backendId: id });
      }
      throw new ManagementError(EXIT.precondition, "CATALOG_PROBE_FAILED", `在线目录查询失败：${error.message}`, { backendId: id });
    }
    throw error;
  }
}

function declaredCapability(support: "supported" | "unknown" | "unsupported" | "not_applicable", limitation?: string): ObjectValue {  return {
    support,
    verifiedAt: null,
    evidenceRef: null,
    ...(limitation === undefined ? {} : { limitation }),
  };
}

function localCapabilities(id: BackendId): ObjectValue {
  const sdk = id !== "opencode";
  return {
    adapterId: ADAPTER_ID[id],
    methods: {
      health: declaredCapability("supported"),
      createSession: declaredCapability("supported"),
      loadSession: declaredCapability("supported"),
      execute: declaredCapability("supported"),
      stop: declaredCapability("supported"),
      close: declaredCapability("supported"),
      events: declaredCapability(sdk ? "not_applicable" : "supported"),
      resolvePermission: declaredCapability("supported"),
    },
    reviewWriteBlocked: declaredCapability("unknown", "策略为 review 只读，但没有操作系统级只读证据"),
    writeSandbox: declaredCapability(sdk ? "unsupported" : "unknown"),
    controlChannelIsolation: declaredCapability("unknown"),
    usageSource: "backend",
    hardBudget: declaredCapability(id === "opencode" ? "unsupported" : "supported"),
    internalRetry: declaredCapability("unknown"),
    sessionResume: declaredCapability("unknown"),
    evidenceLevel: "declared",
  };
}

function requireBackendEntry(loaded: LoadedProduct, id: BackendId): BackendConfigEntry {
  const entry = loaded.config.backends[id];
  if (entry === undefined) {
    throw new ManagementError(EXIT.precondition, "BACKEND_NOT_CONFIGURED", `后端 ${id} 尚未配置；先执行 backends configure ${id}`);
  }
  return entry;
}

function buildConfiguredEntry(
  id: BackendId,
  existing: BackendConfigEntry | undefined,
  flags: Flags,
  modelFlag: string | undefined,
): { readonly entry: BackendConfigEntry; readonly configuredVersion: string } {
  const executableFlag = optionalString(flags, "executable");
  const authFlag = optionalString(flags, "auth");
  const authFileFlag = optionalString(flags, "auth-file");
  const providerFlag = optionalString(flags, "provider-config");

  if (id !== "opencode" && providerFlag !== undefined) {
    throw new UsageError("--provider-config 仅用于 OpenCode；不能用它给 CodeBuddy/Qoder 导入 provider");
  }
  if (id === "opencode" && (authFlag !== undefined || authFileFlag !== undefined)) {
    throw new UsageError("OpenCode 不使用 --auth/--auth-file；认证由 OpenCode 自身配置管理");
  }

  if (id === "opencode") {
    const providerConfigFile = providerFlag === undefined ? null : requireAbsoluteFile(providerFlag, "供应商配置文件");
    if (providerConfigFile !== null) readProviderFile(providerConfigFile);
    const previous = existing !== undefined && existing.adapter === OPENCODE_ADAPTER_ID ? existing : undefined;
    if (modelFlag !== undefined && previous !== undefined) {
      throw new UsageError("已有 OpenCode 后端的模型请用 models 命令修改，避免隐式重设默认");
    }
    const executableRaw = executableFlag ?? previous?.executable ?? null;
    if (executableRaw === null) throw new UsageError("首次配置 OpenCode 必须提供 --executable <绝对路径>");
    const executable = checkedExecutable(executableRaw, OPENCODE_PINNED_VERSION);
    const modelProfiles = (() => {
      if (previous !== undefined) return previous.modelProfiles;
      if (modelFlag === undefined) throw new UsageError("首次配置 OpenCode 必须提供 --model <providerID/modelID>");
      if (!MODEL_REF_RE.test(modelFlag)) throw new UsageError("--model 必须是 providerID/modelID");
      const selection = parseModelRef(modelFlag);
      return { default: selection };
    })();
    return {
      entry: {
        adapter: OPENCODE_ADAPTER_ID,
        enabled: previous?.enabled ?? true,
        pinnedVersion: OPENCODE_PINNED_VERSION,
        executable: executable.path,
        providerConfigFile: providerConfigFile ?? previous?.providerConfigFile ?? null,
        modelProfiles,
      },
      configuredVersion: executable.version,
    };
  }

  const previous = existing !== undefined && existing.adapter !== OPENCODE_ADAPTER_ID ? existing : undefined;
  if (modelFlag !== undefined && previous !== undefined) {
    throw new UsageError("已有后端修改模型请用 models add/default，避免隐式重设默认");
  }
  const executableRaw = executableFlag ?? previous?.executable;
  if (executableRaw === undefined) throw new UsageError("首次配置该后端必须提供 --executable <绝对路径>");
  const checked = checkedExecutable(executableRaw, PINNED_VERSION[id]);
  const auth = (() => {
    if (authFlag !== undefined) return policyAuth(id, authFlag, authFileFlag);
    if (authFileFlag !== undefined) throw new UsageError("--auth-file 需要同时提供 --auth credential-file");
    if (previous !== undefined) {
      assertAuthUsable(id, previous.auth);
      return previous.auth;
    }
    throw new UsageError("首次配置该后端必须提供 --auth cli-login 或 --auth credential-file --auth-file <绝对路径>");
  })();
  const models = (() => {
    if (previous !== undefined) return previous.models;
    if (modelFlag === undefined) throw new UsageError("首次配置该后端必须提供 --model <后端原生模型 ID>");
    const problem = checkNativeModelId(modelFlag);
    if (problem !== null) throw new UsageError(`--model 不合法：${problem}`);
    return { default: modelFlag, allowed: [modelFlag] };
  })();
  if (id === "codebuddy") {
    return {
      entry: {
        adapter: CODEBUDDY_ADAPTER_ID,
        enabled: previous?.enabled ?? false,
        pinnedVersion: CODEBUDDY_PINNED_CLI_VERSION,
        executable: checked.path,
        auth,
        models,
      },
      configuredVersion: checked.version,
    };
  }
  return {
    entry: {
      adapter: QODER_ADAPTER_ID,
      enabled: previous?.enabled ?? false,
      pinnedVersion: QODER_PINNED_CLI_VERSION,
      executable: checked.path,
      auth,
      models,
    },
    configuredVersion: checked.version,
  };
}

function assertCompleteForEnable(id: BackendId, entry: BackendConfigEntry): void {
  if (entry.adapter === OPENCODE_ADAPTER_ID) {
    if (entry.executable === null) {
      throw new ManagementError(EXIT.precondition, "BACKEND_INCOMPLETE", "OpenCode 缺少 --executable；先执行 backends configure opencode");
    }
    checkedExecutable(entry.executable, OPENCODE_PINNED_VERSION);
    if (entry.providerConfigFile !== null) readProviderFile(entry.providerConfigFile);
    return;
  }
  checkedExecutable(entry.executable, entry.pinnedVersion);
  assertAuthUsable(id, entry.auth);
}

async function backendsCommand(positional: readonly string[], flags: Flags): Promise<CommandResult> {
  const action = positional[1];
  if (action === undefined || !["list", "show", "configure", "enable", "disable", "default", "probe"].includes(action)) {
    throw new UsageError("用法: ocbridge backends <list|show|configure|enable|disable|default|probe> …");
  }
  const paths = managementPaths(flags);
  const id = action === "list" ? null : parseBackendId(positional[2] ?? "", "后端 ID");
  if (action !== "list" && positional.length !== 3) throw new UsageError(`backends ${action} 需要且只需要一个后端 ID`);

  if (action === "list") {
    assertKnownFlags(flags, ["config", "data-dir"]);
    if (positional.length > 2) throw new UsageError("backends list 不接受位置参数");
    const loaded = requireDiskConfig(paths.config);
    const service = await serviceState(paths.data);
    const snapshot = buildSnapshot({ ok: true, error: null, ...loaded }, service, paths.config, paths.data);
    return response(
      flags,
      {
        defaultBackend: snapshot.defaultBackend,
        loadedDefaultBackend: snapshot.loadedDefaultBackend,
        restartRequired: snapshot.restartRequired,
        state: snapshot.state,
        backends: snapshot.backends,
        warnings: snapshot.warnings,
        configFile: paths.config,
      },
      snapshotText(snapshot, null),
    );
  }

  if (action === "show") {
    assertKnownFlags(flags, ["config", "data-dir"]);
    const loaded = requireDiskConfig(paths.config);
    const entry = loaded.config.backends[id as BackendId];
    const service = await serviceState(paths.data);
    const snapshot = buildSnapshot({ ok: true, error: null, ...loaded }, service, paths.config, paths.data);
    const view = snapshot.backends.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      return response(
        flags,
        {
          id,
          configured: false,
          supportedAdapters: ADAPTER_ID[id as BackendId],
          executable: null,
          probe: readProbeCache(paths.data, id as BackendId),
          message: `后端 ${String(id)} 尚未配置；使用 backends configure ${String(id)} …`,
        },
        `后端 ${String(id)} 尚未配置；使用 backends configure ${String(id)} …`,
      );
    }
    const detail: ObjectValue = {
      id,
      configured: true,
      adapter: entry.adapter,
      enabled: entry.enabled,
      default: loaded.config.defaultBackend === id,
      loaded: view?.loaded ?? false,
      restartRequired: view?.restartRequired ?? false,
      runtimeState: view?.runtimeState ?? "unknown",
      defaultModel: view?.defaultModel ?? null,
      allowedModels: view?.allowedModels ?? [],
      configuredVersion: entry.pinnedVersion,
      observedVersion: view?.observedVersion ?? null,
      executable: entry.executable,
      providerConfigFile: entry.adapter === OPENCODE_ADAPTER_ID ? entry.providerConfigFile : null,
      authMode: entry.adapter === OPENCODE_ADAPTER_ID ? null : entry.auth.mode,
      authFile: entry.adapter === OPENCODE_ADAPTER_ID || entry.auth.mode === "cli-login" ? null : entry.auth.file,
      probe: readProbeCache(paths.data, id as BackendId),
      differences: view?.differences ?? [],
    };
    return response(flags, detail, `${String(id)}：${entry.enabled ? "已启用" : "已禁用"}；默认模型=${view?.defaultModel ?? "无"}；版本=${entry.pinnedVersion}`);
  }

  if (action === "configure") {
    assertKnownFlags(flags, ["config", "data-dir", "executable", "model", "auth", "auth-file", "provider-config"]);
    const loaded = requireDiskConfig(paths.config);
    const existing = loaded.config.backends[id as BackendId];
    const modelFlag = optionalString(flags, "model");
    const built = buildConfiguredEntry(id as BackendId, existing, flags, modelFlag);
    if (existing !== undefined && entriesEqual(existing, built.entry)) {
      return response(
        flags,
        {
          changed: false,
          backendId: id,
          configured: true,
          enabled: built.entry.enabled,
          default: loaded.config.defaultBackend === id,
          configuredVersion: built.configuredVersion,
          backup: null,
          message: "配置未变化；未写文件、未增加备份",
        },
        `${String(id)} 配置未变化；未写文件、未增加备份`,
      );
    }
    const written = writeBackends(paths, loaded, id as BackendId, built.entry);
    return response(
      flags,
      {
        changed: written.changed,
        backendId: id,
        configured: true,
        enabled: built.entry.enabled,
        default: loaded.config.defaultBackend === id,
        configuredVersion: built.configuredVersion,
        migratedFrom: written.migratedFrom,
        backup: written.backup,
        restartRequired: true,
      },
      `${String(id)} 已登记：${built.entry.enabled ? "启用" : "禁用"}；锁定版本 ${built.configuredVersion}\n${RESTART_NOTE}${written.backup === null ? "" : `\n备份：${written.backup}`}`,
    );
  }

  if (action === "enable") {
    assertKnownFlags(flags, ["config", "data-dir"]);
    const loaded = requireDiskConfig(paths.config);
    const entry = requireBackendEntry(loaded, id as BackendId);
    if (entry.enabled) {
      return response(flags, { changed: false, backendId: id, enabled: true }, `${String(id)} 已经启用`);
    }
    assertCompleteForEnable(id as BackendId, entry);
    const next = { ...entry, enabled: true } as BackendConfigEntry;
    const written = writeBackends(paths, loaded, id as BackendId, next);
    return response(
      flags,
      { changed: written.changed, backendId: id, enabled: true, default: loaded.config.defaultBackend === id, backup: written.backup },
      `${String(id)} 已启用；默认后端未改变\n${RESTART_NOTE}${written.backup === null ? "" : `\n备份：${written.backup}`}`,
    );
  }

  if (action === "disable") {
    assertKnownFlags(flags, ["config", "data-dir", "replacement"]);
    const loaded = requireDiskConfig(paths.config);
    const entry = requireBackendEntry(loaded, id as BackendId);
    const replacement = optionalString(flags, "replacement");
    const isDefault = loaded.config.defaultBackend === id;
    if (!isDefault && replacement !== undefined) {
      throw new UsageError("--replacement 只在禁用默认后端时使用");
    }
    if (!entry.enabled) {
      return response(flags, { changed: false, backendId: id, enabled: false }, `${String(id)} 已经禁用`);
    }
    let defaultBackend = loaded.config.defaultBackend;
    if (isDefault) {
      if (replacement === undefined) {
        throw new UsageError("禁用默认后端时必须用 --replacement <另一个已启用后端> 指定新默认");
      }
      const replacementId = parseBackendId(replacement, "--replacement");
      if (replacementId === id) throw new UsageError("--replacement 不能是被禁用的后端本身");
      const replacementEntry = loaded.config.backends[replacementId];
      if (replacementEntry === undefined || !replacementEntry.enabled) {
        throw new ManagementError(EXIT.precondition, "REPLACEMENT_NOT_ENABLED", `替代后端 ${replacementId} 未配置或未启用`);
      }
      defaultBackend = replacementId;
    }
    const next = { ...entry, enabled: false } as BackendConfigEntry;
    const written = writeBackends(paths, loaded, id as BackendId, next, defaultBackend);
    return response(
      flags,
      {
        changed: written.changed,
        backendId: id,
        enabled: false,
        defaultBackend,
        backup: written.backup,
        note: "禁用不删除凭据、SQLite 历史、原生会话或工件",
      },
      `${String(id)} 已禁用；默认后端=${defaultBackend}\n${RESTART_NOTE}${written.backup === null ? "" : `\n备份：${written.backup}`}`,
    );
  }

  if (action === "default") {
    assertKnownFlags(flags, ["config", "data-dir"]);
    const loaded = requireDiskConfig(paths.config);
    const entry = requireBackendEntry(loaded, id as BackendId);
    if (!entry.enabled) {
      throw new ManagementError(EXIT.precondition, "BACKEND_DISABLED", `后端 ${String(id)} 已禁用，不能设为默认`);
    }
    if (loaded.config.defaultBackend === id) {
      return response(flags, { changed: false, defaultBackend: id }, `${String(id)} 已经是默认后端`);
    }
    const backends: Record<string, BackendConfigEntry> = { ...loaded.config.backends };
    const text = v3ConfigText(loaded.raw, loaded, backends, id as BackendId);
    const current = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : null;
    const backup = current === text ? null : saveFile(paths.config, text);
    return response(
      flags,
      { changed: current !== text, defaultBackend: id, backup, appliesToNewSessionsOnly: true },
      `默认后端已设为 ${String(id)}；只影响以后新建且省略 backend 的会话\n${RESTART_NOTE}${backup === null ? "" : `\n备份：${backup}`}`,
    );
  }

  // probe
  assertKnownFlags(flags, ["config", "data-dir", "online", "test-sdk-module"]);
  const loaded = requireDiskConfig(paths.config);
  const entry = requireBackendEntry(loaded, id as BackendId);
  const executableRaw = entry.adapter === OPENCODE_ADAPTER_ID ? entry.executable : entry.executable;
  if (executableRaw === null) {
    throw new ManagementError(EXIT.precondition, "EXECUTABLE_MISSING", `后端 ${String(id)} 未记录可执行文件；先执行 backends configure`);
  }
  const checked = checkedExecutable(executableRaw, entry.pinnedVersion);
  if (entry.adapter !== OPENCODE_ADAPTER_ID) assertAuthUsable(id as BackendId, entry.auth);
  if (flags["online"] === true) {
    if (entry.adapter === OPENCODE_ADAPTER_ID) {
      throw new ManagementError(
        EXIT.unsupported,
        "ONLINE_PROBE_UNSUPPORTED",
        "OpenCode 没有 SDK 账户/模型目录握手；在线目录只支持 CodeBuddy/Qoder（--online 未执行任何网络查询）",
      );
    }
    const catalog = await queryOnlineCatalog(flags, id as BackendId, entry, checked.path);
    writeModelsCache(paths.data, id as BackendId, catalog);
    const onlineCache: ProbeCache = {
      backendId: id as string,
      adapter: ADAPTER_ID[id as BackendId],
      executable: checked.path,
      configuredVersion: entry.pinnedVersion,
      observedVersion: checked.version,
      versionMatch: checked.version === entry.pinnedVersion,
      checkedAt: new Date().toISOString(),
      online: true,
      source: "sdk_catalog_probe",
      capabilities: localCapabilities(id as BackendId),
      models: { source: "sdk_catalog", discoveredAt: catalog.discoveredAt, available: catalog.models },
    };
    const onlineCachePath = writeProbeCache(paths.data, id as BackendId, onlineCache);
    return response(
      flags,
      {
        ...onlineCache,
        cachePath: onlineCachePath,
        restartRequired: false,
        note: "在线目录来自 SDK 目录接口；未发送 prompt、未改允许列表；账户实际可用性仍需真实模型验收",
      },
      `${String(id)} 在线探测完成：版本 ${checked.version}（锁定 ${entry.pinnedVersion}）；目录 ${catalog.models.length} 个模型\n能力/目录缓存：${onlineCachePath}\n未发送 prompt、未改允许列表`,
    );
  }
  const cache: ProbeCache = {
    backendId: id as string,
    adapter: ADAPTER_ID[id as BackendId],
    executable: checked.path,
    configuredVersion: entry.pinnedVersion,
    observedVersion: checked.version,
    versionMatch: checked.version === entry.pinnedVersion,
    checkedAt: new Date().toISOString(),
    online: false,
    source: "local_cli_probe",
    capabilities: localCapabilities(id as BackendId),
    models: { source: "unavailable", discoveredAt: null, available: [] },
  };
  const cachePath = writeProbeCache(paths.data, id as BackendId, cache);
  return response(
    flags,
    { ...cache, cachePath, restartRequired: false, note: "本地版本检查不启动 SDK 会话、不发送 prompt" },
    `${String(id)} 探测完成：版本 ${checked.version}（锁定 ${entry.pinnedVersion}）\n能力声明已缓存：${cachePath}\n未启动模型任务，未查询在线账户/模型目录`,
  );
}

// ---------------------------------------------------------------- models

function profilesWithDefault(profiles: Record<string, ModelSelection>, ref: string): void {
  const key = Object.keys(profiles).find((candidate) => modelRef(profiles[candidate]!) === ref);
  if (key === undefined) throw new UsageError("该模型尚未加入允许列表，请先执行 models add");
  if (key !== "default") {
    const old = profiles["default"]!;
    profiles["default"] = profiles[key]!;
    profiles[key] = old;
  }
}

async function opencodeModelsCommand(positional: readonly string[], flags: Flags): Promise<CommandResult> {
  const action = positional[1] ?? "list";
  const allowed =
    action === "add"
      ? [...PATH_FLAGS, "from", "default", "backend", "online"]
      : action === "remove"
        ? [...PATH_FLAGS, "replacement", "backend", "online"]
        : action === "list"
          ? [...PATH_FLAGS, "from", "available", "backend", "online"]
          : [...PATH_FLAGS, "backend", "online"];
  assertKnownFlags(flags, allowed);
  if (!["list", "add", "remove", "default"].includes(action)) {
    throw new UsageError("用法：ocbridge models <list|add|remove|default> [provider/model] [--backend opencode]");
  }
  if (flags["online"] === true) {
    if (!(action === "list" && flags["available"] === true)) {
      throw new UsageError("--online 只允许与 models list --available 配合");
    }
    throw new ManagementError(
      EXIT.unsupported,
      "ONLINE_MODELS_UNSUPPORTED",
      "OpenCode 没有 SDK 目录握手；在线目录只支持 CodeBuddy/Qoder（本次未联网、未改允许列表）",
    );
  }
  const paths = managementPaths(flags);
  const { raw, config } = product(paths.config);
  const gate = buildModelGate(opencodeEntry(config).modelProfiles);
  const providerRaw = existsSync(paths.provider) ? readObject(paths.provider) : null;
  const providers: ObjectValue = providerRaw === null ? {} : { ...parseProviderConfigFile(providerRaw) };
  const from = optionalString(flags, "from");
  let source: ObjectValue | undefined;
  if (from !== undefined) {
    const imported = readObject(resolve(from));
    // 接受 OpenCode 的 provider 字典或 bridge 的 providers／旧 MiniMax 格式，
    // 只取所选供应商，绝不合并 plugin、mcp、permission 等全局设置。
    source = object(imported["provider"]) ? imported["provider"] : { ...parseProviderConfigFile(imported) };
  }
  if (action === "list") {
    if (positional.length > 2) throw new UsageError("models list 不接受模型位置参数");
    const current = await serviceState(paths.data);
    const loaded = current.status?.["models"] ?? null;
    const live = object(loaded) ? loaded : null;
    const restartRequired =
      current.state === "running" &&
      (live === null ||
        live["default"] !== gate.defaultRef ||
        JSON.stringify(live["allowed"]) !== JSON.stringify(gate.allowed));
    const values =
      flags["available"] === true
        ? [...new Set(Object.entries(source ?? providers).flatMap(([id, p]) => Object.keys(configuredModels(p)).map((m) => `${id}/${m}`)))].sort()
        : gate.allowed;
    const unsupportedModels = values.filter((ref) => !MODEL_REF_RE.test(ref));
    const models = values
      .filter((ref) => MODEL_REF_RE.test(ref))
      .map((ref) => ({ model: ref, default: ref === gate.defaultRef, allowed: gate.allows(ref), configured: hasModel(source ?? providers, ref) }));
    return response(
      flags,
      {
        backendId: "opencode",
        default: gate.defaultRef,
        models,
        unsupportedModels,
        loadedModels: loaded,
        restartRequired,
        appliesOnNextStart: current.state === "stopped",
        source: flags["available"] === true ? (from === undefined ? "local_provider" : "from_file") : "local_config",
        discoveredAt: null,
        configFile: paths.config,
        providerConfigFile: paths.provider,
      },
      [
        models.length === 0 ? "本地供应商文件没有声明可选择的模型" : models.map((m) => `${m.default ? "*" : " "} ${m.model}${m.allowed ? "（已允许）" : "（未加入允许列表）"}${m.configured ? "" : " [供应商配置缺失]"}`).join("\n"),
        unsupportedModels.length > 0 ? `当前桥接不接受以下标识：${unsupportedModels.join("、")}` : "",
        restartRequired ? "后台尚未加载当前模型列表，执行 ocbridge restart" : "",
        "* 为新会话默认模型；此查询未调用模型",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (positional.length !== 3) throw new UsageError(`用法：ocbridge models ${action} provider/model`);
  const ref = positional[2]!;
  let selection: ModelSelection;
  try {
    selection = parseModelRef(ref);
  } catch {
    throw new UsageError("OpenCode 模型必须是 provider/model（只允许字母数字、点、下划线、连字符）");
  }
  const profiles: Record<string, ModelSelection> = { ...opencodeEntry(config).modelProfiles };
  let providerChanged = false;
  if (action === "add") {
    if (!gate.allows(ref)) {
      if (Object.keys(profiles).length >= 8) throw new UsageError("允许列表已达 8 个 profile 的上限，请先删除不用的模型");
      let i = 1;
      while (Object.hasOwn(profiles, `model-${i}`)) i += 1;
      profiles[`model-${i}`] = selection;
    }
    if (source !== undefined) {
      const selectedProvider = source[selection.providerID];
      const selectedModels = configuredModels(selectedProvider);
      if (!object(selectedProvider) || !Object.hasOwn(selectedModels, selection.modelID)) {
        throw new UsageError(`来源文件没有声明模型 ${ref}`);
      }
      const existing = providers[selection.providerID];
      const merged = {
        ...(object(existing) ? existing : selectedProvider),
        models: { ...configuredModels(existing), [selection.modelID]: selectedModels[selection.modelID] },
      };
      providers[selection.providerID] = merged;
      parseProviderConfigFile({ providers });
      providerChanged = JSON.stringify(existing) !== JSON.stringify(merged);
    }
    if (!hasModel(providers, ref)) throw new UsageError(`供应商文件未声明 ${ref}；请加 --from <OpenCode配置.json或.jsonc> 导入`);
    if (flags["default"] === true) profilesWithDefault(profiles, ref);
  } else if (action === "default") {
    profilesWithDefault(profiles, ref);
    if (!hasModel(providers, ref)) throw new UsageError(`供应商文件未声明 ${ref}；先用 models add --from 导入`);
  } else {
    if (!gate.allows(ref)) return response(flags, { changed: false, model: ref, backendId: "opencode" }, "该模型已不在允许列表");
    if (ref === gate.defaultRef) {
      const replacement = optionalString(flags, "replacement");
      if (replacement === undefined || replacement === ref) throw new UsageError("删除默认模型时必须指定 --replacement <另一个已允许的模型>");
      try {
        parseModelRef(replacement);
      } catch {
        throw new UsageError("--replacement 必须是 provider/model");
      }
      profilesWithDefault(profiles, replacement);
    }
    for (const [key, value] of Object.entries(profiles)) if (modelRef(value) === ref) delete profiles[key];
  }
  const changedConfig = withOpencodeProfiles(raw, profiles);
  const checked = validateConfigObject(changedConfig);
  if (!checked.ok) throw new UsageError(`修改后配置不合法：${checked.issues.join("；")}`);
  const backups: string[] = [];
  // 先写供应商声明，再放入允许列表：中断时至多留下未启用的声明。
  if (providerChanged) {
    const value =
      providerRaw !== null && !Object.hasOwn(providerRaw, "providers") && Object.keys(providers).length === 1 && Object.hasOwn(providers, "minimax")
        ? providers["minimax"]
        : { providers };
    const b = saveFile(paths.provider, json(value));
    if (b !== null) backups.push(b);
  }
  const configChanged = JSON.stringify(opencodeEntry(config).modelProfiles) !== JSON.stringify(profiles);
  if (configChanged) {
    const b = saveFile(paths.config, json(changedConfig));
    if (b !== null) backups.push(b);
  }
  const changed = configChanged || providerChanged;
  const service = await serviceState(paths.data);
  return response(
    flags,
    {
      changed,
      model: ref,
      backendId: "opencode",
      default: buildModelGate(profiles).defaultRef,
      backups,
      restartRequired: changed ? service.state === "running" : false,
      appliesOnNextStart: changed && service.state === "stopped",
    },
    changed
      ? `${action === "remove" ? "已从允许列表移除" : action === "default" ? "已设为默认" : "已加入可用模型"} ${ref}\n${RESTART_NOTE}${backups.length > 0 ? `\n备份：${backups.join("、")}` : ""}`
      : "配置未变化",
  );
}

interface ModelsRestartState {
  readonly restartRequired: boolean | null;
  readonly appliesOnNextStart: boolean | null;
  readonly loaded: boolean | null;
}

function modelsRestartState(loaded: LoadedProduct, id: BackendId, service: ServiceState, configFile: string, dataDir: string): ModelsRestartState {
  const snapshot = buildSnapshot({ ok: true, error: null, ...loaded }, service, configFile, dataDir);
  const view = snapshot.backends.find((candidate) => candidate.id === id);
  return {
    restartRequired: view?.restartRequired ?? null,
    appliesOnNextStart: snapshot.appliesOnNextStart,
    loaded: view?.loaded ?? null,
  };
}

async function sdkModelsCommand(positional: readonly string[], flags: Flags, id: BackendId): Promise<CommandResult> {
  const action = positional[1] ?? "list";
  const allowed =
    action === "list"
      ? [...PATH_FLAGS, "backend", "available", "online", "from", "test-sdk-module"]
      : action === "add"
        ? [...PATH_FLAGS, "backend", "from", "default", "online", "test-sdk-module"]
        : action === "remove"
          ? [...PATH_FLAGS, "backend", "replacement", "online", "test-sdk-module"]
          : [...PATH_FLAGS, "backend", "online", "test-sdk-module"];
  assertKnownFlags(flags, allowed);
  if (!["list", "add", "remove", "default"].includes(action)) {
    throw new UsageError(`用法：ocbridge models <list|add|remove|default> [模型 ID] --backend ${id}`);
  }
  if (optionalString(flags, "test-sdk-module") !== undefined && flags["online"] !== true) {
    throw new UsageError("--test-sdk-module 只用于 --online 的离线测试");
  }
  if (optionalString(flags, "from") !== undefined) {
    throw new UsageError("CodeBuddy/Qoder 不接受 --from；模型 ID 直接声明，供应商 JSON 不能跨 CLI 复制");
  }
  if (optionalString(flags, "provider-config") !== undefined) {
    throw new UsageError("CodeBuddy/Qoder 不接受 --provider-config；避免把 OpenCode 供应商结构写入另一后端");
  }
  if (flags["online"] === true) {
    if (!(action === "list" && flags["available"] === true)) {
      throw new UsageError("--online 只允许与 models list --available 配合");
    }
    const paths = managementPaths(flags);
    const loaded = requireDiskConfig(paths.config);
    const entry = sdkEntry(loaded.config, id);
    if (entry.executable === null) {
      throw new ManagementError(EXIT.precondition, "EXECUTABLE_MISSING", `后端 ${id} 未记录可执行文件；先执行 backends configure`);
    }
    const checked = checkedExecutable(entry.executable, entry.pinnedVersion);
    assertAuthUsable(id, entry.auth);
    const catalog = await queryOnlineCatalog(flags, id, entry, checked.path);
    writeModelsCache(paths.data, id, catalog);
    const service = await serviceState(paths.data);
    const restart = modelsRestartState(loaded, id, service, paths.config, paths.data);
    const allowedSet = new Set(entry.models.allowed);
    const models = catalog.models.map((model) => ({
      model,
      allowed: allowedSet.has(model),
      default: model === entry.models.default,
      available: true,
      verified: false,
    }));
    return response(
      flags,
      {
        backendId: id,
        source: catalog.source,
        discoveredAt: catalog.discoveredAt,
        models,
        allowed: entry.models.allowed,
        default: entry.models.default,
        verified: [],
        cacheError: null,
        loaded: restart.loaded,
        restartRequired: restart.restartRequired,
        appliesOnNextStart: restart.appliesOnNextStart,
        note: "在线目录来自 SDK 目录接口；available 不等于已验收，allowlist 未被修改",
      },
      models.length === 0
        ? "在线目录查询成功，但账户没有返回任何模型；allowed 未被修改"
        : models.map((m) => `${m.model}${m.default ? "（默认）" : ""}${m.allowed ? "（已允许）" : "（未加入允许列表）"}`).join("\n"),
    );
  }
  const paths = managementPaths(flags);
  const loaded = requireDiskConfig(paths.config);
  const entry = sdkEntry(loaded.config, id);

  if (action === "list") {
    if (positional.length > 2) throw new UsageError("models list 不接受模型位置参数");
    const service = await serviceState(paths.data);
    const restart = modelsRestartState(loaded, id, service, paths.config, paths.data);
    if (flags["available"] === true) {
      const cache = readModelsCache(paths.data, id);
      const allowedSet = new Set(entry.models.allowed);
      const models = cache.models.map((model) => ({
        model,
        allowed: allowedSet.has(model),
        default: model === entry.models.default,
        available: true,
        verified: false,
      }));
      return response(
        flags,
        {
          backendId: id,
          source: cache.source,
          discoveredAt: cache.discoveredAt,
          models,
          allowed: entry.models.allowed,
          default: entry.models.default,
          verified: [],
          cacheError: cache.error,
          loaded: restart.loaded,
          restartRequired: restart.restartRequired,
          appliesOnNextStart: restart.appliesOnNextStart,
          note:
            cache.source === "unavailable"
              ? "尚无可用模型目录缓存；可执行 models list --available --online 查询（allowed 不会被当作 available）"
              : "available 来自最近一次明确发现的目录缓存，不等于本产品已验收",
        },
        models.length === 0
          ? "无可用模型目录缓存（source=unavailable）；可执行 models list --available --online 查询，本地允许列表不会被当成可用列表"
          : models.map((m) => `${m.model}${m.default ? "（默认）" : ""}${m.allowed ? "（已允许）" : "（未加入允许列表）"}`).join("\n"),
      );
    }
    const models = entry.models.allowed.map((model) => ({
      model,
      default: model === entry.models.default,
      allowed: true,
      available: false,
      verified: false,
    }));
    return response(
      flags,
      {
        backendId: id,
        source: "local_config",
        discoveredAt: null,
        default: entry.models.default,
        allowed: entry.models.allowed,
        models,
        verified: [],
        loaded: restart.loaded,
        restartRequired: restart.restartRequired,
        appliesOnNextStart: restart.appliesOnNextStart,
      },
      models.map((m) => `${m.default ? "*" : " "} ${m.model}（本地允许列表；未验证远端可用）`).join("\n") + "\n* 为新会话默认模型；此查询未启动 SDK、未联网",
    );
  }

  if (positional.length !== 3) throw new UsageError(`用法：ocbridge models ${action} <模型 ID> --backend ${id}`);
  const model = positional[2]!;
  const problem = checkNativeModelId(model);
  if (problem !== null) throw new UsageError(`模型 ID 不合法：${problem}`);
  const models = entry.models;
  let next: { default: string; allowed: readonly string[] };
  if (action === "add") {
    if (flags["default"] === true) throw new UsageError("新后端请用 models default 设置默认模型；add 不隐式改变默认");
    if (models.allowed.includes(model)) {
      return response(flags, { changed: false, backendId: id, model, default: models.default, allowedModels: models.allowed }, "该模型已在允许列表");
    }
    if (models.allowed.length >= 8) throw new UsageError("允许列表已达 8 项上限，请先移除不用的模型");
    next = { default: models.default, allowed: [...models.allowed, model] };
  } else if (action === "default") {
    if (!models.allowed.includes(model)) throw new UsageError("目标模型尚未加入允许列表；先执行 models add");
    if (models.default === model) {
      return response(flags, { changed: false, backendId: id, model, default: models.default, allowedModels: models.allowed }, "该模型已经是默认");
    }
    next = { default: model, allowed: models.allowed };
  } else {
    if (!models.allowed.includes(model)) {
      return response(flags, { changed: false, backendId: id, model, default: models.default, allowedModels: models.allowed }, "该模型已不在允许列表");
    }
    if (models.allowed.length <= 1) throw new UsageError("不能移除唯一的允许模型；先 add 一个替代模型");
    let defaultModel = models.default;
    if (models.default === model) {
      const replacement = optionalString(flags, "replacement");
      if (replacement === undefined || replacement === model) {
        throw new UsageError("移除默认模型时必须指定 --replacement <另一个已允许模型>");
      }
      if (!models.allowed.includes(replacement)) throw new UsageError("--replacement 必须是当前已允许的模型");
      defaultModel = replacement;
    } else if (optionalString(flags, "replacement") !== undefined) {
      throw new UsageError("--replacement 只在移除默认模型时使用");
    }
    next = { default: defaultModel, allowed: models.allowed.filter((candidate) => candidate !== model) };
  }
  const nextEntry = { ...entry, models: next } as BackendConfigEntry;
  const written = writeBackends(paths, loaded, id, nextEntry);
  const service = await serviceState(paths.data);
  const prior = modelsRestartState(loaded, id, service, paths.config, paths.data);
  return response(
    flags,
    {
      changed: written.changed,
      backendId: id,
      model,
      default: next.default,
      allowedModels: next.allowed,
      backups: written.backup === null ? [] : [written.backup],
      loaded: prior.loaded,
      restartRequired: written.changed ? service.state === "running" : prior.restartRequired,
      appliesOnNextStart: written.changed ? service.state === "stopped" : prior.appliesOnNextStart,
    },
    written.changed
      ? `${action === "remove" ? "已移除" : action === "default" ? "已设为默认" : "已加入允许列表"} ${model}\n${RESTART_NOTE}${written.backup === null ? "" : `\n备份：${written.backup}`}`
      : "配置未变化",
  );
}

async function modelsCommand(positional: readonly string[], flags: Flags): Promise<CommandResult> {
  const backend = optionalString(flags, "backend") ?? "opencode";
  const id = parseBackendId(backend);
  if (id === "opencode") return opencodeModelsCommand(positional, flags);
  return sdkModelsCommand(positional, flags, id);
}

// ---------------------------------------------------------------- config

function sdkConfigTemplate(id: BackendId, executable: string, model: string, auth: AuthConfig): ProductConfig {
  const entry = {
    adapter: id === "codebuddy" ? CODEBUDDY_ADAPTER_ID : QODER_ADAPTER_ID,
    enabled: true,
    pinnedVersion: PINNED_VERSION[id],
    executable,
    auth,
    models: { default: model, allowed: [model] },
  };
  const checked = validateConfigObject({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: "personal",
    defaultBackend: id,
    backends: { [id]: entry },
    workspaces: [],
    limits: {},
    transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
  });
  if (!checked.ok) throw new ManagementError(EXIT.usage, "CONFIG_INVALID", checked.issues.join("；"));
  return checked.config;
}

function configInitCommand(flags: Flags): CommandResult {
  assertKnownFlags(flags, ["out", "force", "backend", "executable", "model", "auth", "auth-file"]);
  const outFlag = optionalString(flags, "out");
  if (outFlag === undefined) throw new UsageError("缺少必填参数 --out");
  if (!isAbsolute(outFlag)) throw new UsageError("--out 必须是绝对路径");
  const out = resolve(outFlag);
  if (existsSync(out) && flags["force"] !== true) {
    return response(flags, { created: null, schemaVersion: CONFIG_SCHEMA_VERSION }, `拒绝覆盖已存在的文件: ${out}（如确需覆盖请加 --force）`, EXIT.precondition);
  }
  const id = parseBackendId(optionalString(flags, "backend") ?? "opencode");
  let config: ProductConfig;
  if (id === "opencode") {
    if (optionalString(flags, "executable") !== undefined || optionalString(flags, "model") !== undefined || optionalString(flags, "auth") !== undefined || optionalString(flags, "auth-file") !== undefined) {
      throw new UsageError("OpenCode 模板不接受 --executable/--model/--auth；使用 backends configure opencode 补充");
    }
    config = configTemplate();
  } else {
    const executableRaw = optionalString(flags, "executable");
    const model = optionalString(flags, "model");
    const authMode = optionalString(flags, "auth");
    if (executableRaw === undefined) throw new UsageError("创建 CodeBuddy/Qoder 配置必须提供 --executable <绝对路径>");
    if (model === undefined) throw new UsageError("创建 CodeBuddy/Qoder 配置必须提供 --model <原生模型 ID>");
    if (authMode === undefined) throw new UsageError("创建 CodeBuddy/Qoder 配置必须提供 --auth cli-login|credential-file");
    const problem = checkNativeModelId(model);
    if (problem !== null) throw new UsageError(`--model 不合法：${problem}`);
    const executable = requireAbsoluteExecutable(executableRaw, "CLI 可执行文件");
    const auth = policyAuth(id, authMode, optionalString(flags, "auth-file"));
    config = sdkConfigTemplate(id, executable, model, auth);
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, json(config), { mode: 0o600 });
  return response(
    flags,
    { created: out, schemaVersion: CONFIG_SCHEMA_VERSION, defaultBackend: config.defaultBackend },
    `已写入 v${CONFIG_SCHEMA_VERSION} 配置: ${out}（默认后端 ${config.defaultBackend}）`,
  );
}

function configValidateCommand(flags: Flags): CommandResult {
  assertKnownFlags(flags, ["file", "config"]);
  const fileFlag = optionalString(flags, "file");
  const configFlag = optionalString(flags, "config");
  if (fileFlag !== undefined && configFlag !== undefined) throw new UsageError("--file 与 --config 只能提供一个");
  const supplied = fileFlag ?? configFlag;
  if (supplied === undefined) throw new UsageError("缺少 --config <path>（--file 为兼容别名）");
  const file = resolve(supplied);
  if (!existsSync(file)) {
    return response(flags, { ok: false, issues: [`配置文件不存在: ${file}`] }, `配置文件不存在: ${file}`, EXIT.precondition);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return response(flags, { ok: false, issues: [`JSON 解析失败: ${(error as Error).message}`] }, `JSON 解析失败: ${(error as Error).message}`, EXIT.precondition);
  }
  const result = validateConfigObject(parsed);
  if (!result.ok) {
    const text = result.issues.map((issue) => `- ${issue}`).join("\n");
    return response(flags, { ok: false, issues: result.issues }, `配置不合法:\n${text}`, EXIT.precondition);
  }
  const warnings = result.config.workspaces
    .map((workspace) => {
      if (!existsSync(workspace.root)) return `- 工作区 ${workspace.id} 的 root 尚不存在（创建后才能登记）: ${workspace.root}`;
      return null;
    })
    .filter((line): line is string => line !== null);
  const note =
    result.sourceSchemaVersion === 2
      ? "v2 只读兼容：start 在内存中规范化；需要写回 v3 时执行 config migrate"
      : null;
  return response(
    flags,
    {
      ok: true,
      schemaVersion: result.config.schemaVersion,
      sourceSchemaVersion: result.sourceSchemaVersion,
      defaultBackend: result.config.defaultBackend,
      backends: Object.keys(result.config.backends),
      workspaces: result.config.workspaces.length,
      warnings,
      note,
      readOnly: true,
    },
    `配置合法（schemaVersion=${result.config.schemaVersion}，来源 v${result.sourceSchemaVersion}，${result.config.workspaces.length} 个工作区）${warnings.length ? `\n${warnings.join("\n")}` : ""}${note === null ? "" : `\n${note}`}`,
  );
}

async function configMigrateCommand(flags: Flags): Promise<CommandResult> {
  assertKnownFlags(flags, ["config", "data-dir", "opencode", "provider-config"]);
  const paths = managementPaths(flags);
  if (!existsSync(paths.config)) {
    throw new ManagementError(EXIT.precondition, "CONFIG_UNREADABLE", `配置文件不存在: ${paths.config}`);
  }
  const raw = (() => {
    try {
      return readObject(paths.config);
    } catch (error) {
      throw new ManagementError(EXIT.precondition, "CONFIG_UNREADABLE", error instanceof Error ? error.message : String(error));
    }
  })();
  const sourceVersion = raw["schemaVersion"];
  if (sourceVersion === CONFIG_SCHEMA_VERSION) {
    const checked = validateConfigObject(raw);
    if (!checked.ok) throw new ManagementError(EXIT.usage, "CONFIG_INVALID", `配置不合法：${checked.issues.join("；")}`);
    const service = await serviceState(paths.data);
    return response(
      flags,
      {
        fromVersion: CONFIG_SCHEMA_VERSION,
        toVersion: CONFIG_SCHEMA_VERSION,
        changed: false,
        backup: null,
        restartRequired: service.state === "running" ? false : null,
        appliesOnNextStart: service.state === "stopped",
      },
      `配置已是 v${CONFIG_SCHEMA_VERSION}；未修改文件`,
    );
  }
  if (sourceVersion !== 2) {
    throw new ManagementError(
      EXIT.usage,
      "CONFIG_VERSION_UNSUPPORTED",
      `只支持 v2 → v3 显式迁移；收到 schemaVersion=${String(sourceVersion)}。v1／未知未来版本不做推断兼容`,
    );
  }
  const checked = validateConfigObject(raw);
  if (!checked.ok) throw new ManagementError(EXIT.usage, "CONFIG_INVALID", `配置不合法：${checked.issues.join("；")}`);
  const executableFlag = optionalString(flags, "opencode");
  const providerFlag = optionalString(flags, "provider-config");
  const opencode = checked.config.backends["opencode"];
  if (opencode === undefined || opencode.adapter !== OPENCODE_ADAPTER_ID) {
    throw new ManagementError(EXIT.usage, "CONFIG_INVALID", "v2 配置缺少 OpenCode 后端，无法迁移");
  }
  const executable = executableFlag === undefined ? opencode.executable : requireAbsoluteExecutable(executableFlag, "OpenCode 可执行文件");
  const providerConfigFile = providerFlag === undefined ? opencode.providerConfigFile : requireAbsoluteFile(providerFlag, "供应商配置文件");
  if (providerConfigFile !== null) readProviderFile(providerConfigFile);
  const migrated = {
    ...opencode,
    executable,
    providerConfigFile,
  };
  const text = v3ConfigText(raw, { raw, config: checked.config, sourceSchemaVersion: 2 }, { ...checked.config.backends, opencode: migrated }, checked.config.defaultBackend);
  const backup = saveFile(paths.config, text);
  const service = await serviceState(paths.data);
  return response(
    flags,
    {
      fromVersion: 2,
      toVersion: CONFIG_SCHEMA_VERSION,
      changed: true,
      backup,
      defaultBackend: checked.config.defaultBackend,
      backends: Object.keys(checked.config.backends),
      restartRequired: service.state === "running" ? true : false,
      appliesOnNextStart: service.state === "stopped",
      note: "只迁移配置文件；未停止服务、未调用模型、未升级 SQLite",
    },
    `已迁移配置 v2 → v${CONFIG_SCHEMA_VERSION}${backup === null ? "" : `\n原文备份：${backup}`}\n只迁移配置文件；未停止服务、未调用模型、未升级 SQLite`,
  );
}

export async function runConfigCommand(positional: readonly string[], flags: Flags): Promise<CommandResult> {
  return guarded(flags, async () => {
    const sub = positional[1];
    if (sub === "init") {
      if (positional.length !== 2) throw new UsageError("config init 不接受额外位置参数");
      return configInitCommand(flags);
    }
    if (sub === "validate") {
      if (positional.length !== 2) throw new UsageError("config validate 不接受额外位置参数");
      return configValidateCommand(flags);
    }
    if (sub === "migrate") {
      if (positional.length !== 2) throw new UsageError("config migrate 不接受额外位置参数");
      return configMigrateCommand(flags);
    }
    throw new UsageError("用法: ocbridge config <init|validate|migrate> …");
  });
}

// ---------------------------------------------------------------- entry

export async function runManagementCommand(positional: readonly string[], flags: Flags, delegate: Delegate): Promise<CommandResult> {
  return guarded(flags, async () => {
    if (positional[0] === "models") return modelsCommand(positional, flags);
    if (positional[0] === "backends") return backendsCommand(positional, flags);
    if (positional.length !== 1) throw new UsageError("服务管理命令不接受额外位置参数");
    return serviceCommand(positional[0]!, flags, delegate);
  });
}
