/** SDK 审批共用期限收敛。 */
export function sdkApprovalExpiresAt(deadlineAt: string, approvalTimeoutMs: number, now = Date.now()): string {
  const approvalExpiry = now + Math.max(1, approvalTimeoutMs);
  const runDeadline = Date.parse(deadlineAt);
  const expiry = Number.isFinite(runDeadline) ? Math.min(approvalExpiry, runDeadline) : approvalExpiry;
  return new Date(Math.max(now + 1, expiry)).toISOString();
}
