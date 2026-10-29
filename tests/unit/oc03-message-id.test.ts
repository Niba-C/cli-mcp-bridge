import assert from "node:assert/strict";
import { test } from "node:test";
import { newUserMessageId } from "../../src/backend/opencode/protocol.ts";

test("消息ID与真实样本的时间编码和固定长度兼容", () => {
  const id = newUserMessageId(1792737639675, "abcdef0123456789");
  assert.equal(id.slice(4, 16), "1677d7cfb001");
  assert.equal(id.length, 30);
  assert.match(id, /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
});

test("同毫秒或时钟回退时消息ID仍递增且不重复", () => {
  const first = newUserMessageId(1792737639676, "ffffffffffffff");
  const second = newUserMessageId(1792737639676, "00000000000000");
  const third = newUserMessageId(1792737639670, "00000000000000");
  assert.ok(first < second);
  assert.ok(second < third);
});
