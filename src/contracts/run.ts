/**
 * Run（一次前台执行 turn）状态与对外快照。
 *
 * 只有「有证据的后端终态」才能标 completed；无输出或一段时间无事件不能推断成功
 * （技术规格 §3）。unknown 是终态但**不解除** session 阻塞。
 */
import type { RunId, SessionId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";
import type { WorkspaceProfile } from "./workspace.ts";
import type { BackendId, ContractVersion } from "./version.ts";

export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
  "draining",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
  "unknown",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
  "unknown",
] as const satisfies readonly RunState[];

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/**
 * 迁移前固定实现使用的模型标识（OC-08 之前 selected_model 列不存在，历史行为固定 MiniMax）。
 * 只用于解释历史 NULL 行与旧回执重放，不是当前产品限制；不能回填为用户后来修改的 default。
 */
export const LEGACY_PROVIDER_ID = "minimax";
export const LEGACY_MODEL_ID = "MiniMax-M3.1-Flash";
export const LEGACY_MODEL_REF = `${LEGACY_PROVIDER_ID}/${LEGACY_MODEL_ID}`;

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATES);

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return TERMINAL_SET.has(state);
}

/**
 * 后端中立的停止原因（产品词汇）。
 *
 * OpenCode 的 assistant `finish`（stop / tool-calls / length …）与
 * `info.error`（MessageAbortedError 等）必须先经 `core/backend-result.ts` 映射，
 * 不能把 ACP 的 end_turn 一类原样写成产品原因，也不能让同名值暗示成功。
 */
export const STOP_REASONS = [
  "turn_complete",
  "tool_calls_pending",
  "aborted",
  "refusal",
  "output_limit",
  "backend_error",
] as const;

export type KnownStopReason = (typeof STOP_REASONS)[number];

/** `unknown:<raw>` 保留原始字符串以便取证，但绝不参与「是否成功」判断。 */
export type StopReason = KnownStopReason | `unknown:${string}`;

const KNOWN_STOP_SET: ReadonlySet<string> = new Set<string>(STOP_REASONS);

export function normalizeStopReason(raw: string | null | undefined): StopReason | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return KNOWN_STOP_SET.has(raw) ? (raw as KnownStopReason) : `unknown:${raw}`;
}

/** 等待/继续的建议动作；只是建议，不是宿主执行保证。 */
export const NEXT_ACTIONS = [
  "wait",
  "wait_approval",
  "wait_input",
  "read_result",
  "none",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface Run {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** 客户端幂等 key，不是 IPC/MCP 请求 ID。 */
  readonly requestId: string;
  readonly requestHash: string;
  readonly profile: WorkspaceProfile;
  /**
   * OC-09：本 run 固定归属的后端。migration v5 之前的行确定标记 opencode；
   * 已受理 run 不因后续配置变化改写归属。
   */
  readonly backendId: BackendId;
  readonly state: RunState;
  readonly revision: number;
  readonly lastEventSeq: number;
  /** dispatch intent 的标识；崩溃恢复时靠它判断「是否可能已发出」。 */
  readonly backendAttemptId: string | null;
  readonly deadlineAt: IsoTimestamp;
  readonly resultManifestId: string | null;
  /**
   * OC-08：受理时解析并持久化的完整模型标识（`providerID/modelID`）。
   * null 只属于迁移前的历史 run（当时实现固定 minimax/MiniMax-M3.1-Flash），
   * 读取侧按这一事实解释，不能回填为当前 default。
   */
  readonly selectedModel: string | null;
  /** 后端关联消息里实际观测到的模型标识；尚无证据时为 null。 */
  readonly observedModel: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** 技术规格 §6 的通用返回体（单 run 形态）。 */
export interface RunSnapshot {
  readonly contractVersion: ContractVersion;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** OC-09：run 的后端归属；与受理时持久化的 backendId 一致。 */
  readonly backendId: BackendId;
  readonly state: RunState;
  readonly revision: number;
  readonly lastEventSeq: number;
  readonly earliestSeq: number;
  readonly nextAction: NextAction;
  readonly resultReady: boolean;
  readonly warnings: readonly string[];
  /** OC-08：受理时持久化的选定模型（完整 `providerID/modelID`；历史 run 为 null）。 */
  readonly selectedModel: string | null;
  /** OC-08：后端关联消息实际观测到的模型；尚无证据时为 null。 */
  readonly observedModel: string | null;
}

export function nextActionFor(state: RunState, resultReady: boolean): NextAction {
  switch (state) {
    case "waiting_approval":
      return "wait_approval";
    case "waiting_input":
      return "wait_input";
    case "completed":
      return resultReady ? "read_result" : "none";
    case "queued":
    case "starting":
    case "running":
    case "draining":
    case "stopping":
      return "wait";
    default:
      return "none";
  }
}
