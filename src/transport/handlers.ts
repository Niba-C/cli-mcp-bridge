/**
 * 12 个 MCP 工具的实际处理器（OC-05）。
 *
 * 规则（任务卡 §2–§8）：
 * - 全部数据/变更操作经 daemon 的普通 client IPC 完成；gateway 不打开数据库、
 *   不启动 worker、不连 operator socket；
 * - 主体与允许工作区来自 daemon 服务端上下文，工具参数里没有 principal/path/
 *   env/url 的容身之处（strict schema + 危险字段扫描在 contracts 层）；
 *   唯一例外是 agent_start.model：只接受配置允许列表内的 providerID/modelID，
 *   由 daemon 受理路径校验（OC-08）；
 * - 非默认取值（profile="edit"、非默认 timeoutMs、非空 contextArtifactIds）明确拒绝，
 *   不静默忽略；能力清单（agent_capabilities）同步说明这些限制；
 * - 查询类工具不会触发任何 worker 启动或模型调用。
 */
import { z } from "zod";
import { toMcpToolError, ZBridgeError } from "../contracts/errors.ts";
import {
  agentCapabilitiesInput,
  agentCancelInput,
  agentCloseInput,
  agentEventsInput,
  agentGetInput,
  agentInterruptInput,
  agentResultInput,
  agentSessionsInput,
  agentStartInput,
  agentWaitInput,
  artifactReadInput,
  TOOL_MANIFEST,
  workspaceListInput,
} from "../contracts/tools.ts";
import { sliceByCodePoints, RESULT_PAGE_MAX_CHARS } from "../contracts/paging.ts";
import { CONTRACT_VERSION, PRODUCT_VERSION, type BackendId } from "../contracts/version.ts";
import type { ToolName } from "../contracts/tools.ts";
export interface IpcCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** daemon client IPC 的最小接口；gateway 与离线测试都用真实 Unix socket 实现。 */
export interface DaemonClient {
  call<T = unknown>(kind: string, payload: Record<string, unknown>, options?: IpcCallOptions): Promise<T>;
}

/** MCP tools/call 的返回形状（SDK CallToolResult 的结构化子集）。 */
export interface ToolOutcome {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  /** SDK 的 CallToolResult 是 loose 对象；保留索引签名以兼容其类型。 */
  [key: string]: unknown;
}

type Args<T> = T;

