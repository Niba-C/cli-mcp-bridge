/**
 * CodeBuddy 受管 worker 与 daemon 之间的 stdio JSON 行协议（OC-09-03）。
 *
 * 分层：daemon 进程内的 CodeBuddyAdapter ↔（本协议）↔ 独占 worker 进程
 * （承载 @tencent-ai/agent-sdk）↔（SDK directExecute）↔ 本机 codebuddy CLI。
 *
 * 原则：
 * - worker 是唯一 import SDK 的产品代码；daemon 不直接依赖 SDK 类型；
 * - 每行一个 JSON 对象；未知 `kind` 忽略并回告警（协议前向兼容）；
 * - 发送证据、终态、observedModel 都以「结构化消息」为准，CLI 退出码与
 *   进程存活只是观察项，不充当成功判据。
 */

/** daemon → worker。 */
export type WorkerCommand =
  | { readonly kind: "run"; readonly runId: string; readonly prompt: string; readonly model: string; readonly deadlineAt: string; readonly attemptId: string; readonly resume: string | null; readonly sessionId: string | null }
  | { readonly kind: "interrupt"; readonly runId: string }
  | { readonly kind: "cancel"; readonly runId: string }
  | { readonly kind: "approval_decision"; readonly approvalId: string; readonly decision: "allow_once" | "deny" | "timeout" | "channel_lost" }
  | { readonly kind: "shutdown" };

/** worker → daemon。 */
export type WorkerReport =
  | {
      readonly kind: "ready";
      readonly workerProtocol: 1;
      readonly sdkVersion: string | null;
      readonly cliVersionObserved: string | null;
    }
  | {
      readonly kind: "session";
      readonly backendSessionId: string;
      /** init 消息里的版本；未观察到为 null。 */
      readonly cliVersion: string | null;
      readonly modelReported: string | null;
      readonly toolsCount: number | null;
    }
  /** 发送证据：SDK 用户消息 UUID（存在时）即受理证据的升级依据。 */
  | { readonly kind: "dispatch"; readonly runId: string; readonly messageId: string | null; readonly accepted: boolean }
  | {
      readonly kind: "event";
      readonly runId: string;
      readonly type: "progress" | "message" | "tool" | "stderr" | "warning";
      readonly text: string;
      readonly final?: boolean;
      readonly tool?: { readonly toolCallId: string; readonly toolName: string; readonly phase: "requested" | "started" | "completed" | "failed"; readonly summary: string };
    }
  | {
      readonly kind: "approval_requested";
      readonly runId: string;
      readonly approvalId: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly attemptId: string;
      readonly argumentsText: string;
      readonly targetPaths: readonly string[];
      readonly requestKind: "tool_permission";
    }
  | {
      readonly kind: "input_requested";
      readonly runId: string;
      readonly schema: {
        readonly kind: "text";
        readonly question: string;
        readonly options: readonly { readonly value: string; readonly label: string }[];
      };
    }
  /** worker 观察到的自身子进程（CLI 等）：daemon 记录归属并用于回收。 */
  | { readonly kind: "owned_pids"; readonly pids: readonly number[]; readonly note?: string }
  | { readonly kind: "observed_model"; readonly runId: string; readonly model: string }
  | {
      readonly kind: "outcome";
      readonly runId: string;
      readonly subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "aborted" | "unknown";
      readonly isError: boolean;
      readonly resultText: string | null;
      readonly errors: readonly string[];
      readonly stopReason: string | null;
      readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null } | null;
      readonly numTurns: number | null;
      /** 产品层有界停止的确定性错误码（如 INPUT_REQUIRED_UNSUPPORTED）。 */
      readonly failureCode?: string;
      readonly failureMessage?: string;
    }
  | { readonly kind: "worker_error"; readonly message: string; readonly fatal: boolean };

export function encodeWorkerReport(report: WorkerReport): string {
  return JSON.stringify(report);
}

export function decodeWorkerReport(line: string): WorkerReport | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value["kind"] !== "string") return null;
    return value as unknown as WorkerReport;
  } catch {
    return null;
  }
}

export function encodeWorkerCommand(command: WorkerCommand): string {
  return JSON.stringify(command);
}

export function decodeWorkerCommand(line: string): WorkerCommand | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value["kind"] !== "string") return null;
    return value as unknown as WorkerCommand;
  } catch {
    return null;
  }
}
