/**
 * OC-05 传输层入口：MCP stdio gateway 与 12 个工具的真实处理器。
 */
export { buildGateway, runStdioGateway, dispatchTool, IpcDaemonClient, GATEWAY_SERVER_NAME, type BuiltGateway } from "./gateway.ts";
export {
  IMPLEMENTED_TOOLS,
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
  type DaemonClient,
  type ToolOutcome,
} from "./handlers.ts";
