import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkApprovalExpiresAt } from "../../src/backend/sdk-approval.ts";

const NOW = Date.parse("2026-10-26T00:00:00.000Z");

test("SDK 审批期限取配置期限与 run deadline 的较早者", () => {
  const deadline = new Date(NOW + 15_000).toISOString();
  assert.equal(sdkApprovalExpiresAt(deadline, 300_000, NOW), deadline);
  assert.equal(
    sdkApprovalExpiresAt(new Date(NOW + 600_000).toISOString(), 20_000, NOW),
    new Date(NOW + 20_000).toISOString(),
  );
});

test("SDK 审批期限绝不落到过去或非法时间", () => {
  const expiredDeadline = new Date(NOW - 1).toISOString();
  assert.equal(sdkApprovalExpiresAt(expiredDeadline, 300_000, NOW), new Date(NOW + 1).toISOString());
  assert.equal(sdkApprovalExpiresAt("not-a-date", 0, NOW), new Date(NOW + 1).toISOString());
});
