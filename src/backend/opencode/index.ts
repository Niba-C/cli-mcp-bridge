/**
 * OpenCode HTTP adapter 的唯一入口。
 *
 * 本目录只覆盖 OC-03：独占 worker、HTTP／SSE、消息与工具归属、审批转发、终态与停止回收。
 * 没有 daemon 调度、operator 通道或 MCP endpoint（OC-04／05）。
 */
export { OpenCodeHttpAdapter, type OpenCodeAdapterOptions } from "./adapter.ts";
export type {
  OpenCodeDispatchObservation,
  OpenCodeTurnResult,
  RequestOutcome,
  TurnObservations,
  TurnStopCause,
} from "./adapter.ts";
export { OpenCodeWorker, pinnedServeCommand, assertLoopbackUrl, buildWorkerEnv, ownedProcesses, listProcessTable } from "./worker.ts";
export type { WorkerCommand, WorkerOptions, WorkerStartResult, WorkerStopReport, BuiltEnv, ProcessInfo } from "./worker.ts";
export { OpenCodeApi } from "./client.ts";
export type { PromptInput, ProviderSummary, SessionCreateInput } from "./client.ts";
export { OpencodeHttpClient } from "./http.ts";
export type { HttpFailure, HttpResult, HttpSuccess } from "./http.ts";
export { SseDecoder, SseEventDeduper } from "./sse.ts";
export type { SseFrame } from "./sse.ts";
export { TurnEventStream } from "./event-stream.ts";
export { TextTracker } from "./text-tracker.ts";
export { ApprovalCoordinator } from "./approvals.ts";
export {
  LEGACY_MODEL_ID,
  LEGACY_MODEL_REF,
  LEGACY_PROVIDER_ID,
  assertPinnedVersion,
  assertResponseIdentity,
  buildControlledConfig,
  buildModelGate,
  modelRef,
  parseModelRef,
  parseProviderConfigFile,
  permissionRules,
  type ModelGate,
} from "./profile.ts";
export {
  attributeRun,
  collectTools,
  assistantText,
  newUserMessageId,
  parseMessageList,
  parsePermissionList,
} from "./protocol.ts";
export { OpenCodeRunCoordinator } from "./coordinator.ts";
export type { CoordinatorInput, CoordinatorResult } from "./coordinator.ts";
