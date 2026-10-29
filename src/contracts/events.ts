/**
 * 业务事件与水位。
 *
 * v1 水位规则（技术规格 §6）：每个对外业务事件在同一事务里 seq/revision 各加一，
 * 二者从 1 开始保持数值相等。纯 debug/token 字节流不进业务事件——进度要先有界合并。
 */
import type { RunId } from "./ids.ts";
import type { IsoTimestamp } from "./common.ts";
import type { RunState } from "./run.ts";
import type { ContractVersion } from "./version.ts";

export const EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.progress",
  "run.tool",
  "run.approval_required",
  "run.approval_decided",
  "run.input_required",
  "run.draining",
  "run.stop_requested",
  "run.state",
  "run.terminal",
  "run.unknown",
  "run.warning",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface RunEvent {
  readonly runId: RunId;
  /** 单调递增，从 1 开始。 */
  readonly seq: number;
  /** v1 中与 seq 相等；保留独立字段以防将来解耦。 */
  readonly revision: number;
  readonly type: EventType;
  readonly at: IsoTimestamp;
  /** 有界载荷：单条上限由 limits.eventPayloadBytes 控制。 */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly state?: RunState;
}

export interface EventPage {
  readonly contractVersion: ContractVersion;
  readonly runId: RunId;
  readonly events: readonly RunEvent[];
  readonly nextSeq: number;
  readonly earliestSeq: number;
  readonly hasMore: boolean;
  /** 该页对应的快照水位，用于与 agent_get 对齐。 */
  readonly snapshotRevision: number;
}

/** 单条事件载荷的字符上限（技术规格 §8：总量 ≤10MiB、单条需可截断标记）。 */
export const EVENT_PAYLOAD_MAX_CHARS = 4096;

export function truncatePayload(text: string, max = EVENT_PAYLOAD_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/** seq 与 revision 必须同步推进，否则客户端的 wait/events 游标会错位。 */
export function assertWatermark(event: RunEvent): void {
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new RangeError("event.seq 必须是 ≥1 的整数");
  }
  if (event.revision !== event.seq) {
    throw new RangeError(`event.revision(${event.revision}) 必须等于 seq(${event.seq})`);
  }
}
