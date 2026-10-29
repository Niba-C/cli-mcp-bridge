/**
 * 产品配置 schema（技术规格 §10；OC-09 起为 v3 三后端结构）。
 *
 * 原则：
 * - strict：配置里不允许出现未知字段，尤其不许出现 apiKey / token 这类凭证
 *   （供应商凭证只由可信配置流程放进受控运行目录，不复制进产品配置）；
 * - 路径必须显式、绝对、不过宽：拒绝 `/`、`$HOME`、`$HOME` 的祖先、以及 $TMPDIR 下
 *   （$TMPDIR 拒绝来自旧的沙箱假设，暂保留，未按 OpenCode 路线重新验证）；
 * - 每个后端项按 adapter 区分 strict schema：OpenCode 保留 provider/model 的
 *   modelProfiles；CodeBuddy/Qoder 只接受原生模型 ID 允许列表，不接受 URL、
 *   绝对路径或供应商字段；
 * - v2（单个 `backend` 项）只做**内存**规范化为仅含 opencode 的 v3 表达，
 *   start/status/list 不改写用户文件；写入 v3 必须走显式迁移命令。
 *   v1／zcode-acp 和未知未来版本仍拒绝；
 * - 同时出现新旧 backend 字段（`backend` 与 `backends`/`defaultBackend`）必须拒绝；
 * - 这里的校验不碰网络、不启动后端，`config validate` 可以直接跑。
 */
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import {
  CONFIG_SCHEMA_VERSION,
  OPENCODE_ADAPTER_ID,
  OPENCODE_PINNED_VERSION,
  CODEBUDDY_ADAPTER_ID,
  QODER_ADAPTER_ID,
  CODEBUDDY_PINNED_CLI_VERSION,
  QODER_PINNED_CLI_VERSION,
} from "./version.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const slugSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "工作区 id 只允许小写字母、数字和连字符");

/** 配置里的 workspace id 是人类可读 slug；运行期 WorkspaceId（ws_*）由登记时分配。 */
const workspaceConfigSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1).max(64).optional(),
  root: z.string().min(1).max(1024),
  profiles: z.array(z.enum(["review", "edit"])).min(1).max(2),
});

const limitsSchema = z
  .strictObject({
    activeRuns: z.number().int().min(1).max(2).default(1),
    queuedRuns: z.number().int().min(1).max(20).default(20),
    queueTtlMs: z.number().int().min(10_000).max(600_000).default(300_000),
    runTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(900_000),
    approvalTimeoutMs: z.number().int().min(10_000).max(300_000).default(300_000),
    waitTimeoutMs: z.number().int().min(1_000).max(25_000).default(20_000),
    promptMaxBytes: z.number().int().min(1024).max(64 * 1024).default(64 * 1024),
    eventsPerRun: z.number().int().min(100).max(10_000).default(10_000),
    eventBytesPerRun: z.number().int().min(MB).max(10 * MB).default(10 * MB),
    artifactMaxBytes: z.number().int().min(MB).max(10 * MB).default(10 * MB),
    artifactBytesPerRun: z.number().int().min(MB).max(50 * MB).default(50 * MB),
    artifactBytesGlobal: z.number().int().min(MB).max(GB).default(GB),
    textResultMaxChars: z.number().int().min(1000).max(16_000).default(16_000),
    idleWorkerMs: z.number().int().min(60_000).default(600_000),
    retentionDays: z.number().int().min(1).max(90).default(7),
  })
  .prefault({});

const transportSchema = z
  .strictObject({
    stdio: z.boolean().default(true),
    http: z
      .strictObject({
        enabled: z.boolean().default(false),
        bind: z.string().default("127.0.0.1"),
      })
      .prefault({}),
  })
  .prefault({});

/** 受控模型映射：只允许标识符，不接受 URL、环境变量或额外供应商参数。 */
const modelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "只允许字母、数字、点、下划线和连字符");

const modelProfileSchema = z.strictObject({
  providerID: modelIdSchema,
  modelID: modelIdSchema,
});

const modelProfilesSchema = z
  .record(z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9-]*$/), modelProfileSchema)
  .refine((profiles) => Object.keys(profiles).length >= 1 && Object.keys(profiles).length <= 8, {
    message: "modelProfiles 需要 1–8 个受控 profile",
  })
  .refine((profiles) => Object.hasOwn(profiles, "default"), {
    message: "modelProfiles 必须包含 default",
  });

/** 绝对路径字段：必须是显式绝对路径，且不落在 $HOME／$TMPDIR 或其祖先上。 */
const absolutePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value), { message: "必须是绝对路径" })
  .refine((value) => !value.split(sep).includes(".."), { message: "不能包含 .. 段" });