function ok(payload: Record<string, unknown>, text?: string): ToolOutcome {
  const structured = { contractVersion: CONTRACT_VERSION, ...payload };
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(error: unknown): ToolOutcome {
  return toMcpToolError(error);
}

/** 把处理器异常收敛成 MCP isError 结果，保留机器可读错误码。 */
export async function guard(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}

/** daemon status 里的单后端摘要；旧 daemon 没有该字段。 */
interface BackendStatusSummary {
  readonly id: BackendId;
  readonly adapter: string;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly runtimeState: "not_started" | "running" | "stopped" | "unknown";
  readonly defaultModel: string | null;
  readonly allowedModels: readonly string[];
}

interface DaemonStatus {
  /** OC-09：产品契约版本；旧 daemon（升级前未重启）没有该字段。 */
  readonly contractVersion?: string;
  readonly pid: number;
  readonly serviceEpoch: number;
  readonly serverEpoch: number | null;
  readonly editEnabled: false;
  readonly controlChannelIsolation: "unverified";
  readonly limits: {
    readonly activeRuns: number;
    readonly runTimeoutMs: number;
    readonly waitTimeoutMs: number;
    readonly queueTtlMs: number;
    readonly approvalTimeoutMs: number;
    readonly artifactMaxBytes: number;
  };
  /** OC-08：本地配置生成的模型允许列表摘要（查询不启动 worker、不调用模型）。
   * 旧版 daemon（升级前未重启）的 ping 不含该字段——此时返回 null 并提示重启，不报错。 */
  readonly models?: {
    readonly default: string;
    readonly allowed: readonly string[];
  } | null;
  /** OC-09：新会话省略 backend 时的默认后端（本进程已加载值）。 */
  readonly defaultBackend?: BackendId;
  /** OC-09：已配置后端的稳定顺序摘要；无凭据、本机路径与 URL。 */
  readonly backends?: readonly BackendStatusSummary[];
}

// ---------------------------------------------------------------- 查询类

export async function handleAgentCapabilities(_args: Args<z.infer<typeof agentCapabilitiesInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const status = await client.call<DaemonStatus>("ping", {});
  const payload = {
    product: "cli-mcp-bridge",
    productVersion: PRODUCT_VERSION,
    contractVersion: CONTRACT_VERSION,
    serviceEpoch: status.serviceEpoch,
    serverEpoch: status.serverEpoch,
    editEnabled: status.editEnabled,
    controlChannelIsolation: status.controlChannelIsolation,
    tools: TOOL_MANIFEST.map((tool) => ({ name: tool.name, summary: tool.summary, annotations: tool.annotations })),
    limits: status.limits,
    supportedProfiles: ["review"],
    // OC-09：默认后端与稳定排序的后端表；均为本进程已加载快照，不启动探针。
    // 旧 daemon 没有这些字段：如实返回 null，不把混跑当成新能力。
    defaultBackend: status.defaultBackend ?? null,
    backends:
      status.backends === undefined
        ? null
        : status.backends.map((backend) => ({
            id: backend.id,
            adapter: backend.adapter,
            enabled: backend.enabled,
            loaded: backend.loaded,
            runtimeState: backend.runtimeState,
            profiles: ["review"],
            models: {
              default: backend.defaultModel,
              allowed: backend.allowedModels,
            },
            // 模型目录来自本地配置，不是账户可用性，也不是真实调用证据。
            evidence: {
              source: "local_config",
              level: "unverified",
              verifiedAt: null,
              note: "模型列表是本地允许列表；未代表账户可用或真实调用已通过",
            },
          })),
    // OC-08：允许选择来自本地配置，不代表已联网验证各模型可用性。
    // 顶层 models 固定为 OpenCode 兼容视图；OC-09 起 OpenCode 未配置时同样为 null。
    ...(status.models === undefined
      ? {
          models: null,
          unsupportedExtra: "daemon 为旧版本（无模型与后端摘要）：重启 daemon 并重载宿主后 agent_start.model/backend 才可用",
        }
      : status.models === null
        ? {
            models: null,
            unsupportedExtra: "本地配置未登记 OpenCode；新调用方按 backends[].models 选择模型",
          }
        : {
            models: {
              default: status.models.default,
              allowed: status.models.allowed,
              note: "允许列表由本地 backend.modelProfiles 生成；省略 model 沿用会话最近选择，新会话用 default",
            },
          }),
    wait: { maxRuns: 8, maxTimeoutMs: 25_000 },
    artifacts: {
      readByArtifactIdOnly: true,
      generatedPerRun: ["result text", "events JSONL", "workspace diff"],
      mediaType: "text/plain; charset=utf-8",
    },
    unsupported: [
      "profile=\"edit\"（控制通道隔离未建立，真实 edit 固定关闭）",
      "contextArtifactIds 非空（首版不支持把工件注入 prompt；保持 schema 兼容并显式拒绝）",
      "timeoutMs 非默认值（run 期限在首次受理时按服务端配置固定）",
      "任意 path/URL/凭据参数（strict schema 拒绝；模型只能经 agent_start.model 从配置允许列表选择，不接受 URL/密钥/额外供应商参数）",
      "operator 审批/解除阻塞入口（不注册为 MCP 工具）",
    ],
  };
  return ok(payload);
}

export async function handleWorkspaceList(args: Args<z.infer<typeof workspaceListInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<{ workspaces: Record<string, unknown>[] }>("workspace.list", {});
  const all = result.workspaces;
  const offset = args.cursor === undefined ? 0 : Number.parseInt(args.cursor, 10);
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const limit = args.limit ?? 100;
  const page = all.slice(start, start + limit);
  const nextOffset = start + page.length;
  return ok({
    workspaces: page,
    nextCursor: nextOffset < all.length ? String(nextOffset) : null,
  });
}

export async function handleAgentGet(args: Args<z.infer<typeof agentGetInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const snapshot = await client.call<Record<string, unknown>>("run.get", { runId: args.runId });
  return ok(snapshot);
}

export async function handleAgentWait(
  args: Args<z.infer<typeof agentWaitInput>>,
  client: DaemonClient,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  const result = await client.call<Record<string, unknown>>(
    "run.wait",
    {
      runs: args.runs,
      ...(args.returnWhen === undefined ? {} : { returnWhen: args.returnWhen }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    },
    // wait 的 socket 生命周期与 MCP 请求绑定：断连/abort 立即销毁，不留泄漏。
    { timeoutMs: (args.timeoutMs ?? 25_000) + 10_000, signal },
  );
  return ok(result);
}

export async function handleAgentEvents(args: Args<z.infer<typeof agentEventsInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<Record<string, unknown>>("run.events", {
    runId: args.runId,
    ...(args.afterSeq === undefined ? {} : { afterSeq: args.afterSeq }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  return ok(result);
}

interface ManifestProjection {
  readonly manifestId: string;
  readonly runId: string;
  /** OC-09：run 的后端归属；历史工件在读取边界投影，不改写原正文。 */
  readonly backendId?: string | null;
  readonly createdAt: string;
  readonly agentReported: readonly string[];
  readonly observed: readonly string[];
  readonly verification: readonly { readonly text: string; readonly evidenceRef: string }[];
  readonly verified: boolean;
  /** OC-08：受理时持久化的选定模型与后端观测模型（历史 run 的 selectedModel 为 null）。 */
  readonly selectedModel: string | null;
  readonly observedModel: string | null;
  readonly artifactPlan?: readonly string[];
  readonly artifacts?: readonly {
    readonly artifactId: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly provenance: string;
    readonly createdAt: string;
    readonly label?: string | null;
    readonly truncated?: boolean;
  }[];
}

export async function handleAgentResult(args: Args<z.infer<typeof agentResultInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const manifest = await client.call<ManifestProjection>("run.result", { runId: args.runId });
  const limit = args.limitChars ?? RESULT_PAGE_MAX_CHARS;
  // 缺省 section：三类证据**合并成有界组合文本**并同样走 code_point 分页，
  // 不允许无界返回；分段标记保留 agentReported/observed/verification 的区别。
  let text: string;
  let section: string;
  if (args.section === undefined) {
    const combined = [
      "[agentReported]（模型自述，不是 verification 证据）",
      ...manifest.agentReported,
      "[observed]（本产品实际观察）",
      ...manifest.observed,
      "[verification]（必须带证据引用）",
      ...manifest.verification.map((claim) => `${claim.text} [evidence: ${claim.evidenceRef}]`),
    ].join("\n\n");
    text = combined;
    section = "all";
  } else if (args.section === "verification") {
    // verification 必须能看出证据引用，不能与 agentReported 混同。
    text = manifest.verification.map((claim) => `${claim.text} [evidence: ${claim.evidenceRef}]`).join("\n\n");
    section = args.section;
  } else {
    const items = args.section === "agentReported" ? manifest.agentReported : manifest.observed;
    text = items.join("\n\n");
    section = args.section;
  }
  const page = sliceByCodePoints(text, args.offset ?? 0, limit);
  const expectedArtifacts = manifest.artifactPlan ?? ["result", "events", "workspace-diff"];
  const missingArtifacts = expectedArtifacts.filter((label) => !manifest.artifacts?.some((artifact) => artifact.label === label));
  const truncatedArtifactIds = (manifest.artifacts ?? []).filter((artifact) => artifact.truncated === true).map((artifact) => artifact.artifactId);
  return ok(
    {
      runId: manifest.runId,
      manifestId: manifest.manifestId,
      // OC-09：历史 manifest 没有 backendId 时如实返回 null，不按当前默认推断。
      backendId: manifest.backendId ?? null,
      section,
      verified: manifest.verified,
      // OC-08：选定值与实际观测值随结果一起返回（与 agent_get 口径一致）。
      selectedModel: manifest.selectedModel,
      observedModel: manifest.observedModel,
      ...(manifest.artifacts === undefined ? {} : { artifacts: manifest.artifacts }),
      artifactStatus: {
        expected: expectedArtifacts,
        missing: missingArtifacts,
        truncatedArtifactIds,
        complete: missingArtifacts.length === 0 && truncatedArtifactIds.length === 0,
      },
      page: {
        text: page.text,
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalLength: page.totalLength,
        hasMore: page.hasMore,
        unit: page.unit,
      },
    },
    page.text,
  );
}

export async function handleAgentSessions(args: Args<z.infer<typeof agentSessionsInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<{ sessions: Record<string, unknown>[]; nextCursor: string | null }>("session.list", {
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
  return ok(result);
}

export async function handleArtifactRead(args: Args<z.infer<typeof artifactReadInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<{
    artifactId: string;
    runId: string;
    mediaType: string;
    sha256: string;
    bytes: number;
    provenance: string;
    createdAt: string;
    page: {
      text: string;
      offset: number;
      nextOffset: number;
      totalLength: number;
      hasMore: boolean;
      unit: string;
    };
  }>("artifact.read", {
    artifactId: args.artifactId,
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limitChars === undefined ? {} : { limitChars: args.limitChars }),
  });
  return ok(result, result.page.text);
}

// ---------------------------------------------------------------- 变更类

export async function handleAgentStart(args: Args<z.infer<typeof agentStartInput>>, client: DaemonClient): Promise<ToolOutcome> {
  // 非默认取值显式拒绝，不静默忽略（capabilities 同步声明）。
  if (args.profile !== undefined && args.profile !== "review") {
    throw new ZBridgeError("PROFILE_NOT_ALLOWED", "profile=\"edit\" 未开放：控制通道隔离未建立，真实 edit 固定关闭", {
      details: { profile: args.profile },
    });
  }
  if (args.contextArtifactIds !== undefined && args.contextArtifactIds.length > 0) {
    throw new ZBridgeError("INVALID_ARGUMENT", "contextArtifactIds 首版不支持把工件注入 prompt；空数组可传，非空显式拒绝", {
      details: { provided: args.contextArtifactIds.length },
    });
  }
  const status = await client.call<DaemonStatus>("ping", {});
  // OC-09 §4.4：新 gateway 面对旧 daemon（无版本字段或版本不同）必须在派发前拒绝，
  // 不能把本轮静默当成 OpenCode 执行。
  if (status.contractVersion !== CONTRACT_VERSION) {
    throw new ZBridgeError(
      "BACKEND_PROTOCOL_MISMATCH",
      "daemon 契约版本与当前 gateway 不一致；请重启 daemon 并重载宿主后重试",
      {
        details: {
          reason: "daemon_contract_upgrade_required",
          daemonContractVersion: status.contractVersion ?? null,
          requiredContractVersion: CONTRACT_VERSION,
        },
      },
    );
  }
  if (args.timeoutMs !== undefined && args.timeoutMs !== status.limits.runTimeoutMs) {
    throw new ZBridgeError("INVALID_ARGUMENT", "timeoutMs 只接受服务端配置的 run 期限；期限在首次受理时固定，重试不重新计算", {
      details: { requested: args.timeoutMs, configured: status.limits.runTimeoutMs },
    });
  }
  // workspaceId 是登记 ID（ws_*）；daemon 侧按 slug 定位，这里先解析。
  const workspaces = await client.call<{ workspaces: Array<{ workspaceId: string; name: string }> }>("workspace.list", {});
  const workspace = workspaces.workspaces.find((candidate) => candidate.workspaceId === args.workspaceId);
  if (workspace === undefined) {
    throw new ZBridgeError("WORKSPACE_NOT_ALLOWED", "workspace 未登记或不属于当前主体");
  }
  const outcome = await client.call<Record<string, unknown>>(
    "run.start",
    {
      prompt: args.prompt,
      clientRequestId: args.clientRequestId,
      serviceEpoch: args.serviceEpoch,
      workspaceSlug: workspace.name,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      // OC-08：显式模型选择。格式/允许列表/继承语义由 daemon 受理路径统一裁决，
      // 这里不做第二次解释，保证错误码与幂等行为与 IPC 面一致。
      ...(args.model === undefined ? {} : { model: args.model }),
      // OC-09：显式后端选择。归属/继承/冲突语义同样在 daemon 受理路径裁决。
      ...(args.backend === undefined ? {} : { backend: args.backend }),
    },
    { timeoutMs: 30_000 },
  );
  return ok(outcome);
}

export async function handleAgentInterrupt(args: Args<z.infer<typeof agentInterruptInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<Record<string, unknown>>(
    "run.interrupt",
    {
      runId: args.runId,
      clientRequestId: args.clientRequestId,
      expectedRevision: args.expectedRevision,
      serviceEpoch: args.serviceEpoch,
    },
    { timeoutMs: 30_000 },
  );
  return ok(result);
}

export async function handleAgentCancel(args: Args<z.infer<typeof agentCancelInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<Record<string, unknown>>(
    "run.cancel",
    {
      runId: args.runId,
      clientRequestId: args.clientRequestId,
      expectedRevision: args.expectedRevision,
      serviceEpoch: args.serviceEpoch,
    },
    { timeoutMs: 30_000 },
  );
  return ok(result);
}

export async function handleAgentClose(args: Args<z.infer<typeof agentCloseInput>>, client: DaemonClient): Promise<ToolOutcome> {
  const result = await client.call<Record<string, unknown>>(
    "session.close",
    {
      sessionId: args.sessionId,
      clientRequestId: args.clientRequestId,
      expectedRevision: args.expectedRevision,
      serviceEpoch: args.serviceEpoch,
    },
    { timeoutMs: 30_000 },
  );
  return ok(result);
}

/** 工具名 → 处理器；只注册这里真实存在的实现（gateway 与 CLI 共用这份集合）。 */
export const IMPLEMENTED_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
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
]);
