/**
 * 事实输入请求（后端 AskUserQuestion 一类）。
 *
 * 它**不是**授权：ExitPlanMode / permission / 扩权请求即使长得像表单，也必须走可信审批。
 * 答案表达能力受 schema 限制：不能表示的值要返回 INPUT_ANSWER_UNREPRESENTABLE，
 * 不许把自由文本硬塞进单选项（技术规格 §5「交互分类与答案表达」）。
 */
import type { InputRequestId, RunId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";

export const QUESTION_KINDS = ["single_choice", "multi_choice", "text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionSchema {
  readonly kind: QuestionKind;
  readonly question: string;
  /** single_choice / multi_choice 必填；text 必须为空。 */
  readonly options: readonly QuestionOption[];
  readonly minSelections?: number;
  readonly maxSelections?: number;
}

export const INPUT_STATES = ["pending", "answered", "expired", "cancelled"] as const;
export type InputState = (typeof INPUT_STATES)[number];

export interface InputAnswer {
  readonly kind: QuestionKind;
  readonly selections: readonly string[];
  readonly text: string | null;
}

export interface InputRequest {
  readonly inputRequestId: InputRequestId;
  readonly runId: RunId;
  readonly attemptId: string;
  readonly question: QuestionSchema;
  readonly state: InputState;
  readonly answer: InputAnswer | null;
  readonly expiresAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly revision: number;
}

/** 校验答案是否真的能由 schema 表达；不通过就拒绝，不做有损映射。 */
export function isAnswerRepresentable(schema: QuestionSchema, answer: InputAnswer): boolean {
  if (schema.kind === "text") {
    return answer.kind === "text" && answer.text !== null && answer.selections.length === 0;
  }
  if (answer.kind !== schema.kind || answer.text !== null) return false;
  const allowed = new Set(schema.options.map((option) => option.value));
  if (answer.selections.some((value) => !allowed.has(value))) return false;
  const min = schema.minSelections ?? 1;
  const max = schema.maxSelections ?? (schema.kind === "single_choice" ? 1 : schema.options.length);
  return answer.selections.length >= min && answer.selections.length <= max;
}
