/**
 * 受控模型 profile（OC-08：通过 MCP 选择模型）。
 *
 * 规则：
 * 1. 允许列表来自产品配置 `backend.modelProfiles`（`providerID/modelID` 集合），
 *    供应商配置对象由调用方（daemon 启动入口）从私有文件准备；本模块只校验形状
 *    并原样放进受控运行目录；不读取、不打印、不落库任何密钥；
 * 2. 请求一律显式带 `{providerID, modelID}`，不依赖 OpenCode 的默认模型；
 * 3. 迁移前的历史实现固定 `minimax/MiniMax-M3.1-Flash`：旧 run 的
 *    selected_model 为 NULL，读取侧按 LEGACY_MODEL_REF 解释，不回填为当前 default。
 */
import type { BackendPolicyProfile, ModelSelection } from "../../contracts/backend.ts";
import { ZBridgeError } from "../../contracts/errors.ts";
import { OPENCODE_PINNED_VERSION } from "../../contracts/version.ts";
import { LEGACY_MODEL_ID, LEGACY_MODEL_REF, LEGACY_PROVIDER_ID } from "../../contracts/run.ts";

/** 迁移前固定实现的模型标识（定义在 contracts/run.ts，存储层解释历史行时共用）；只用于解释历史，不是当前产品限制。 */
export { LEGACY_MODEL_ID, LEGACY_MODEL_REF, LEGACY_PROVIDER_ID };

/** 与配置 schema 的 modelIdSchema 一致的标识符字符集。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 完整模型引用：`providerID/modelID`，两段各 1–128 字符（捕获组供 parseModelRef 使用）。 */
export const MODEL_REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export type ControlledModel = ModelSelection;

