import assert from "node:assert/strict";
import { test } from "node:test";
import { countCodePoints, sliceByCodePoints } from "../../src/contracts/paging.ts";

const TEXT = "a😀中文𝄞b"; // 含代理对（😀、𝄞）与中日韩字符

test("offset 单位是 Unicode code point", () => {
  assert.equal(countCodePoints(TEXT), 6);
  assert.equal(Array.from(TEXT).length, 6);
  // 若按 UTF-16 单元切，会把 😀 切成半个代理对。
  assert.equal(TEXT.length, 8);
});

test("逐 code point 分页无损坏、无重复、无遗漏", () => {
  const collected: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = sliceByCodePoints(TEXT, offset, 2);
    collected.push(page.text);
    assert.equal(page.unit, "code_point");
    assert.equal(page.totalLength, 6);
    offset = page.nextOffset;
    if (!page.hasMore) break;
  }
  assert.equal(collected.join(""), TEXT);
});

test("越界 offset 收敛到末尾而不是抛错", () => {
  const page = sliceByCodePoints("abc", 99, 10);
  assert.equal(page.text, "");
  assert.equal(page.nextOffset, 3);
  assert.equal(page.hasMore, false);
});

test("非法参数直接拒绝", () => {
  assert.throws(() => sliceByCodePoints("abc", -1, 10), RangeError);
  assert.throws(() => sliceByCodePoints("abc", 0, 0), RangeError);
  assert.throws(() => sliceByCodePoints("abc", 1.5, 10), RangeError);
});
