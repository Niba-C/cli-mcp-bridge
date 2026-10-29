/**
 * 单个 run 的 SSE 消费（技术规格 §6）。
 *
 * 只做「观察与累积」，不做状态判定：事件流本身永远不能证明完成。
 * - 未知事件只计数并保留最多几条类型名（有界），不猜语义；
 * - 重复 frame 按 event id 去重（重连可能重放）；
 * - 断连只记录原因，是否收敛由主循环结合消息快照决定；
 * - 只把本 run assistant 的 text part 交给 TextTracker，推理文本不进入正文。
 */
import { SseDecoder, SseEventDeduper, type SseFrame } from "./sse.ts";
import type { OpenCodeApi } from "./client.ts";
import type { SessionStatusKind } from "./protocol.ts";
import type { TextTracker } from "./text-tracker.ts";

/** 已知但不参与业务判定的事件：只用于避免把正常噪音算成「未知」。 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "server.connected",
  "server.heartbeat",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.idle",
  "session.status",
  "session.error",
  "session.diff",
  "session.compacted",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "file.edited",
  "file.watcher.updated",
  "lsp.updated",
  "lsp.diagnostics",
  "installation.updated",
  "todo.updated",
]);

/** 从 payload 里取事件 ID；没有就返回 null（无法去重，交给状态收敛）。 */
function payloadEventId(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const id = (parsed as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface EventStreamStats {
  readonly frames: number;
  readonly unknownEvents: number;
  readonly duplicateEvents: number;
  readonly parseErrors: number;
  readonly overflowedChars: number;
  readonly closed: boolean;
  /** 是否由我们自己调用 abort() 关闭；用于区分「正常收尾」与「意外断开」。 */
  readonly intentional: boolean;
  readonly error: string | null;
  readonly unknownTypes: readonly string[];
}

export interface TurnEventStreamOptions {
  readonly api: OpenCodeApi;
  readonly sessionId: string;
  readonly tracker: TextTracker;
  readonly now: () => number;
  /** 是否属于本 run 的消息（用于只累积本 run 正文）。 */
  readonly ownsMessage: (messageId: string) => boolean;
}

export class TurnEventStream {
  private readonly options: TurnEventStreamOptions;
  private readonly decoder = new SseDecoder();
  private readonly deduper = new SseEventDeduper();
  private readonly unknownTypes: string[] = [];
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private closed = false;
  private intentional = false;
  private error: string | null = null;
  private frames = 0;
  private unknownEvents = 0;
  private duplicateEvents = 0;
  private parseErrors = 0;
  private statusHint: SessionStatusKind = "absent";
  private permissionHint = false;
  private questionPending = false;
  private sessionError: string | null = null;

  constructor(options: TurnEventStreamOptions) {
    this.options = options;
  }

  get stats(): EventStreamStats {
    return {
      frames: this.frames,
      unknownEvents: this.unknownEvents,
      duplicateEvents: this.duplicateEvents,
      parseErrors: this.parseErrors,
      overflowedChars: this.decoder.droppedChars,
      closed: this.closed,
      intentional: this.intentional,
      error: this.error,
      unknownTypes: [...this.unknownTypes],
    };
  }

  get sessionStatus(): SessionStatusKind {
    return this.statusHint;
  }

  get hasPermissionHint(): boolean {
    return this.permissionHint;
  }

  /** 读取并清除「有新权限请求」的提示（避免每轮都重复触发一次额外查询）。 */
  consumePermissionHint(): boolean {
    const value = this.permissionHint;
    this.permissionHint = false;
    return value;
  }

  get hasQuestion(): boolean {
    return this.questionPending;
  }

  get errorName(): string | null {
    return this.sessionError;
  }

  /**
   * 建立流。失败只返回 false，由主循环继续用快照观察。
   * `connectTimeoutMs` 只约束「建连」阶段：超时就放弃 SSE，不会让 execute
   * 在发送之前无限等待。
   */
  async start(connectTimeoutMs = 5_000): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, Math.max(1, connectTimeoutMs));
    });
    try {
      const opened = await Promise.race([this.options.api.openEventStream(controller.signal), timedOut]);
      if (opened === null) {
        this.closed = true;
        this.error = `SSE 建连超时（${connectTimeoutMs}ms）`;
        return false;
      }
      if (!opened.ok) {
        this.closed = true;
        this.error = `SSE 未建立：${opened.message}`;
        return false;
      }
      this.task = this.consume(opened.body);
      return true;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  abort(): void {
    this.intentional = true;
    this.controller?.abort();
  }

  async waitClosed(): Promise<void> {
    if (this.task !== null) await this.task.catch(() => undefined);
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const decoded = this.decoder.push(value);
        this.apply(decoded.frames);
      }
      this.apply(this.decoder.end().frames);
    } catch (error) {
      if (!this.intentional) {
        const name = error !== null && typeof error === "object" ? (error as { name?: unknown }).name : null;
        this.error = name === "AbortError" ? "SSE 连接被中断" : "SSE 连接中断";
      }
    } finally {
      this.closed = true;
      try {
        reader.releaseLock();
      } catch {
        // reader 已经被取消时忽略。
      }
    }
  }

  private apply(frames: readonly SseFrame[]): void {
    for (const frame of frames) {
      this.frames += 1;
      if (frame.data.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        this.parseErrors += 1;
        continue;
      }
      // 去重键优先用 SSE 的 `id:` 字段；本机 1.18.32 的事件 ID 只在 payload 里，
      // 因此必须回落到 payload.id，否则重连重放的同一事件会被重复累加。
      const key = frame.id ?? payloadEventId(parsed);
      if (!this.deduper.accept(key)) {
        this.duplicateEvents += 1;
        continue;
      }
      this.handle(parsed);
    }
  }

  private handle(raw: unknown): void {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.parseErrors += 1;
      return;
    }
    const event = raw as Record<string, unknown>;
    const type = typeof event["type"] === "string" ? event["type"] : null;
    if (type === null) {
      this.parseErrors += 1;
      return;
    }
    if (!KNOWN_EVENT_TYPES.has(type)) {
      this.unknownEvents += 1;
      if (this.unknownTypes.length < 5) this.unknownTypes.push(type.slice(0, 64));
      return;
    }
    const properties = event["properties"] !== null && typeof event["properties"] === "object" && !Array.isArray(event["properties"])
      ? (event["properties"] as Record<string, unknown>)
      : {};
    const sessionId = typeof properties["sessionID"] === "string" ? properties["sessionID"] : null;
    const foreign = sessionId !== null && sessionId !== this.options.sessionId;

    switch (type) {
      case "session.status": {
        if (foreign) return;
        const status = properties["status"] !== null && typeof properties["status"] === "object"
          ? (properties["status"] as Record<string, unknown>)
          : {};
        const kind = status["type"];
        if (kind === "idle") this.statusHint = "idle";
        else if (kind === "busy") this.statusHint = "busy";
        else if (kind === "retry") this.statusHint = "retry";
        return;
      }
      case "session.idle": {
        // idle 只作提示：本机故障样本里状态表为空时旧工具仍在 running。
        if (!foreign) this.statusHint = "idle";
        return;
      }
      case "session.error": {
        if (foreign) return;
        const error = properties["error"];
        if (error !== null && typeof error === "object" && !Array.isArray(error)) {
          const name = (error as Record<string, unknown>)["name"];
          this.sessionError = typeof name === "string" ? name : "UnknownError";
        } else {
          this.sessionError = "UnknownError";
        }
        return;
      }
      case "message.part.updated": {
        const part = properties["part"];
        if (part === null || typeof part !== "object" || Array.isArray(part)) return;
        const record = part as Record<string, unknown>;
        const partSession = record["sessionID"];
        if (typeof partSession === "string" && partSession !== this.options.sessionId) return;
        const partId = record["id"];
        const messageId = record["messageID"];
        const partType = record["type"];
        if (typeof partId !== "string" || typeof messageId !== "string" || typeof partType !== "string") return;
        if (!this.options.ownsMessage(messageId)) {
          // 只记住类型，便于后续 delta 拒绝非本 run 文本；不累积内容。
          this.options.tracker.notePartType(partId, messageId, partType);
          return;
        }
        this.options.tracker.notePartType(partId, messageId, partType);
        if (partType === "text" && typeof record["text"] === "string") {
          this.options.tracker.upsertFromSnapshot(partId, messageId, partType, record["text"]);
        }
        return;
      }
      case "message.part.delta": {
        const partId = properties["partID"];
        const messageId = properties["messageID"];
        const field = properties["field"];
        const delta = properties["delta"];
        if (typeof partId !== "string" || typeof messageId !== "string") return;
        if (field !== "text" || typeof delta !== "string") return;
        if (typeof properties["sessionID"] === "string" && properties["sessionID"] !== this.options.sessionId) return;
        if (!this.options.ownsMessage(messageId)) return;
        this.options.tracker.applyDelta(partId, messageId, delta);
        return;
      }
      case "permission.asked": {
        if (!foreign) this.permissionHint = true;
        return;
      }
      case "question.asked": {
        if (!foreign) this.questionPending = true;
        return;
      }
      default:
        return;
    }
  }
}
