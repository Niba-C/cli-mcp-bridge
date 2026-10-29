import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonc } from "../../src/cli/manage.ts";

test("管理导入 JSONC：保留字符串里的 URL、注释符号与转义，只去掉外部注释和尾逗号", () => {
  const value = parseJsonc('\uFEFF{ // 注释\n "url": "https://example.test/v1", "text": "/*正文*/ \\\"quoted\\\" //正文", /* 块注释 */ "models": ["a",], }');
  assert.deepEqual(value, { url: "https://example.test/v1", text: '/*正文*/ "quoted" //正文', models: ["a"] });
});

test("管理导入错误不回显含凭据的 JSON 片段", () => {
  assert.throws(() => parseJsonc('{"apiKey":"fake-secret-must-not-be-printed", BAD}'), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /fake-secret|apiKey/);
    return true;
  });
  assert.throws(() => parseJsonc('{/* unterminated'), /注释未结束/);
});
