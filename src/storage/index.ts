/**
 * 存储层唯一入口。
 *
 * OC-02 只交付持久化能力：受理、状态/事件、dispatch 证据、审批、工件、结果和恢复。
 * 这里没有 OpenCode adapter、daemon、MCP 或 operator 通道。
 */
export { BridgeStore, type BridgeStoreOptions, type AdmitRunInput, type AdmitRunResult, type PrepareDispatchInput, type PrepareDispatchResult, type CreateApprovalInput, type CompleteRunResult } from "./store.ts";
export { CURRENT_SCHEMA_VERSION, MIGRATIONS, migrate, type Migration } from "./migrations.ts";
export { defaultIdFactory, type IdFactory } from "./ids.ts";
export { WorkerProcessRepository, type WorkerProcessRecord, type WorkerProcessStatus } from "./repositories/worker.ts";
export { ToolReceiptRepository, type ToolReceipt } from "./repositories/toolreceipt.ts";
export type {
  DispatchIntent,
  DispatchPhase,
  EventPageResult,
  RecoveryDisposition,
  RecoveryReport,
  RecoveryRunReport,
  RequestReceipt,
  ResultClaimInput,
  ResultInput,
  ResultManifest,
  RunTransitionResult,
  ServerInstance,
  ServiceInstance,
  SessionRecord,
  VerificationClaim,
} from "./types.ts";
export { DISPATCH_PHASES } from "./types.ts";
