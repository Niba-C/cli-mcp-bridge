/**
 * Run 状态机（技术规格 §3）。
 *
 * 状态机是纯函数：不做 IO、不看时间、不依赖数据库，因此可以被 fault 测试反复重放。
 * 两条容易被写错的规则在这里集中实现：
 * 1. 终态不可改写（A05：取消与完成同时到达，只保留先确认的那个）；
 * 2. stopping 之后到达的 completed 不是合法迁移 —— 停止请求已发出，就不能事后宣称成功。
 */
import {
  isTerminalRunState,
  type RunState,
  type TerminalRunState,
} from "../contracts/run.ts";

/** 允许的直接迁移。空数组表示终态。 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  queued: ["starting", "cancelled", "timed_out"],
  starting: ["running", "failed", "stopping", "unknown"],
  running: ["waiting_approval", "waiting_input", "stopping", "draining", "unknown"],
  waiting_approval: ["running", "stopping", "unknown"],
  waiting_input: ["running", "stopping", "unknown"],
  draining: ["completed", "failed", "stopping", "unknown"],
  stopping: ["cancelled", "interrupted", "timed_out", "failed", "unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  timed_out: [],
  unknown: [],
});

/** 直接迁移是否合法。 */
export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * 是否可达（允许多跳，但不得穿过终态）。
 * 例如 running → completed 要走 running → draining → completed，这是合法的证据链。
 */
export function canReach(from: RunState, to: RunState): boolean {
  if (from === to) return true;
  const queue: RunState[] = [from];
  const seen = new Set<RunState>([from]);
  while (queue.length > 0) {
    const current = queue.shift() as RunState;
    for (const next of RUN_TRANSITIONS[current]) {
      if (next === to) return true;
      if (isTerminalRunState(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

export type TransitionRejection = "terminal_immutable" | "illegal_transition";

export interface TransitionResult {
  readonly state: RunState;
  readonly accepted: boolean;
  readonly reason: TransitionRejection | null;
}

export interface PathResult extends TransitionResult {
  /** 被拒绝时停在哪个状态上（null 表示全部通过）。 */
  readonly rejectedAt: RunState | null;
  /** 实际走通的跳数（按顺序）。 */
  readonly applied: readonly RunState[];
}

/**
 * 归约**一次单跳**状态变化。
 *
 * 刻意不接受多跳：`running → completed` 必须由调用方显式走 `running → draining → completed`，
 * 否则「终态要有证据链」这条不变量就只是文档里的字。多跳用 reduceRunPath。
 */
export function reduceRunState(from: RunState, to: RunState): TransitionResult {
  if (from === to) return { state: from, accepted: true, reason: null };
  if (isTerminalRunState(from)) {
    return { state: from, accepted: false, reason: "terminal_immutable" };
  }
  if (canTransition(from, to)) return { state: to, accepted: true, reason: null };
  return { state: from, accepted: false, reason: "illegal_transition" };
}

/**
 * 按显式路径逐步归约。任何一跳非法就停在那里并返回原因，
 * 不会「跳过」中间状态，也不会把后面的跳继续应用。
 */
export function reduceRunPath(from: RunState, path: readonly RunState[]): PathResult {
  let state = from;
  const applied: RunState[] = [];
  for (const next of path) {
    const step = reduceRunState(state, next);
    if (!step.accepted) {
      return { state, accepted: false, reason: step.reason, rejectedAt: next, applied };
    }
    state = step.state;
    applied.push(next);
  }
  return { state, accepted: true, reason: null, rejectedAt: null, applied };
}

/**
 * 停止意图 + 后端中立 stopReason 的组合语义。
 * aborted 时，用户 cancel → cancelled，用户 interrupt → interrupted，期限 → timed_out；
 * output_limit / backend_error 是失败（结果不完整），不是成功。
 * 「已请求停止却收到 turn_complete」是互相矛盾的证据，取 unknown，不猜成功。
 */
export function terminalStateForStop(
  intent: "interrupt" | "cancel" | "close" | "deadline",
  stopReason: string | null,
): TerminalRunState {
  if (stopReason === "aborted") {
    switch (intent) {
      case "interrupt":
        return "interrupted";
      case "cancel":
      case "close":
        return "cancelled";
      case "deadline":
        return "timed_out";
    }
  }
  if (stopReason === "output_limit" || stopReason === "backend_error") return "failed";
  return "unknown";
}
