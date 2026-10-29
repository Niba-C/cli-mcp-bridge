import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, CanonicalJsonError, payloadHash, sha256Hex, toJsonValue } from "../../src/contracts/json.ts";

test("对象键顺序不影响规范化结果与哈希", () => {
  const a = { z: 1, a: { y: true, b: [1, 2, 3] } };
  const b = { a: { b: [1, 2, 3], y: true }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(payloadHash(a), payloadHash(b));
  assert.equal(canonicalJson(a), '{"a":{"b":[1,2,3],"y":true},"z":1}');
});

test("数组顺序与字符串原样保留（不能重排命令参数）", () => {
  assert.notEqual(payloadHash(["a b", "c"]), payloadHash(["a", "b c"]));
  assert.equal(canonicalJson({ cmd: "  echo   'x'  " }), '{"cmd":"  echo   \'x\'  "}');
});

test("拒绝不能无损表示的类型", () => {
  assert.throws(() => canonicalJson({ at: new Date() }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ n: Number.NaN }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ big: 1n }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ fn: () => 1 }), CanonicalJsonError);
  assert.throws(() => canonicalJson({ missing: undefined }), CanonicalJsonError);
});

test("拒绝循环引用", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(() => canonicalJson(cyclic), /循环引用/);
});

test("sha256 与 payloadHash 前缀稳定", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(payloadHash({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("toJsonValue 得到纯拷贝，后续修改不影响源对象", () => {
  const source = { nested: { list: [1, 2] } };
  const copy = toJsonValue(source) as { nested: { list: number[] } };
  copy.nested.list.push(3);
  assert.deepEqual(source.nested.list, [1, 2]);
});
