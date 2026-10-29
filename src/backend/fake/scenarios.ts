/**
 * fake backend 的脚本化场景。
 *
 * 每个场景都是「虚拟时间线 + 确定性事件」，不读磁盘、不连网络、不调用真实模型。
 * 覆盖：进度、待批、失败、晚到终态、永不结束，
 * 另外补一个「静默无终态」（A19）用来防止把沉默当成功。
 *
 * stopReason 使用产品中立词汇（见 contracts/run.ts），不出现 OpenCode 的 finish 原值；
 * OpenCode 字面值到产品结果的映射由 core/backend-result.ts 单独验证。
 */
import type { ApprovalRequestKind } from "../../contracts/approval.ts";
import type { KnownStopReason } from "../../contracts/run.ts";
import type { QuestionSchema } from "../../contracts/input.ts";

export type FakeStep =
  | { readonly kind: "progress"; readonly atMs: number; readonly text: string }
  | { readonly kind: "message"; readonly atMs: number; readonly text: string; readonly final: boolean }
  | {
      readonly kind: "tool";
      readonly atMs: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly phase: "requested" | "started" | "completed" | "failed";
      readonly summary: string;
    }
  | {
      readonly kind: "approval";
      readonly atMs: number;
      readonly requestKind: ApprovalRequestKind;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly argumentsText: string;
      readonly targetPaths: readonly string[];
      readonly ttlMs: number;
    }
  | { readonly kind: "input"; readonly atMs: number; readonly schema: QuestionSchema }
  | { readonly kind: "fail"; readonly atMs: number; readonly code: string; readonly message: string }
  | {
      readonly kind: "terminal";
      readonly atMs: number;
      readonly outcome: "completed";
      readonly stopReason: KnownStopReason;
      readonly agentReported: string;
    }
  /** 从这时起不再有事件：要么被 stop，要么到 deadline 收敛。 */
  | { readonly kind: "hold"; readonly atMs: number };

export interface FakeScenario {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly FakeStep[];
  /**
   * 收到 stop 请求后是否立即停止。
   * false 用来模拟「停止请求已发出但后端还在推进」——晚到终态就靠它触发。
   */
  readonly obeyStop: boolean;
  /** 没有 stop 也没有终态时，到 deadline 的收敛结果。 */
  readonly atDeadline: "unknown" | "timed_out";
}

const approvalRequest = (
  toolName: string,
  toolCallId: string,
  argumentsText: string,
  targetPaths: readonly string[],
  ttlMs = 5_000,
): FakeStep => ({
  kind: "approval",
  atMs: 200,
  requestKind: "tool_permission",
  toolName,
  toolCallId,
  argumentsText,
  targetPaths,
  ttlMs,
});

export const FAKE_SCENARIOS: Readonly<Record<string, FakeScenario>> = Object.freeze({
  "happy-path": {
    name: "happy-path",
    description: "进度 → 消息 → 工具 → 正常结束（turn_complete）",
    obeyStop: true,
    atDeadline: "unknown",
    steps: [
      { kind: "progress", atMs: 100, text: "读取工作区结构" },
      { kind: "message", atMs: 200, text: "先看目录，再给结论。", final: false },
      { kind: "tool", atMs: 300, toolCallId: "tc-1", toolName: "Read", phase: "completed", summary: "package.json" },
      { kind: "progress", atMs: 400, text: "整理结论" },
      { kind: "terminal", atMs: 500, outcome: "completed", stopReason: "turn_complete", agentReported: "已读取 1 个文件，未做修改。" },
    ],
  },

  "approval-gated": {
    name: "approval-gated",
    description: "一次待批（待批结果由 sink 决定，可测批准/拒绝/超时三种分支）",
    obeyStop: true,
    atDeadline: "unknown",
    steps: [
      approvalRequest("Bash", "tc-approve", "git status --short", ["."]),
      { kind: "progress", atMs: 400, text: "继续执行已批准的操作" },
      { kind: "terminal", atMs: 600, outcome: "completed", stopReason: "turn_complete", agentReported: "批准后完成。" },
    ],
  },

  "backend-failure": {
    name: "backend-failure",
    description: "后端返回错误，不给终态 → failed",
    obeyStop: true,
    atDeadline: "unknown",
    steps: [
      { kind: "progress", atMs: 100, text: "启动后端" },
      { kind: "fail", atMs: 250, code: "BACKEND_UNAVAILABLE", message: "fake: 后端进程退出" },
    ],
  },

  "late-terminal": {
    name: "late-terminal",
    description: "stop 请求已发出，后端仍继续推进并送来 completed（A05 的关键场景）",
    obeyStop: false,
    atDeadline: "unknown",
    steps: [
      { kind: "progress", atMs: 100, text: "长任务开始" },
      { kind: "progress", atMs: 300, text: "已收到停止请求，但仍在写" },
      { kind: "terminal", atMs: 600, outcome: "completed", stopReason: "turn_complete", agentReported: "我完成了。" },
    ],
  },

  "never-ending": {
    name: "never-ending",
    description: "持续产生进度，没有终态；只能靠 stop 有界收敛",
    obeyStop: true,
    atDeadline: "timed_out",
    steps: [
      { kind: "progress", atMs: 100, text: "循环 1" },
      { kind: "progress", atMs: 200, text: "循环 2" },
      { kind: "progress", atMs: 300, text: "循环 3" },
      { kind: "hold", atMs: 400 },
    ],
  },

  silent: {
    name: "silent",
    description: "完全没有事件也没有终态：超时收敛为 unknown，不能标 completed（A19）",
    obeyStop: true,
    atDeadline: "unknown",
    steps: [{ kind: "hold", atMs: 0 }],
  },

  "input-required": {
    name: "input-required",
    description: "后端发起事实输入请求；v0.1 无 agent_answer，按 INPUT_REQUIRED_UNSUPPORTED 有界停止",
    obeyStop: true,
    atDeadline: "unknown",
    steps: [
      {
        kind: "input",
        atMs: 150,
        schema: {
          kind: "single_choice",
          question: "要继续读哪个目录？",
          options: [
            { value: "src", label: "src" },
            { value: "docs", label: "docs" },
          ],
        },
      },
      { kind: "terminal", atMs: 500, outcome: "completed", stopReason: "aborted", agentReported: "等待输入超时。" },
    ],
  },
});

export function getScenario(name: string): FakeScenario {
  const scenario = FAKE_SCENARIOS[name];
  if (!scenario) {
    throw new RangeError(`未知的 fake 场景 ${name}；可用：${Object.keys(FAKE_SCENARIOS).join(", ")}`);
  }
  return scenario;
}

export function scenarioNames(): readonly string[] {
  return Object.keys(FAKE_SCENARIOS).sort();
}
