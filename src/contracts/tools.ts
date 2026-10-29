/**
 * MCP 工具输入契约（v0.1 工具面）+ 注册门禁。
 *
 * 两条硬规则：
 * 1. 所有对象都是 strict：未知字段一律拒绝。尤其不能出现 cwd / env / command /
 *    providerKey 这类「把执行位置、环境或凭证交给调用方」的字段；
 * 2. 能力没实现就不注册工具（技术规格 §9）。`registrableTools()` 只放行
 *    stage=v0.1 且被显式标记为已实现的工具，OC-01 阶段这份集合是空的。
 *
 * OC-08 例外说明：`agent_start.model` 是唯一撞上危险字段黑名单（"model"）的
 * 合法顶层字段。它只接受 `providerID/modelID` 字符串，值在服务端与本地配置的
 * 允许列表精确比对（PROFILE_NOT_ALLOWED），不携带 URL、凭据或供应商参数；
 * 黑名单里的 "model" 对其它工具与所有嵌套位置仍然生效。
 */
import { z } from "zod";
import { ID_PREFIX, isId, type IdKind } from "./ids.ts";

export const TOOL_NAMES = [
  "agent_capabilities",
  "workspace_list",
  "agent_start",
  "agent_get",
  "agent_wait",
  "agent_events",
  "agent_result",
  "agent_interrupt",
  "agent_cancel",
  "agent_sessions",
  "agent_close",
  "artifact_read",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * 危险字段黑名单（按「去掉分隔符、转小写」后的名字比较）。
 * 这些字段一旦被允许，就等于把工作区/环境/可执行文件/凭证的决定权交给调用方。
 */
export const FORBIDDEN_INPUT_KEYS = [
  "cwd",
  "workdir",
  "workingdirectory",
  "env",
  "environment",
  "envvars",
  "command",
  "cmd",
  "argv",
  "args",
  "shell",
  "executable",
  "binary",
  "script",
  "path",
  "filepath",
  "filename",
  "dir",
  "directory",
  "root",
  "workspaceroot",
  "provider",
  "providerkey",
  "providerid",
  "model",
  "modelkey",
  "apikey",
  "token",
  "secret",
  "credential",
  "credentials",
  "authorization",
  "url",
  "uri",
  "endpoint",
  "baseurl",
  "host",
  "port",
  "principal",
  "principalid",
  "ownerid",
  "userid",
] as const;

const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_INPUT_KEYS);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ForbiddenKeyHit {
  readonly key: string;
  readonly path: string;
  readonly normalized: string;
}

/** 递归扫描（含嵌套对象与数组），深度上限 6，超出即视为可疑并报告。
 * exemptTopLevel 仅在顶层（path 为 "$.<key>"）生效：这些键由该工具的 schema
 * 显式声明并校验类型（目前只有 agent_start.model），嵌套位置仍按黑名单拒绝。 */
