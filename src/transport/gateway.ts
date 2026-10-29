/**
 * MCP stdio gateway（OC-05）。
 *
 * - 只连接本地 daemon 的 **client** IPC（普通查询/执行通道）；不启动/接管
 *   OpenCode，不持有任务，不连 operator socket，也不注册审批入口；
 * - stdout 只输出 MCP 帧（StdioServerTransport 独占）；诊断一律走 stderr；
 * - 注册集合 = IMPLEMENTED_TOOLS ∩ TOOL_MANIFEST（未实现的工具不注册），
 *   与 `zbridge tools list --json` 共用同一份集合；
 * - 工具输入 schema 是**完整 strict Zod 对象**直接交给 SDK（不是 .shape）：
 *   SDK 用它生成 tools/list 的 JSON Schema 并在 tools/call 时校验，
 *   未知字段在 zod strictObject 层拒绝，不存在「.shape 剥离未知字段」的旁路；
 * - gateway 断开不取消 run：daemon 侧任务继续，重连后凭 runId/clientRequestId
 *   找回原 run、结果与会话。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { resolveDaemonPaths } from "../daemon/layout.ts";
import { ipcCall } from "../daemon/ipc.ts";
import { TOOL_MANIFEST, type ToolName } from "../contracts/tools.ts";
import { PRODUCT_VERSION } from "../contracts/version.ts";
import type { DaemonClient, ToolOutcome } from "./handlers.ts";
import {
  handleAgentCapabilities,
  handleAgentCancel,
  handleAgentClose,
  handleAgentEvents,
  handleAgentGet,
  handleAgentInterrupt,
  handleAgentResult,
  handleAgentSessions,
  handleAgentStart,
  handleAgentWait,
  handleArtifactRead,
  handleWorkspaceList,
  guard,
  IMPLEMENTED_TOOLS,
} from "./handlers.ts";

export const GATEWAY_SERVER_NAME = "cli-mcp-bridge";

/** 真实 Unix socket 客户端：每次调用一条短连接，无状态、无连接泄漏。 */
export class IpcDaemonClient implements DaemonClient {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  call<T = unknown>(
    kind: string,
    payload: Record<string, unknown>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<T> {
    return ipcCall<T>(this.path, kind, payload, options);
  }
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** 单一派发点：每个工具的异常都收敛成 MCP isError + 机器可读错误码。 */
export async function dispatchTool(
  name: ToolName,
  args: Record<string, unknown>,
  client: DaemonClient,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  return guard(async (): Promise<ToolOutcome> => {
    switch (name) {
      case "agent_capabilities":
        return handleAgentCapabilities({}, client);
      case "workspace_list":
        return handleWorkspaceList(args as never, client);
      case "agent_start":
        return handleAgentStart(args as never, client);
      case "agent_get":
        return handleAgentGet(args as never, client);
      case "agent_wait":
        return handleAgentWait(args as never, client, signal);
      case "agent_events":
        return handleAgentEvents(args as never, client);
      case "agent_result":
        return handleAgentResult(args as never, client);
      case "agent_interrupt":
        return handleAgentInterrupt(args as never, client);
      case "agent_cancel":
        return handleAgentCancel(args as never, client);
      case "agent_sessions":
        return handleAgentSessions(args as never, client);
      case "agent_close":
        return handleAgentClose(args as never, client);
      case "artifact_read":
        return handleArtifactRead(args as never, client);
    }
  });
}

export interface BuiltGateway {
  readonly mcp: McpServer;
  readonly registeredTools: readonly ToolName[];
}

/**
 * 构建 gateway。注册给 SDK 的是完整 strict Zod 对象；未实现的工具不注册。
 */
export function buildGateway(options: { readonly client: DaemonClient; readonly instructions?: string }): BuiltGateway {
  const mcp = new McpServer(
    { name: GATEWAY_SERVER_NAME, version: PRODUCT_VERSION },
    {
      capabilities: { tools: {} },
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
  );
  const registeredTools: ToolName[] = [];
  for (const tool of TOOL_MANIFEST) {
    if (!IMPLEMENTED_TOOLS.has(tool.name)) continue;
    registeredTools.push(tool.name);
    mcp.registerTool(
      tool.name,
      {
        description: tool.summary,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>, extra: Extra): Promise<ToolOutcome> =>
        dispatchTool(tool.name, args, options.client, extra.signal),
    );
  }
  return { mcp, registeredTools };
}

/**
 * stdio 入口：连接 StdioServerTransport 并挂起直到传输关闭。
 * stdin 关闭（宿主断开）即退出；daemon 侧 run 不受影响。
 */
export async function runStdioGateway(options: {
  readonly dataDir: string;
  readonly onEvent?: (message: string) => void;
}): Promise<void> {
  const paths = resolveDaemonPaths(options.dataDir);
  const client = new IpcDaemonClient(paths.clientSocket);
  const gateway = buildGateway({
    client,
    instructions:
      "CLI MCP Bridge：通过本地 daemon 受理 review 任务、观察进度并读取结果与工件。" +
      "所有查询不触发模型执行；profile=edit、非空 contextArtifactIds、非默认 timeoutMs 明确拒绝；" +
      "模型经 agent_start.model 从本地配置允许列表选择（见 agent_capabilities.models），省略沿用会话选择。",
  });
  options.onEvent?.(`gateway ready pid=${process.pid} socket=${paths.clientSocket} tools=${gateway.registeredTools.length}`);
  const closed = new Promise<void>((resolve) => {
    gateway.mcp.server.onclose = () => resolve();
  });
  // EOF-only 断连：宿主可能只关闭 stdin 而不发送任何信号。SDK 的
  // StdioServerTransport 不监听 end/close，gateway 必须自己兜底：
  // stdin 结束 → 主动 close（abort 在途请求的 AbortSignal → IPC 等待立即收尾，
  // daemon 侧 run 不受影响）→ 进程退出。
  const handleStdinEof = (): void => {
    options.onEvent?.("gateway stdin ended; closing MCP server (in-flight requests aborted, runs untouched)");
    void gateway.mcp.close().catch(() => undefined);
  };
  process.stdin.on("end", handleStdinEof);
  process.stdin.on("close", handleStdinEof);
  const transport = new StdioServerTransport();
  await gateway.mcp.connect(transport);
  options.onEvent?.("gateway transport connected; waiting for MCP client");
  await closed;
  process.stdin.removeListener("end", handleStdinEof);
  process.stdin.removeListener("close", handleStdinEof);
  options.onEvent?.("gateway transport closed; exiting without cancelling daemon runs");
}
