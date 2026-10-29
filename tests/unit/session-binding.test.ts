import assert from "node:assert/strict";
import { test } from "node:test";
import { bindBackendSession, recoveryVerificationFrom, UNVERIFIED_RECOVERY } from "../../src/contracts/session.ts";
import type { BackendSessionRef } from "../../src/contracts/backend.ts";

test("未绑定后端时两个字段都必须是 null", () => {
  assert.deepEqual(bindBackendSession(null, null), { ok: true, binding: null });
});

test("backendSessionId 与 serverEpoch 必须成对出现", () => {
  const bound = bindBackendSession("oc-session-1", 7);
  assert.deepEqual(bound, { ok: true, binding: { backendSessionId: "oc-session-1", serverEpoch: 7 } });

  const missingEpoch = bindBackendSession("oc-session-1", null);
  assert.equal(missingEpoch.ok, false);
  if (!missingEpoch.ok) assert.match(missingEpoch.reason, /缺少 serverEpoch/);

  const missingId = bindBackendSession(null, 7);
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.match(missingId.reason, /backendSessionId 为空/);
});

test("serverEpoch 必须是 ≥1 的整数，空白后端 ID 被拒绝", () => {
  for (const epoch of [0, -1, 1.5, Number.NaN]) {
    const result = bindBackendSession("oc-session-1", epoch);
    assert.equal(result.ok, false, `serverEpoch=${epoch} 应被拒绝`);
  }
  assert.equal(bindBackendSession("   ", 1).ok, false);
});

test("后端会话引用只携带 OpenCode ID 与服务代际，没有懒占位字段", () => {
  const ref: BackendSessionRef = { backendSessionId: "oc-session-2", serverEpoch: 3, backendVersion: "1.18.32" };
  assert.equal(ref.backendSessionId, "oc-session-2");
  assert.equal(ref.serverEpoch, 3);
  // @ts-expect-error 懒占位（materialization）已随 OC-01 移除，不能继续表达
  const legacy: BackendSessionRef = { ...ref, materialization: "placeholder" };
  assert.equal(legacy.serverEpoch, 3);
});

test("恢复等级只有拿到证据才能升级，默认 unverified", () => {
  assert.equal(UNVERIFIED_RECOVERY, "unverified");
  assert.equal(recoveryVerificationFrom(null), "unverified");
  assert.equal(recoveryVerificationFrom(undefined), "unverified");
  assert.equal(recoveryVerificationFrom("   "), "unverified");
  assert.equal(recoveryVerificationFrom("evidence:opencode/restart"), "verified");
});