/**
 * CodeBuddy／Qoder 的原生模型 ID：有界字符串。拒绝控制字符、空白、
 * URL 形态、绝对路径与 OpenCode 的 provider/model 双段格式——那些不是
 * 原生 ID 的合法形态，出现即按配置错误处理，不做「看起来像就接受」。
 */
const nativeModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => ![...value].some((c) => { const code = c.charCodeAt(0); return code <= 0x1f || code === 0x7f; }), {
    message: "模型 ID 不能包含控制字符",
  })
  .refine((value) => value === value.trim() && !/\s/.test(value), { message: "模型 ID 不能包含空白" })
  .refine((value) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value), { message: "模型 ID 不能是 URL" })
  .refine((value) => !value.startsWith("/"), { message: "模型 ID 不能是绝对路径" })
  .refine((value) => !value.includes("/"), { message: "原生模型 ID 是单段字符串；provider/model 双段是 OpenCode 专属格式" });

/** 管理命令校验原生模型 ID；返回问题文本，null 表示合法。 */
export function checkNativeModelId(value: string): string | null {
  const parsed = nativeModelIdSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "原生模型 ID 不合法");
}

/** 新后端模型允许列表：1–8 项、去重、default 必须在 allowed 内。 */
const nativeModelsSchema = z
  .strictObject({
    default: nativeModelIdSchema,
    allowed: z.array(nativeModelIdSchema).min(1).max(8),
  })
  .refine((models) => new Set(models.allowed).size === models.allowed.length, {
    message: "allowed 模型列表存在重复项",
  })
  .refine((models) => models.allowed.includes(models.default), {
    message: "default 模型必须在 allowed 列表内",
  });

/** 认证模式：每项只选一种；产品配置只保存模式与私有文件引用，不保存 token/key。 */
const authConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("cli-login") }),
  z.strictObject({
    mode: z.literal("credential-file"),
    file: absolutePathSchema,
  }),
]);

/** OpenCode 项：保留 provider/model 与既有导入语义；executable/providerConfigFile 可空（由 CLI 参数或默认路径补齐）。 */
const opencodeBackendSchema = z.strictObject({
  adapter: z.literal(OPENCODE_ADAPTER_ID),
  enabled: z.boolean(),
  pinnedVersion: z.literal(OPENCODE_PINNED_VERSION),
  executable: absolutePathSchema.nullable().default(null),
  providerConfigFile: absolutePathSchema.nullable().default(null),
  modelProfiles: modelProfilesSchema,
});

/** CodeBuddy／Qoder 项：官方 SDK adapter + 受控 CLI 可执行文件 + 原生模型允许列表。 */
const codebuddyBackendSchema = z.strictObject({
  adapter: z.literal(CODEBUDDY_ADAPTER_ID),
  enabled: z.boolean(),
  pinnedVersion: z.literal(CODEBUDDY_PINNED_CLI_VERSION),
  executable: absolutePathSchema,
  auth: authConfigSchema,
  models: nativeModelsSchema,
});

const qoderBackendSchema = z.strictObject({
  adapter: z.literal(QODER_ADAPTER_ID),
  enabled: z.boolean(),
  pinnedVersion: z.literal(QODER_PINNED_CLI_VERSION),
  executable: absolutePathSchema,
  auth: authConfigSchema,
  models: nativeModelsSchema,
});

const backendEntrySchema = z.discriminatedUnion("adapter", [
  opencodeBackendSchema,
  codebuddyBackendSchema,
  qoderBackendSchema,
]);

/**
 * v3 后端表是**部分表**：只包含已配置的后端项。defaultBackend 必须在表内。
 * 键只允许三个固定后端 ID，不允许别名或任意键。
 */
const backendsRecordSchema = z
  .record(z.string(), backendEntrySchema)
  .refine(
    (backends) => {
      const allowed = new Set(["opencode", "codebuddy", "qoder"]);
      return Object.keys(backends).every((key) => allowed.has(key)) && Object.keys(backends).length >= 1;
    },
    { message: "backends 键只允许 opencode/codebuddy/qoder，且至少配置一项" },
  );

export const productConfigSchema = z.strictObject({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  mode: z.literal("personal"),
  defaultBackend: z.enum(["opencode", "codebuddy", "qoder"]),
  backends: backendsRecordSchema,
  workspaces: z.array(workspaceConfigSchema).max(32).default([]),
  limits: limitsSchema,
  transport: transportSchema,
});

