/**
 * 把 backend 的 TurnOutcome 落到产品 run 状态。
 *
 * 这一层是「状态机拒绝改写」真正生效的地方：CLI 与（将来的）daemon 都调它，
 * 而不是直接把 outcome.kind 抄成 run.state。两条规则在这里闭环：
 * 1. completed 必须经过 draining（证据链）；
 * 2. 停止请求之后才到的 completed 被拒绝，最终态按停止意图收敛（A05）。
 */
import { isTerminalRunState, type RunState, type TerminalRunState } from "../contracts/run.ts";
import {
  reduceRunPath,
  terminalStateForStop,
  type TransitionRejection,
} from "./run-machine.ts";

export type StopIntent = "interrupt" | "cancel" | "close" | "deadline";

export interface TurnOutcomeLike {
  readonly kind: TerminalRunState;
  readonly terminalObservedAfterStop: boolean;
}

export interface ApplyOutcomeOptions {
  /** 归约起点；默认 running（一次已 dispatch 的 turn）。 */
  readonly from?: RunState;
  /** 停止意图，只影响 cancelled 语义（interrupt → interrupted）。 */
  readonly stopIntent?: StopIntent;
}

export interface ApplyOutcomeResult {
  /** 归约后的状态；晚到终态被拒时是停止意图对应的终态，不是 completed。 */
  readonly state: RunState;
  /** 实际走过的状态路径，便于审计与测试断言。 */
  readonly path: readonly RunState[];
  readonly accepted: boolean;
  readonly rejected: TransitionRejection | null;
  readonly rejectedAt: RunState | null;
  /** 被拒绝的后端终态（通常只有晚到的 completed），保留供审计。 */
  readonly rejectedTerminal: TerminalRunState | null;
}

function pathFor(from: RunState, kind: TerminalRunState): readonly RunState[] {
  switch (kind) {
    case "completed":
      return from === "draining" ? ["completed"] : ["draining", "completed"];
    case "failed":
      // starting 允许直接 failed；running 必须先 draining 才能 failed。
      if (from === "starting" || from === "draining") return ["failed"];
      if (from === "queued") return ["starting", "failed"];
      return ["draining", "failed"];
    case "cancelled":
    case "interrupted":
    case "timed_out":
      return from === "stopping" ? [kind] : ["stopping", kind];
    case "unknown":
      return ["unknown"];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function applyTurnOutcome(
  outcome: TurnOutcomeLike,
  options: ApplyOutcomeOptions = {},
): ApplyOutcomeResult {
  const from: RunState = options.from ?? "running";
  const intent: StopIntent = options.stopIntent ?? "cancel";

  if (isTerminalRunState(from)) {
    return {
      state: from,
      path: [],
      accepted: false,
      rejected: "terminal_immutable",
      rejectedAt: outcome.kind,
      rejectedTerminal: outcome.kind === from ? null : outcome.kind,
    };
  }

  // 结果不明不能被「停止意图」改写成已确认的取消：unknown 必须保留并继续阻塞会话。
  // 这一条独立于 terminalObservedAfterStop —— 停止期间观察到 unknown，说明停止**没有**得到确认。
  if (outcome.kind === "unknown") {
    const reduced = reduceRunPath(from, pathFor(from, "unknown"));
    return {
      state: reduced.state,
      path: reduced.applied,
      accepted: reduced.accepted,
      rejected: reduced.reason,
      rejectedAt: reduced.rejectedAt,
      rejectedTerminal: null,
    };
  }

  // 停止请求之后才到的终态：后端说了不算，按停止意图收敛，并保留被拒终态供审计。
  if (outcome.terminalObservedAfterStop) {
    // 停止已经发生，产品原因是 aborted；不再拿后端自称的终态当成功证据。
    const finalState = terminalStateForStop(intent, "aborted");
    const reduced = reduceRunPath(from, pathFor(from, finalState));
    return {
      state: reduced.state,
      path: reduced.applied,
      accepted: reduced.accepted,
      rejected: reduced.accepted ? "terminal_immutable" : reduced.reason,
      rejectedAt: reduced.rejectedAt,
      rejectedTerminal: outcome.kind === finalState ? null : outcome.kind,
    };
  }

  const path = pathFor(from, outcome.kind);
  const reduced = reduceRunPath(from, path);
  return {
    state: reduced.state,
    path: reduced.applied,
    accepted: reduced.accepted,
    rejected: reduced.reason,
    rejectedAt: reduced.rejectedAt,
    rejectedTerminal: reduced.accepted ? null : outcome.kind,
  };
}