export function modelRef(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}`;
}

/**
 * 解析完整模型引用。格式错误是 INVALID_ARGUMENT；
 * 是否在允许列表内由调用方另行判断（PROFILE_NOT_ALLOWED）。
 */
export function parseModelRef(ref: string): ModelSelection {
  const match = MODEL_REF_RE.exec(ref);
  if (match === null) {
    throw new ZBridgeError("INVALID_ARGUMENT", "model 必须是 providerID/modelID（只允许字母数字、点、下划线、连字符）", {
      details: { field: "model" },
    });
  }
  return { providerID: match[1] as string, modelID: match[2] as string };
}

export interface ModelGate {
  /** default profile 的完整引用（写入 worker config 的 model/small_model）。 */
  readonly defaultRef: string;
  readonly defaultModel: ModelSelection;
  /** 去重并稳定排序的完整引用列表；capabilities 直接返回它。 */
  readonly allowed: readonly string[];
  /** 允许列表覆盖的供应商 ID（去重排序）。 */
  readonly providerIDs: readonly string[];
  allows(ref: string): boolean;
}

/** 从 `backend.modelProfiles` 构造允许列表；配置 schema 已保证有 default。 */
export function buildModelGate(profiles: Readonly<Record<string, ModelSelection>>): ModelGate {
  const entries = Object.entries(profiles);
  if (entries.length === 0) {
    throw new ZBridgeError("INVALID_ARGUMENT", "modelProfiles 不能为空");
  }
  const defaultModel = profiles["default"];
  if (defaultModel === undefined) {
    throw new ZBridgeError("INVALID_ARGUMENT", "modelProfiles 必须包含 default");
  }
  const allowed = [...new Set(entries.map(([, model]) => modelRef(model)))].sort();
  const providerIDs = [...new Set(entries.map(([, model]) => model.providerID))].sort();
  const allowedSet = new Set(allowed);
  return {
    defaultRef: modelRef(defaultModel),
    defaultModel: { providerID: defaultModel.providerID, modelID: defaultModel.modelID },
    allowed,
    providerIDs,
    allows: (ref) => allowedSet.has(ref),
  };
}

export interface PermissionRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "allow" | "ask" | "deny";
}

/**
 * 受控策略：review 只读；edit 只用于一次性测试副本，且仍走本地审批。
 *
 * 返回的是 **`POST /session` 的 PermissionRuleset**（数组，元素为
 * `{permission, pattern, action}`）。配置文件的 `permission` 是另一种形状，
 * 见 `permissionConfig()`；两者不能混用（安装版本 OpenAPI：PermissionRuleset vs PermissionConfig）。
 */
export function permissionRules(profile: BackendPolicyProfile): readonly PermissionRule[] {
  const write = profile === "edit" ? "ask" : "deny";
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: write },
    { permission: "bash", pattern: "*", action: write },
    { permission: "shell", pattern: "*", action: write },
  ];
}

/**
 * 配置文件里的 `permission`：OpenAPI 的 `Config.permission` 是 PermissionConfig，
 * 即「动作字符串」或「按工具名映射到动作/对象」的对象，**不是**规则数组。
 * 写入数组会被安装版本拒绝，不能用「模拟服务也接受」来糊过去。
 */
export function permissionConfig(profile: BackendPolicyProfile): Readonly<Record<string, "allow" | "ask" | "deny">> {
  const write = profile === "edit" ? "ask" : "deny";
  return {
    "*": "deny",
    read: "allow",
    edit: write,
    bash: write,
    shell: write,
  };
}

/** 版本必须与兼容性基线完全一致，范围或更新版本都不放行。 */
export function assertPinnedVersion(version: string | null): string {
  if (version !== OPENCODE_PINNED_VERSION) {
    throw new ZBridgeError(
      "BACKEND_PROTOCOL_MISMATCH",
      `OpenCode 版本必须是 ${OPENCODE_PINNED_VERSION}；收到 ${version ?? "未知"}`,
      { details: { expected: OPENCODE_PINNED_VERSION, actual: version } },
    );
  }
  return version;
}

/**
 * 后端响应里的 provider/model 必须与**本次 run 选定**的模型一致，否则立即中止后续调用。
 * 期望值由调用方传入（每轮 prompt 的选择），不是模块常量。
 */
export function assertResponseIdentity(
  providerID: string | null,
  modelID: string | null,
  where: string,
  expected: ModelSelection,
): void {
  if (providerID === expected.providerID && modelID === expected.modelID) return;
  throw new ZBridgeError(
    "BACKEND_PROTOCOL_MISMATCH",
    `${where}: 后端响应的供应商/模型与本次 run 选定的不一致`,
    { details: { providerID, modelID, expectedProvider: expected.providerID, expectedModel: expected.modelID } },
  );
}

/** 配置里允许出现的键；出现结构性键说明调用方塞进了别的供应商或插件。 */
const FORBIDDEN_PROVIDER_KEYS = ["id", "provider", "providers", "enabled_providers", "mcp", "plugin", "model", "small_model"] as const;

function assertProviderConfig(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ZBridgeError("INVALID_ARGUMENT", "供应商配置必须是普通对象");
  }
  const record = value as Record<string, unknown>;
  for (const key of FORBIDDEN_PROVIDER_KEYS) {
    if (Object.hasOwn(record, key)) {
      throw new ZBridgeError("INVALID_ARGUMENT", `供应商配置不能包含结构性字段 ${key}`, {
        details: { field: key },
      });
    }
  }
  return record;
}

/** 多供应商文件格式的顶层键。 */
export const MULTI_PROVIDER_KEY = "providers";

/**
 * 解析 `--provider-config` 文件内容，返回 providerID → OpenCode 配置对象。
 *
 * 两种明确区分的格式，禁止混合：
 * - 旧格式：整个对象就是单个 MiniMax 供应商的配置（等价于 `{ providers: { minimax: <对象> } }`）；
 * - 新格式：顶层只有 `providers` 键，值为 providerID → 该供应商的配置对象。
 */
export function parseProviderConfigFile(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ZBridgeError("INVALID_ARGUMENT", "providerConfig 必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  const hasProviders = Object.hasOwn(record, MULTI_PROVIDER_KEY);
  const otherKeys = Object.keys(record).filter((key) => key !== MULTI_PROVIDER_KEY);
  if (hasProviders && otherKeys.length > 0) {
    throw new ZBridgeError("INVALID_ARGUMENT", `providerConfig 不能混合两种格式：${MULTI_PROVIDER_KEY} 与单供应商字段同时出现`, {
      details: { extraKeys: otherKeys.slice(0, 4) },
    });
  }
  if (!hasProviders) {
    // 旧格式：整个对象是 MiniMax 的 OpenCode 配置；旧启动命令无需修改。
    return { [LEGACY_PROVIDER_ID]: assertProviderConfig(record) };
  }
  const inner = record[MULTI_PROVIDER_KEY];
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    throw new ZBridgeError("INVALID_ARGUMENT", `providerConfig.${MULTI_PROVIDER_KEY} 必须是对象`);
  }
  const entries = Object.entries(inner as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ZBridgeError("INVALID_ARGUMENT", `providerConfig.${MULTI_PROVIDER_KEY} 不能为空`);
  }
  const out: Record<string, unknown> = {};
  for (const [id, config] of entries) {
    if (!ID_RE.test(id) || id.length > 64) {
      throw new ZBridgeError("INVALID_ARGUMENT", `providerConfig.${MULTI_PROVIDER_KEY} 的键必须是合法供应商 ID: ${JSON.stringify(id.slice(0, 32))}`);
    }
    out[id] = assertProviderConfig(config);
  }
  return out;
}

export interface ControlledConfigInput {
  /** 已过滤到登记供应商的配置（providerID → OpenCode 配置对象）。 */
  readonly providers: Readonly<Record<string, unknown>>;
  /** default profile 的完整引用；写入 config.model／small_model。 */
  readonly defaultModelRef: string;
  readonly policyProfile: BackendPolicyProfile;
}

/**
 * 生成独占运行目录里的 OpenCode 配置。
 *
 * 刻意不合并用户全局配置：`plugin`/`mcp` 为空，`autoupdate`/`snapshot` 关闭；
 * 供应商只包含登记集合。返回值里不含任何凭据以外的推断，因此可以安全记录键名。
 */
export function buildControlledConfig(input: ControlledConfigInput): Record<string, unknown> {
  const ids = Object.keys(input.providers).sort();
  if (ids.length === 0) {
    throw new ZBridgeError("INVALID_ARGUMENT", "受控配置至少需要一个供应商");
  }
  const defaultModel = parseModelRef(input.defaultModelRef);
  if (!ids.includes(defaultModel.providerID)) {
    throw new ZBridgeError("INVALID_ARGUMENT", "default 模型的供应商不在受控供应商集合内", {
      details: { providerID: defaultModel.providerID, providers: ids },
    });
  }
  const provider: Record<string, unknown> = {};
  for (const id of ids) provider[id] = input.providers[id];
  return {
    provider,
    enabled_providers: ids,
    model: input.defaultModelRef,
    small_model: input.defaultModelRef,
    plugin: [],
    mcp: {},
    autoupdate: false,
    snapshot: false,
    permission: permissionConfig(input.policyProfile),
  };
}

/** 日志脱敏：先按已知密钥值替换，再按常见键名兜底。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(
    /("(?:apiKey|accessToken|refreshToken|authorization|password|secret|token)"\s*:\s*")[^"]*/gi,
    "$1[REDACTED]",
  );
}

/**
 * 从供应商配置里找出「值看起来像密钥」的字符串，仅用于日志脱敏。
 * 返回值只在本进程内存里用，不写日志、不落库。
 */
export function collectSecretValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  const found: string[] = [];
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      if (/(api[-_]?key|token|secret|passw|authorization|credential)/i.test(key) && child.length >= 8) found.push(child);
    } else if (typeof child === "object" && child !== null) {
      found.push(...collectSecretValues(child, depth + 1));
    }
  }
  return found;
}