export type ProductConfig = z.infer<typeof productConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type ProductLimits = ProductConfig["limits"];
/** v3 配置里单个后端项（按 adapter 判别后的联合）。 */
export type BackendConfigEntry = z.infer<typeof backendEntrySchema>;

/**
 * v2 配置（OC-09 之前）：单个 `backend` 项。只用于读取兼容与内存规范化，
 * 新代码写配置一律产出 v3；v2 结构在这里保持原样解析，不与新 schema 混用。
 */
const legacyV2BackendSchema = z.strictObject({
  adapter: z.literal(OPENCODE_ADAPTER_ID),
  pinnedVersion: z.literal(OPENCODE_PINNED_VERSION),
  modelProfiles: modelProfilesSchema,
});

const legacyV2ConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  mode: z.literal("personal"),
  backend: legacyV2BackendSchema,
  workspaces: z.array(workspaceConfigSchema).max(32).default([]),
  limits: limitsSchema,
  transport: transportSchema,
});

export type LegacyV2Config = z.infer<typeof legacyV2ConfigSchema>;

function isAncestorOf(candidate: string, target: string): boolean {
  if (candidate === sep) return true;
  return target === candidate || target.startsWith(`${candidate}${sep}`);
}

export interface PathProblem {
  readonly workspaceId: string;
  readonly field: "root";
  readonly message: string;
}

/**
 * 路径面的最小拒绝规则。纯字符串判断，不做 realpath（那一步在 fs 校验里做，
 * 因为 realpath 需要磁盘状态、且会引入 TOCTOU，不能拿它当安全边界）。
 */
export function checkWorkspaceRoot(root: string, home: string = homedir(), tmp: string = tmpdir()): string | null {
  if (!isAbsolute(root)) return "root 必须是绝对路径";
  if (root.split(sep).includes("..")) return "root 不能包含 .. 段，请写规范化后的绝对路径";
  if (/[*?[\]{}]/.test(root)) return "root 不能包含通配符或 shell 展开字符";
  const withoutTrailing = root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root;
  if (withoutTrailing === sep) return "root 不能是文件系统根目录";

  const homeResolved = resolvePath(home);
  if (withoutTrailing === homeResolved) return "root 不能是用户主目录";
  if (isAncestorOf(withoutTrailing, homeResolved) && withoutTrailing !== homeResolved) {
    return "root 不能是用户主目录的祖先（范围过宽）";
  }

  const tmpResolved = resolvePath(tmp);
  if (isAncestorOf(tmpResolved, withoutTrailing)) {
    return "root 不能位于 $TMPDIR 下：该限制来自旧的沙箱假设，OpenCode 路线尚未重新验证，暂保留";
  }
  return null;
}

/** 去重校验 v3 后端表：键与 adapter 一一对应、defaultBackend 存在且启用。 */
function backendTableIssues(config: ProductConfig): string[] {
  const issues: string[] = [];
  const expectedAdapter: Record<string, string> = {
    opencode: OPENCODE_ADAPTER_ID,
    codebuddy: CODEBUDDY_ADAPTER_ID,
    qoder: QODER_ADAPTER_ID,
  };
  for (const [id, entry] of Object.entries(config.backends)) {
    if (entry.adapter !== expectedAdapter[id]) {
      issues.push(`backends.${id}.adapter: 后端 ${id} 只接受 ${expectedAdapter[id]}，收到 ${entry.adapter}`);
    }
  }
  const defaultEntry = config.backends[config.defaultBackend];
  if (defaultEntry === undefined) {
    issues.push(`defaultBackend: ${config.defaultBackend} 未在 backends 中配置`);
  } else if (!defaultEntry.enabled) {
    issues.push(`defaultBackend: ${config.defaultBackend} 已配置但处于禁用状态`);
  }
  return issues;
}

/**
 * 把 v2 配置规范化为**仅内存使用**的 v3 表达：defaultBackend=opencode、
  enabled=true；executable/providerConfigFile 保持 null（由启动参数或既有
  默认路径解析填充，不在读取时猜测）。调用方不得把该结果写回用户文件。
 */
export function normalizeLegacyV2Config(input: LegacyV2Config): ProductConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: "personal",
    defaultBackend: "opencode",
    backends: {
      opencode: {
        adapter: OPENCODE_ADAPTER_ID,
        enabled: true,
        pinnedVersion: input.backend.pinnedVersion,
        executable: null,
        providerConfigFile: null,
        modelProfiles: input.backend.modelProfiles,
      },
    },
    workspaces: input.workspaces,
    limits: input.limits,
    transport: input.transport,
  };
}

