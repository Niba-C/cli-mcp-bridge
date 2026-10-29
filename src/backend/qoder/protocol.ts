/**
 * Qoder 受管 worker 与 daemon 之间的 stdio JSON 行协议（OC-09-04）。
 *
 * 与 codebuddy/protocol.ts 的差异是刻意的（两后端方言独立）：
 * - run 命令携带 authFile（credential-file 模式：worker 读取并经官方
 *   accessToken() API 传入，token 不经 daemon 进程间传输）；
 * - outcome 附带 stopReason 原值与 modelUsageKeys（观测证据）；
 * - interrupt_ack 报告 SDK 的排队消息 UUID 回执（停止证据）。
 */
export type QoderWorkerCommand =
  | { readonly kind: "run"; readonly runId: string; readonly prompt: string; readonly model: string; readonly deadlineAt: string; readonly attemptId: string; readonly resume: string | null; readonly authFile: string | null }
  | { readonly kind: "interrupt"; readonly runId: string }
  | { readonly kind: "cancel"; readonly runId: string }
  | { readonly kind: "approval_decision"; readonly approvalId: string; readonly decision: "allow_once" | "deny" | "timeout" | "channel_lost" }
  | { readonly kind: "shutdown" };

export type QoderWorkerReport =
  | {
      readonly kind: "ready";
      readonly workerProtocol: 1;
      readonly sdkVersion: string | null;
      readonly cliVersionObserved: string | null;
    }
  | {
      readonly kind: "session";
      readonly backendSessionId: string;
      readonly cliVersion: string | null;
      readonly protocolVersion: string | null;
      readonly modelReported: string | null;
      readonly toolsCount: number | null;
    }
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
  | { readonly kind: "owned_pids"; readonly pids: readonly number[]; readonly note?: string }
  | { readonly kind: "observed_model"; readonly runId: string; readonly model: string }
  | { readonly kind: "interrupt_ack"; readonly runId: string; readonly queuedMessageUuids: readonly string[] }
  | {
      readonly kind: "outcome";
      readonly runId: string;
      readonly subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "unknown";
      readonly isError: boolean;
      readonly resultText: string | null;
      readonly errors: readonly string[];
      readonly stopReason: string | null;
      readonly terminalReason: string | null;
      readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null } | null;
      readonly modelUsageKeys: readonly string[];
      readonly numTurns: number | null;
      /** 产品层有界停止的确定性错误码（如 INPUT_REQUIRED_UNSUPPORTED）。 */
      readonly failureCode?: string;
      readonly failureMessage?: string;
    }
  | { readonly kind: "worker_error"; readonly message: string; readonly fatal: boolean };

export function encodeQoderReport(report: QoderWorkerReport): string {
  return JSON.stringify(report);
}

export function decodeQoderReport(line: string): QoderWorkerReport | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value["kind"] !== "string") return null;
    return value as unknown as QoderWorkerReport;
  } catch {
    return null;
  }
}
