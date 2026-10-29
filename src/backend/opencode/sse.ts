/**
 * SSE 帧解码（技术规格 §6）。
 *
 * 必须处理的本机真实情况：
 * - UTF-8 多字节字符被网络分片切开：用流式 TextDecoder，不能对每个 chunk 单独解码；
 * - 行尾可能是 CRLF、单独 CR 或 LF；一个 `\r` 落在 chunk 末尾时要等下一片，不能提前断行；
 * - 一个 frame 可以有多行 `data:`，按规范用 `\n` 连接；
 * - 注释行（`:` 开头）与空字段要忽略；
 * - 未知事件类型不能猜成完成，解码层只负责原样交出；
 * - 缓冲区必须有界：超长 frame 被丢弃并计数，不能让内存无界增长。
 */

/** 单帧缓冲上限（字符）：远超本机实测事件大小，同时保证有界。 */
export const MAX_SSE_FRAME_CHARS = 1024 * 1024;

export interface SseFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
  /** 注释行（`: keep-alive` 一类），只作审计。 */
  readonly comment: string | null;
}

export interface SseDecodeResult {
  readonly frames: readonly SseFrame[];
  /** 本批被丢弃的超限字节数（>0 表示发生过截断）。 */
  readonly overflowedChars: number;
}

/**
 * 增量解码器。`push` 可以任意切分网络 chunk，`end` 收尾未闭合的最后一行。
 */
export class SseDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private lastId: string | null = null;
  private pendingComment: string | null = null;
  private overflowedChars = 0;

  push(chunk: Uint8Array): SseDecodeResult {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  end(): SseDecodeResult {
    this.buffer += this.decoder.decode();
    const frames: SseFrame[] = [];
    const result = this.drain(true);
    frames.push(...result.frames);
    if (this.buffer.length > 0) {
      // 最后一行没有换行：按规范也应作为一行处理。
      const line = this.buffer;
      this.buffer = "";
      const frame = this.consumeLine(line);
      if (frame !== null) frames.push(frame);
    }
    const flushed = this.dispatch();
    if (flushed !== null) frames.push(flushed);
    return { frames, overflowedChars: this.overflowedChars + result.overflowedChars };
  }

  get droppedChars(): number {
    return this.overflowedChars;
  }

  private drain(atEnd = false): SseDecodeResult {
    const frames: SseFrame[] = [];
    let overflowed = 0;
    for (;;) {
      const boundary = findLineBoundary(this.buffer, atEnd);
      if (boundary === null) break;
      const line = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const frame = this.consumeLine(line);
      if (frame !== null) frames.push(frame);
    }
    if (this.buffer.length > MAX_SSE_FRAME_CHARS) {
      // 超限：丢掉当前残帧，但保留已解析完整的字段，避免把半个 JSON 当成事件。
      overflowed += this.buffer.length;
      this.overflowedChars += this.buffer.length;
      this.buffer = "";
      this.dataLines = [];
      this.eventName = null;
    }
    return { frames, overflowedChars: overflowed };
  }

  private consumeLine(line: string): SseFrame | null {
    if (line.length === 0) return this.dispatch();
    if (line.startsWith(":")) {
      this.pendingComment = line.slice(1).trimStart();
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataLines.push(value);
        return null;
      case "event":
        this.eventName = value.length > 0 ? value : null;
        return null;
      case "id":
        this.lastId = value.length > 0 ? value : null;
        return null;
      default:
        // `retry:` 之类不参与业务语义，直接忽略。
        return null;
    }
  }

  private dispatch(): SseFrame | null {
    if (this.dataLines.length === 0 && this.eventName === null && this.pendingComment === null) return null;
    const frame: SseFrame = {
      id: this.lastId,
      event: this.eventName,
      data: this.dataLines.join("\n"),
      comment: this.pendingComment,
    };
    this.dataLines = [];
    this.eventName = null;
    this.pendingComment = null;
    return frame;
  }
}

interface LineBoundary {
  readonly index: number;
  readonly length: number;
}

/**
 * 找到下一个行边界。末尾的 `\r` 可能是 `\r\n` 的前半段：
 * 不在结尾时等下一片；在结尾（`atEnd`）时才当作单独 CR 处理。
 */
function findLineBoundary(buffer: string, atEnd: boolean): LineBoundary | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === "\n") return { index, length: 1 };
    if (char === "\r") {
      if (index + 1 < buffer.length) {
        return { index, length: buffer[index + 1] === "\n" ? 2 : 1 };
      }
      return atEnd ? { index, length: 1 } : null;
    }
  }
  return null;
}

/** 有界的事件 ID 去重：重连后服务端可能重放同一批 frame。 */
export class SseEventDeduper {
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = 4096) {
    this.capacity = capacity;
  }

  /** 没有 ID 的事件无法安全去重，一律当作新事件（由上层按状态收敛）。 */
  accept(id: string | null): boolean {
    if (id === null) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