/**
 * 旧配置与未来版本的统一拒绝口径。
 *
 * v1／zcode-acp 不做映射：字段含义已经变化（后端、模型、运行目录都不同），
 * 静默升级会把旧的后端假设带进新结构。v2 在 `validateConfigObject` 里走
 * 内存规范化，不在这里拒绝。混用新旧 backend 字段（`backend` 与
 * `backends`/`defaultBackend` 并存）明确拒绝，避免歧义解析。
 */
function compatibilityIssues(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const issues: string[] = [];

  if (record["schemaVersion"] !== undefined && record["schemaVersion"] !== CONFIG_SCHEMA_VERSION && record["schemaVersion"] !== 2) {
    issues.push(
      `schemaVersion: 只接受 ${CONFIG_SCHEMA_VERSION}（v2 只读兼容）；收到 ${String(record["schemaVersion"])}。` +
        "旧 ZCode 配置和未验证的未来版本都不做推断兼容，请按 config/example.config.json 重建",
    );
  }

  const hasOldBackend = record["backend"] !== undefined;
  const hasNewBackend = record["backends"] !== undefined || record["defaultBackend"] !== undefined;
  if (hasOldBackend && hasNewBackend) {
    issues.push("backend: v2 的 `backend` 与 v3 的 `backends`/`defaultBackend` 不能同时出现；请完成显式迁移");
  }

  if (!hasNewBackend) {
    const backend = record["backend"];
    if (backend !== null && typeof backend === "object" && !Array.isArray(backend)) {
      const adapter = (backend as Record<string, unknown>)["adapter"];
      if (adapter !== undefined && adapter !== OPENCODE_ADAPTER_ID) {
        issues.push(
          `backend.adapter: 只接受 ${OPENCODE_ADAPTER_ID}；收到 ${String(adapter)}（旧后端已归档，不能继续使用）`,
        );
      }
    }
  }

  return issues;
}

/**
 * 读取并校验配置对象。v2 输入返回内存规范化的 v3 结构（`sourceSchemaVersion=2`），
 * 不修改任何文件；v3 输入直接解析。v1／未知版本／新旧混用返回 issues。
 */
export function validateConfigObject(
  input: unknown,
): { ok: true; config: ProductConfig; sourceSchemaVersion: number } | { ok: false; issues: string[] } {
  const legacy = compatibilityIssues(input);
  if (legacy.length > 0) return { ok: false, issues: legacy };

  const asRecord = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (asRecord !== null && asRecord["schemaVersion"] === 2 && asRecord["backend"] !== undefined) {
    const parsedV2 = legacyV2ConfigSchema.safeParse(input);
    if (!parsedV2.success) {
      return { ok: false, issues: parsedV2.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`) };
    }
    return { ok: true, config: normalizeLegacyV2Config(parsedV2.data), sourceSchemaVersion: 2 };
  }

  const parsed = productConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`) };
  }
  const config = parsed.data;
  const issues: string[] = [];

  const seenIds = new Set<string>();
  for (const workspace of config.workspaces) {
    if (seenIds.has(workspace.id)) issues.push(`workspaces: 重复的 id ${workspace.id}`);
    seenIds.add(workspace.id);
    const problem = checkWorkspaceRoot(workspace.root);
    if (problem) issues.push(`workspaces.${workspace.id}.root: ${problem}`);
    if (new Set(workspace.profiles).size !== workspace.profiles.length) {
      issues.push(`workspaces.${workspace.id}.profiles: 存在重复 profile`);
    }
  }

  if (config.transport.http.enabled && !/^(127\.0\.0\.1|::1|localhost)$/.test(config.transport.http.bind)) {
    issues.push("transport.http.bind: v1 只允许 loopback 绑定");
  }

  issues.push(...backendTableIssues(config));

  return issues.length === 0 ? { ok: true, config, sourceSchemaVersion: CONFIG_SCHEMA_VERSION } : { ok: false, issues };
}

/** `zbridge config init` 生成的样例：不含任何真实路径或凭证。 */
export function configTemplate(): ProductConfig {
  return productConfigSchema.parse({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    mode: "personal",
    defaultBackend: "opencode",
    backends: {
      opencode: {
        adapter: OPENCODE_ADAPTER_ID,
        enabled: true,
        pinnedVersion: OPENCODE_PINNED_VERSION,
        executable: null,
        providerConfigFile: null,
        modelProfiles: {
          default: { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" },
        },
      },
    },
    workspaces: [
      {
        id: "demo",
        name: "示例工作区",
        root: "/absolute/path/to/disposable/project",
        profiles: ["review"],
      },
    ],
    limits: {},
    transport: { stdio: true, http: { enabled: false, bind: "127.0.0.1" } },
  });
}
