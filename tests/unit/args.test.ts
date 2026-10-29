import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertKnownFlags,
  optionalInt,
  parseArgs,
  requireString,
  UsageError,
} from "../../src/cli/args.ts";

test("解析位置参数与取值参数", () => {
  const parsed = parseArgs(["fake", "run", "--scenario", "happy-path", "--timeout=1000", "--json"]);
  assert.deepEqual(parsed.positional, ["fake", "run"]);
  assert.equal(parsed.flags["scenario"], "happy-path");
  assert.equal(parsed.flags["timeout"], "1000");
  assert.equal(parsed.flags["json"], true);
});

test("未知参数：解析阶段就拒绝缺值写法", () => {
  assert.throws(() => parseArgs(["fake", "run", "--dry-run"]), UsageError);
  assert.throws(() => parseArgs(["-x"]), UsageError);
  assert.throws(() => parseArgs(["--json=1"]), UsageError);
});

test("命令白名单：未知参数一律报错", () => {
  assert.throws(() => assertKnownFlags({ bogus: "1" }, []), /未知参数 --bogus/);
  assert.throws(() => assertKnownFlags({ bogus: true }, ["scenario"]), /未知参数 --bogus/);
  assert.doesNotThrow(() => assertKnownFlags({ json: true, scenario: "x" }, ["scenario"]));
});

test("requireString / optionalInt 的错误路径", () => {
  assert.throws(() => requireString({}, "out"), /缺少必填参数 --out/);
  assert.throws(() => requireString({ out: true }, "out"), /缺少必填参数 --out/);
  assert.equal(requireString({ out: "/tmp/x" }, "out"), "/tmp/x");
  assert.throws(() => optionalInt({ n: "abc" }, "n"), /必须是整数/);
  assert.throws(() => optionalInt({ n: "-1" }, "n"), /必须是整数/);
  assert.equal(optionalInt({ n: "42" }, "n"), 42);
  assert.equal(optionalInt({}, "n"), undefined);
});
