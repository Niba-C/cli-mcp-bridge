/**
 * Qoder SDK 消息 → 产品词汇的纯映射（OC-09-04）。
 *
 * 与 CodeBuddy 的方言差异（不照抄）：
 * - 认证显式传入（accessToken 私有文件，或 daemon 账号面复用浏览器登录）；
 * - 终态含 stop_reason/terminal_reason、modelUsage（本轮模型观测来源）；
 * - interrupt() 返回排队消息 UUID 回执（interrupt_receipt_v1），用于停止证据；
 * - 隔离经 CLI 官方 --config-dir（extraArgs 透传）而非环境变量。
 */
import type { StopReason } from "../../contracts/run.ts";

/** review 硬拒绝的内置工具（Qoder 原生工具名；与 CodeBuddy 清单独立维护）。 */
export const QODER_REVIEW_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
];

export interface QdOutcomeInput {
  readonly subtype: string | null;
  readonly isError: boolean;
  readonly errors: readonly string[];
  readonly resultObserved: boolean;
}

export interface QdOutcome {
  readonly kind: "completed" | "failed" | "unknown";
  readonly stopReason: StopReason | null;
  readonly errorCode: string | null;
}

export function mapQdOutcome(input: QdOutcomeInput): QdOutcome {
  if (!input.resultObserved) {
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
  return { kind: "failed", stopReason: "backend_error", errorCode: input.subtype ?? "result_with_unknown_subtype" };
}

/**
 * 本轮实际模型身份：优先 assistant 消息的 model（SDKSystemInitMessage 的
 * model 是配置回声，不作为本轮推理身份）；modelUsage 键作为后备证据。
 */
export function observedModelFromAssistant(message: { model?: unknown } | null | undefined): string | null {
  const model = message?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

export function observedModelFromUsageKeys(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    // 一轮多个模型条目无法唯一定位推理身份：保留 unknown，不猜。
    return null;
  }
  return keys[0] ?? null;
}

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

export function toolSummary(toolName: string, input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  return `${toolName} ${text.slice(0, 200)}`;
}

export function isReviewHardDenied(toolName: string): boolean {
  return QODER_REVIEW_DISALLOWED_TOOLS.includes(toolName);
}
