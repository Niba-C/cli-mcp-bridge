/**
 * CodeBuddy SDK 消息 → 产品词汇的纯映射（OC-09-03）。
 *
 * 只做纯函数：不 IO、不进程、不 SDK import（输入就是解构后的普通对象），
 * 保证可被单元测试直接覆盖。判定规则与 core/backend-result.ts 的证据
 * 优先级一致：结构化 result 消息是唯一终态来源；CLI 退出码、流结束、
 * 纯文本到达都不算成功。
 */
import type { StopReason } from "../../contracts/run.ts";

/** review 硬拒绝的内置工具（B15：硬拒绝优先于审批，operator 也放不开）。 */
export const CODEBUDDY_REVIEW_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
];

/** SDK result.subtype → 产品终态。 */
export interface CbOutcomeInput {
  readonly subtype: string | null;
  readonly isError: boolean;
  readonly errors: readonly string[];
  /** 是否真的收到了结构化 result 消息；false 表示进程/流结束而无终态。 */
  readonly resultObserved: boolean;
}

export interface CbOutcome {
  readonly kind: "completed" | "failed" | "unknown";
  readonly stopReason: StopReason | null;
  readonly errorCode: string | null;
}

export function mapCbOutcome(input: CbOutcomeInput): CbOutcome {
  if (!input.resultObserved) {
    // 没有结构终态：无论退出码是什么都不能宣称成功（OC-06 实测教训）。
    return { kind: "unknown", stopReason: null, errorCode: "no_structured_result" };
  }
  if (input.subtype === "success" && !input.isError) {
    return { kind: "completed", stopReason: "turn_complete", errorCode: null };
  }
  if (input.subtype === "error_max_turns") {
    return { kind: "failed", stopReason: "output_limit", errorCode: "error_max_turns" };
  }
  if (input.subtype === "error_max_budget_usd") {
    return { kind: "failed", stopReason: "backend_error", errorCode: "error_max_budget_usd" };
  }
  if (input.subtype === "error_during_execution") {
    return { kind: "failed", stopReason: "backend_error", errorCode: "error_during_execution" };
  }
  // 有 result 消息但 subtype 未知：保守按失败处理，保留原值。
  return { kind: "failed", stopReason: "backend_error", errorCode: input.subtype ?? "result_with_unknown_subtype" };
}

/** assistant 消息里的模型身份（observedModel 证据；仅本轮消息，不用配置回声）。 */
export function observedModelFromAssistant(message: { model?: unknown } | null | undefined): string | null {
  const model = message?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

/** 文本块拼接（有界）：assistant content 里 type=text 的部分。 */
export function assistantText(content: readonly unknown[]): string {
  let out = "";
  for (const block of content) {
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") {
        out += record["text"];
      }
    }
    if (out.length > 60_000) return `${out.slice(0, 60_000)}…[truncated]`;
  }
  return out;
}

/** 工具调用摘要（脱敏有界）。 */
export function toolSummary(toolName: string, input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  return `${toolName} ${text.slice(0, 200)}`;
}

/** review 硬拒绝判定：审批回调先过这层，deny 不给 operator 放行的机会。 */
export function isReviewHardDenied(toolName: string): boolean {
  return CODEBUDDY_REVIEW_DISALLOWED_TOOLS.includes(toolName);
}
