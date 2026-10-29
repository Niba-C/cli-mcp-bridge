import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SSE_FRAME_CHARS, SseDecoder, SseEventDeduper, type SseFrame } from "../../src/backend/opencode/sse.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function frame(data: unknown, extra = ""): string {
  return `data: ${JSON.stringify(data)}\n${extra}\n`;
}

test("UTF-8 多字节字符被任意切分也能正确解码", () => {
  const payload = frame({ id: "evt_1", type: "message.part.delta", properties: { delta: "你好🌍" } });
  const buffer = bytes(payload);
  // 逐字节喂入：每个 UTF-8 多字节字符都会被切开。
  for (let index = 0; index < buffer.length; index += 1) {
    const decoder = new SseDecoder();
    const first = decoder.push(buffer.subarray(0, index));
    const second = decoder.push(buffer.subarray(index));
    const frames = [...first.frames, ...second.frames];
    if (frames.length === 0) continue;
    assert.equal(frames.length, 1, `切分点 ${index} 产生了多余帧`);
    assert.deepEqual(JSON.parse(frames[0]?.data ?? "null"), {
      id: "evt_1",
      type: "message.part.delta",
      properties: { delta: "你好🌍" },
    });
  }

  const decoder = new SseDecoder();
  const collected: SseFrame[] = [];
  for (const byte of buffer) collected.push(...decoder.push(new Uint8Array([byte])).frames);
  collected.push(...decoder.end().frames);
  assert.equal(collected.length, 1);
  assert.equal(JSON.parse(collected[0]?.data ?? "null").properties.delta, "你好🌍");
});

test("CRLF、单独 CR 与跨分片 CRLF 都按行边界处理", () => {
  const crlf = new SseDecoder();
  const frames = crlf.push(bytes("data: {\"a\":1}\r\n\r\n")).frames;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, '{"a":1}');

  // 单独 CR 结束时，末尾那个 CR 可能与后续 `\n` 组成 CRLF，因此必须等下一片（或 end）。
  const loneCr = new SseDecoder();
  assert.equal(loneCr.push(bytes("data: {\"a\":2}\r\r")).frames.length, 0);
  const closed = loneCr.end().frames;
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.data, '{"a":2}');

  // `\r` 落在分片末尾：不能立刻断行，要等 `\n`。
  const split = new SseDecoder();
  assert.equal(split.push(bytes('data: {"a":3}\r')).frames.length, 0);
  const rest = split.push(bytes("\n\r\n")).frames;
  assert.equal(rest.length, 1);
  assert.equal(rest[0]?.data, '{"a":3}');
});

test("多行 data 按规范用换行拼接，注释行不产生事件", () => {
  const decoder = new SseDecoder();
  const frames = decoder.push(
    bytes(': keep-alive\n' + 'event: message.part.delta\ndata: {"part":\ndata: "prt_1"}\n\n'),
  ).frames;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.event, "message.part.delta");
  assert.equal(frames[0]?.data, '{"part":\n"prt_1"}');
});

test("事件 ID 去重有界，缺失 ID 的事件不去重", () => {
  const deduper = new SseEventDeduper(3);
  assert.equal(deduper.accept("evt_1"), true);
  assert.equal(deduper.accept("evt_1"), false);
  assert.equal(deduper.accept(null), true);
  assert.equal(deduper.accept(null), true);
  for (let index = 0; index < 10; index += 1) deduper.accept(`evt_${index + 2}`);
  assert.ok(deduper.size <= 3);
});

test("超长残帧被丢弃并计数，不会无界增长", () => {
  const decoder = new SseDecoder();
  const chunk = new Uint8Array(64 * 1024).fill(65);
  let overflowed = 0;
  for (let index = 0; index < 40; index += 1) {
    const result = decoder.push(chunk);
    overflowed += result.overflowedChars;
  }
  assert.ok(overflowed > 0, "应当记录截断");
  assert.ok(decoder.droppedChars >= overflowed);
  // 仍然可以继续解析后续完整帧。
  const frames = decoder.push(bytes("\n\ndata: {\"ok\":true}\n\n")).frames;
  assert.equal(frames.some((item) => item.data.includes("\"ok\":true")), true);
});

test("end() 收尾未闭合的最后一行", () => {
  const decoder = new SseDecoder();
  assert.equal(decoder.push(bytes("data: {\"tail\":true}")).frames.length, 0);
  const frames = decoder.end().frames;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, '{"tail":true}');
});

test("缓冲区上限是常量而不是魔法数字", () => {
  assert.equal(typeof MAX_SSE_FRAME_CHARS, "number");
  assert.ok(MAX_SSE_FRAME_CHARS >= 64 * 1024);
});