export function findForbiddenKey(
  value: unknown,
  path = "$",
  depth = 0,
  exemptTopLevel: ReadonlySet<string> = EMPTY_EXEMPT,
): ForbiddenKeyHit | null {
  if (depth > 6) return { key: "<depth>", path, normalized: "<depth>" };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findForbiddenKey(value[index], `${path}[${index}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (depth === 0 && exemptTopLevel.has(key)) continue;
    const normalized = normalizeKey(key);
    if (FORBIDDEN_SET.has(normalized)) return { key, path: `${path}.${key}`, normalized };
    const hit = findForbiddenKey(child, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const EMPTY_EXEMPT: ReadonlySet<string> = new Set<string>();

/**
 * strict 对象 + 危险字段扫描。所有工具输入都必须经它构造。
 * exemptTopLevel：撞上黑名单但被该工具 schema 显式声明为合法的顶层字段
 * （OC-08 的 agent_start.model）。豁免只作用于顶层键名；其它工具、嵌套对象
 * 与数组里的同名字段仍被拒绝，字段值的形状由 zod schema 严格校验。
 */
function toolObject<T extends z.ZodRawShape>(
  shape: T,
  options: { readonly exemptTopLevel?: readonly string[] } = {},
): z.ZodObject<T> {
  const exempt = new Set(options.exemptTopLevel ?? []);
  const base = z.strictObject(shape);
  // 运行时只多一条检查，形状不变；这里的断言只为保住 z.infer 的对象类型。
  return base.superRefine((value, ctx) => {
    const hit = findForbiddenKey(value, "$", 0, exempt);
    if (hit) {
      ctx.addIssue({
        code: "custom",
        message: `不允许的字段 ${hit.key}（${hit.path}）：路径/环境/命令/凭证必须由服务端决定`,
      });
    }
  }) as unknown as z.ZodObject<T>;
}

const idString = (kind: IdKind) =>
  z.string().refine((value) => isId(kind, value), { message: `不是合法的 ${ID_PREFIX[kind]} id` });

const workspaceIdSchema = idString("workspace");
const runIdSchema = idString("run");
const sessionIdSchema = idString("session");
const artifactIdSchema = idString("artifact");

const clientRequestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "clientRequestId 只允许字母数字与 . _ : -");

const serviceEpochSchema = z.number().int().min(0);

const profileSchema = z.enum(["review", "edit"]);

/** 一次 prompt 的字符上限。技术规格按 64 KiB 总输入计，这里先按字符保守收紧。 */
const PROMPT_MAX_CHARS = 65536;

export const agentCapabilitiesInput = toolObject({});

export const workspaceListInput = toolObject({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * OC-08：完整模型标识 `providerID/modelID`。schema 只做类型与长度收紧，
 * 格式与允许列表在服务端受理路径校验（INVALID_ARGUMENT／PROFILE_NOT_ALLOWED）；
 * 省略时沿用会话最近一次已受理选择，新会话用 default。
 * OC-09 起对 codebuddy/qoder 后端该值为后端原生模型 ID 单段字符串，
 * 同样在受理路径按该后端允许列表校验。
 */
const modelRefSchema = z.string().min(3).max(257);

export const agentStartInput = toolObject(
  {
    workspaceId: workspaceIdSchema,
    prompt: z.string().min(1).max(PROMPT_MAX_CHARS),
    clientRequestId: clientRequestIdSchema,
    serviceEpoch: serviceEpochSchema,
    sessionId: sessionIdSchema.optional(),
    profile: profileSchema.optional(),
    /**
     * OC-09：目标后端。新会话省略时取配置 defaultBackend；已有会话省略时
     * 继承会话持久化的 backendId，显式指定不同后端返回 backend_session_mismatch。
     */
    backend: z.enum(["opencode", "codebuddy", "qoder"]).optional(),
    model: modelRefSchema.optional(),
    contextArtifactIds: z.array(artifactIdSchema).max(32).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  },
  { exemptTopLevel: ["model"] },
);

export const agentGetInput = toolObject({ runId: runIdSchema });

export const agentWaitInput = toolObject({
  runs: z
    .array(
      z.strictObject({
        runId: runIdSchema,
        afterRevision: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(8),
  returnWhen: z.enum(["any_change", "any_terminal", "all_terminal"]).optional(),
  timeoutMs: z.number().int().min(0).max(25_000).optional(),
});

export const agentEventsInput = toolObject({
  runId: runIdSchema,
  afterSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const agentResultInput = toolObject({
  runId: runIdSchema,
  section: z.enum(["agentReported", "observed", "verification"]).optional(),
  offset: z.number().int().min(0).optional(),
  limitChars: z.number().int().min(1).max(16_000).optional(),
});

export const agentInterruptInput = toolObject({
  runId: runIdSchema,
  clientRequestId: clientRequestIdSchema,
  expectedRevision: z.number().int().min(0),
  serviceEpoch: serviceEpochSchema,
});

export const agentCancelInput = toolObject({
  runId: runIdSchema,
  clientRequestId: clientRequestIdSchema,
  expectedRevision: z.number().int().min(0),
  serviceEpoch: serviceEpochSchema,
});

export const agentSessionsInput = toolObject({
  cursor: z.string().max(256).optional(),
  workspaceId: workspaceIdSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const agentCloseInput = toolObject({
  sessionId: sessionIdSchema,
  clientRequestId: clientRequestIdSchema,
  expectedRevision: z.number().int().min(0),
  serviceEpoch: serviceEpochSchema,
});

export const artifactReadInput = toolObject({
  artifactId: artifactIdSchema,
  offset: z.number().int().min(0).optional(),
  limitChars: z.number().int().min(1).max(16_000).optional(),
});

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly stage: "v0.1" | "v0.2" | "v0.3";
  /** 计划由哪个任务实现；用于「未实现不注册」的门禁，不是完成声明。 */
  readonly implementedIn: string;
  readonly annotations: ToolAnnotations;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly summary: string;
}

const readOnly = (idempotent = true): ToolAnnotations => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: idempotent,
  openWorldHint: false,
});

const mutating = (idempotent: boolean, destructive: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

export const TOOL_MANIFEST: readonly ToolDefinition[] = [
  {
    name: "agent_capabilities",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentCapabilitiesInput,
    summary: "返回缓存的能力、版本、可用工具与 serviceEpoch；读取时不启动探针",
  },
  {
    name: "workspace_list",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: workspaceListInput,
    summary: "列出本主体已登记工作区；不返回本机绝对路径",
  },
  {
    name: "agent_start",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: mutating(true, true),
    schema: agentStartInput,
    summary: "受理一次执行并快速返回 runId；不等待任务完成；model 可从配置允许列表选择（OC-08）",
  },
  {
    name: "agent_get",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentGetInput,
    summary: "读取 run 持久快照与结果指针",
  },
  {
    name: "agent_wait",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentWaitInput,
    summary: "有界等待多个 run 的状态变化；超时不改 run 状态",
  },
  {
    name: "agent_events",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentEventsInput,
    summary: "按 seq 分页读取业务事件；只读，不改书签",
  },
  {
    name: "agent_result",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentResultInput,
    summary: "分页读取结果；未完成返回 RESULT_NOT_READY",
  },
  {
    name: "agent_interrupt",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: mutating(true, false),
    schema: agentInterruptInput,
    summary: "请求中断当前执行，保留可继续的逻辑会话",
  },
  {
    name: "agent_cancel",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: mutating(true, false),
    schema: agentCancelInput,
    summary: "幂等取消 run，并撤销尚未执行的 successor",
  },
  {
    name: "agent_sessions",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: agentSessionsInput,
    summary: "列出本主体的逻辑会话与可恢复等级",
  },
  {
    name: "agent_close",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: mutating(true, false),
    schema: agentCloseInput,
    summary: "关闭 idle 会话资源；保留历史，活跃时返回 SESSION_BUSY",
  },
  {
    name: "artifact_read",
    stage: "v0.1",
    implementedIn: "OC-05",
    annotations: readOnly(),
    schema: artifactReadInput,
    summary: "按 artifactId 分页读取受控文本工件；拒绝任意 path/URL",
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_MANIFEST.find((tool) => tool.name === name);
}

/**
 * 只返回「本版本要发布 + 已实际实现」的工具。
 * 传空集合是 OC-01 的正确状态：还没有 gateway，因此一个都不注册。
 */
export function registrableTools(implemented: ReadonlySet<ToolName>): readonly ToolDefinition[] {
  return TOOL_MANIFEST.filter((tool) => tool.stage === "v0.1" && implemented.has(tool.name));
}

export function unimplementedTools(implemented: ReadonlySet<ToolName>): readonly ToolDefinition[] {
  return TOOL_MANIFEST.filter((tool) => tool.stage === "v0.1" && !implemented.has(tool.name));
}
