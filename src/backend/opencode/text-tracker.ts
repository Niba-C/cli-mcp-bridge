/**
 * 本 run 的 assistant 文本累积器。
 *
 * 两个来源必须合并而不重复：
 * - SSE `message.part.delta`：实时增量，但可能重复、乱序或断连丢失；
 * - 消息快照 `parts[].text`：权威全量，但只在轮询时可见。
 *
 * 规则：
 * - 只接受 type=text 的 part；reasoning 的 delta 一律不进正文（技术规格 §6「不泄漏推理」）；
 * - part 类型未知时保守丢弃，不猜成正文；
 * - 快照文本作为该 part 的最新全量：比累积值长就补齐，比累积值短则保留较长的（避免把已有内容抹掉）；
 * - `takePending()` 只交出「还没上报过」的后缀，因此重连或重复 delta 不会重复拼接。
 */

interface TrackedPart {
  readonly partId: string;
  messageId: string;
  type: string;
  text: string;
  emitted: number;
}

export class TextTracker {
  private readonly parts = new Map<string, TrackedPart>();
  private readonly order: string[] = [];
  private firstTextAtMs: number | null = null;
  private now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** 记录 part 类型（来自 message.part.updated）。 */
  notePartType(partId: string, messageId: string, type: string): void {
    const existing = this.parts.get(partId);
    if (existing === undefined) {
      this.parts.set(partId, { partId, messageId, type, text: "", emitted: 0 });
      this.order.push(partId);
      return;
    }
    existing.type = type;
  }

  /** 快照里的全量文本。 */
  upsertFromSnapshot(partId: string, messageId: string, type: string, text: string): void {
    let tracked = this.parts.get(partId);
    if (tracked === undefined) {
      this.notePartType(partId, messageId, type);
      tracked = this.parts.get(partId);
      if (tracked === undefined) return;
    }
    tracked.type = type;
    tracked.messageId = messageId;
    if (text.length >= tracked.text.length) {
      tracked.text = text;
      if (text.length > 0) this.markFirstText();
    }
  }

  /** SSE 增量：只对已确认是 text 的 part 生效。 */
  applyDelta(partId: string, messageId: string, delta: string): boolean {
    const tracked = this.parts.get(partId);
    if (tracked === undefined || tracked.type !== "text") return false;
    if (delta.length === 0) return true;
    tracked.text += delta;
    tracked.messageId = messageId;
    this.markFirstText();
    return true;
  }

  private markFirstText(): void {
    if (this.firstTextAtMs === null) this.firstTextAtMs = this.now();
  }

  get firstTextMs(): number | null {
    return this.firstTextAtMs;
  }

  /**
   * 取出尚未上报的文本（按 part 首次出现顺序）。
   * `messageFilter` 用来确保只拼接归属于本 run 的消息。
   */
  takePending(messageFilter: (messageId: string) => boolean): string {
    let out = "";
    for (const partId of this.order) {
      const tracked = this.parts.get(partId);
      if (tracked === undefined) continue;
      if (tracked.type !== "text") continue;
      if (!messageFilter(tracked.messageId)) continue;
      if (tracked.text.length <= tracked.emitted) continue;
      out += tracked.text.slice(tracked.emitted);
      tracked.emitted = tracked.text.length;
    }
    return out;
  }

  /** 已累积的正文（用于最终自述文本兜底）。 */
  assembled(messageFilter: (messageId: string) => boolean): string {
    const chunks: string[] = [];
    for (const partId of this.order) {
      const tracked = this.parts.get(partId);
      if (tracked === undefined || tracked.type !== "text") continue;
      if (!messageFilter(tracked.messageId)) continue;
      if (tracked.text.length > 0) chunks.push(tracked.text);
    }
    return chunks.join("\n");
  }
}
