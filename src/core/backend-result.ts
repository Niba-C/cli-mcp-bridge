/**
 * 后端中立的本轮结果表达 + OpenCode finish／error 的纯映射。
 *
 * 这一层只做纯函数映射，不发起 HTTP、不起进程，也不属于 OC-03 的真实 adapter；
 * 它把 OpenCode 消息里的 `info.finish`（stop / tool-calls / length …）与
 * `info.error`（如 MessageAbortedError）翻译成产品词汇，业务层不再直接看到
 * 后端字面值，也就不会把 `tool-calls` 或停止后的 `stop` 误当正常完成。
 *
 * 证据优先级（顺序即实现顺序）：
 * 1. 归属：没有确认本 run 关联的消息时，任何事件都不能结束当前 run；
 * 2. 仍在运行的工具：优先于错误和停止信号，不能借错误／取消绕过；
 * 3. 停止信号：只是意图或中止观察，没有「消息完成 + 工具结束」时不算已停止；
 * 4. 其它后端错误；
 * 5. 只有消息明确完成、工具明确结束、finish=stop 才映射为 completed。
 * 缺失证据时保持非终态；消息明确完成但 finish 不可判定、或观察已结束仍无结论时，
 * 才是终态 unknown。
 */
import type { StopReason, TerminalRunState } from "../contracts/run.ts";

export const TURN_RESULTS = [
  "completed",
  "in_progress",
  "unattributed",
  "tool_calls_pending",
  "stopping",
  "aborted",
  "refused",
  "output_limit",
  "backend_error",
  "unknown",
] as const;
export type TurnResult = (typeof TURN_RESULTS)[number];

export interface BackendTurnResult {
  readonly result: TurnResult;
  /** 能否作为 run 终态。false 表示仍应等待后续事件。 */
  readonly terminal: boolean;
  /** 只有 terminal=true 时才给出终态；非终态固定为 null。 */
  readonly kind: TerminalRunState | null;
  readonly stopReason: StopReason | null;
  /** 原始 finish，只供审计，不参与「是否成功」判断。 */
  readonly rawFinish: string | null;
  /** 原始错误名，只供审计与错误分类。 */
  readonly errorName: string | null;
}

export interface OpencodeTurnInfo {
  /** assistant 消息的 info.finish；消息未完成时为 null。 */
  readonly finish: string | null;
  /** info.error.name，例如 MessageAbortedError。 */
  readonly errorName?: string | null;
  /** 已发出停止意图（abort）。只是意图，不代表停止已经完成。 */
  readonly stopping?: boolean;
  /** 本 run 是否仍有未结束的工具调用；true 表示确定仍在运行。 */
  readonly toolsPending?: boolean;
  /** 是否已确认本 run 关联的消息存在；缺省或 false 表示缺少归属证据。 */
  readonly messageConfirmed?: boolean;
  /** assistant 消息是否明确完成（例如存在完成时间）；缺省表示没有完成证据。 */
  readonly messageCompleted?: boolean;
  /** 观察窗口是否已经结束（快照收敛、SSE 结束等）；缺省表示仍在观察。 */
  readonly observationEnded?: boolean;
}

/** 停止类错误不等于失败：取消实测里 assistant 仍可能带 MessageAbortedError。 */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(["MessageAbortedError", "AbortError"]);

function terminalResult(
  value: TurnResult,
  kind: TerminalRunState,
  stopReason: StopReason | null,
  rawFinish: string | null,
  errorName: string | null,
): BackendTurnResult {
  return { result: value, terminal: true, kind, stopReason, rawFinish, errorName };
}

function pendingResult(
  value: TurnResult,
  stopReason: StopReason | null,
  rawFinish: string | null,
  errorName: string | null,
): BackendTurnResult {
  return { result: value, terminal: false, kind: null, stopReason, rawFinish, errorName };
}

function unknownTerminal(
  stopReason: StopReason | null,
  rawFinish: string | null,
  errorName: string | null,
): BackendTurnResult {
  return terminalResult("unknown", "unknown", stopReason, rawFinish, errorName);
}

export function mapOpencodeTurn(info: OpencodeTurnInfo): BackendTurnResult {
  const rawFinish = info.finish ?? null;
  const errorName = info.errorName ?? null;
  // 缺省值必须按「没有证据」处理，不能默认归属或默认完成。
  const messageConfirmed = info.messageConfirmed === true;
  const messageCompleted = info.messageCompleted === true;
  const observationEnded = info.observationEnded === true;
  const toolsPending = info.toolsPending;
  const toolsSettled = toolsPending === false;
  const abortSignal = (errorName !== null && ABORT_ERROR_NAMES.has(errorName)) || info.stopping === true;

  // 1. 归属优先：无法归属的消息既不能完成，也不能取消当前 run。
  if (!messageConfirmed) {
    return pendingResult("unattributed", null, rawFinish, errorName);
  }

  // 2. 仍在运行的工具优先于错误与停止信号。
  if (toolsPending === true) {
    return pendingResult("tool_calls_pending", "tool_calls_pending", rawFinish, errorName);
  }

  // 3. 停止信号：只有消息完成且工具已结束才是已确认的停止。
  if (abortSignal) {
    if (messageCompleted && toolsSettled) {
      return terminalResult("aborted", "cancelled", "aborted", rawFinish, errorName);
    }
    if (observationEnded) {
      // 观察结束仍没有「完成 + 工具结束」证据：不能宣称已停止，也不能当作仍在运行。
      return unknownTerminal("aborted", rawFinish, errorName);
    }
    return pendingResult("stopping", "aborted", rawFinish, errorName);
  }

  // 4. 其它显式后端错误。
  if (errorName !== null || rawFinish === "error") {
    if (messageCompleted && toolsSettled) {
      return terminalResult("backend_error", "failed", "backend_error", rawFinish, errorName);
    }
    if (observationEnded) {
      return unknownTerminal("backend_error", rawFinish, errorName);
    }
    return pendingResult("in_progress", "backend_error", rawFinish, errorName);
  }

  // 5. 消息尚未完成：普通增量更新保持非终态。
  if (!messageCompleted) {
    if (observationEnded) return unknownTerminal(null, rawFinish, errorName);
    return pendingResult("in_progress", null, rawFinish, errorName);
  }

  // 6. 消息已完成但工具状态未证明结束：不能完成，也不能猜成失败。
  if (!toolsSettled) {
    if (observationEnded) return unknownTerminal(null, rawFinish, errorName);
    return pendingResult("in_progress", null, rawFinish, errorName);
  }

  switch (rawFinish) {
    case "stop":
      return terminalResult("completed", "completed", "turn_complete", rawFinish, null);
    case "tool-calls":
      // 模型要求继续执行工具；不是最终完成。
      return pendingResult("tool_calls_pending", "tool_calls_pending", rawFinish, null);
    case "length":
      return terminalResult("output_limit", "failed", "output_limit", rawFinish, null);
    case "content-filter":
      return terminalResult("refused", "failed", "refusal", rawFinish, null);
    case "error":
      return terminalResult("backend_error", "failed", "backend_error", rawFinish, null);
    case null:
      return unknownTerminal(null, null, null);
    default:
      return unknownTerminal(`unknown:${rawFinish}`, rawFinish, null);
  }
}
