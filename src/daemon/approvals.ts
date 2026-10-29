/**
 * 本地 operator 审批队列（OC-04 §4，技术规格 §8）。
 *
 * 决策只能来自 operator 通道（daemon 决定调用方是谁，请求体里没有身份字段）。
 * 决定一次即消费（once/reject），并且绑定：approvalId、attemptId、serverEpoch、
 * toolCallId、payloadHash、期限与 workspace generation。改参、过期、断连、取消、
 * 换代/重启后旧审批一律不可复用；已终结 run 的迟到决定不能复活任何执行。
 */
import type { ApprovalAnswer, BackendApprovalRequest } from "../contracts/backend.ts";
import { ZBridgeError } from "../contracts/errors.ts";
import type { Approval, ApprovalDecision, Run } from "../contracts/index.ts";
import { isTerminalRunState } from "../contracts/run.ts";
import { isId, type ApprovalId, type RunId } from "../contracts/ids.ts";
import type { BridgeStore } from "../storage/index.ts";

interface Waiter {
  readonly resolvers: Array<(answer: ApprovalAnswer) => void>;
  readonly timer: NodeJS.Timeout;
}

export interface ApprovalListItem {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly serverEpoch: number;
  readonly requestKind: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly argumentsText: string;
  readonly targetPaths: readonly string[];
  readonly payloadHash: string;
  readonly expiresAt: string;
  readonly state: string;
  readonly waitlisted: boolean;
}

const ARGUMENTS_DISPLAY_LIMIT = 2_000;

export class DaemonApprovalQueue {
  private readonly store: BridgeStore;
  private readonly waiters = new Map<ApprovalId, Waiter>();
  private readonly byBackendRequest = new Map<string, ApprovalId>();
  private readonly backendRequestByApproval = new Map<ApprovalId, string>();

  constructor(store: BridgeStore) {
    this.store = store;
  }

  /** coordinator 的 onApprovalRecorded 回调入口：先于决策请求被调用。 */
  approvalRecorded(approval: Approval, request: BackendApprovalRequest): void {
    if (request.backendRequestId === undefined) return;
    this.byBackendRequest.set(request.backendRequestId, approval.approvalId);
    this.backendRequestByApproval.set(approval.approvalId, request.backendRequestId);
  }

  /** coordinator 的 onApproval 入口：挂起直到 operator 决定或到期。 */
  waitForDecision(request: BackendApprovalRequest): Promise<ApprovalAnswer> {
    const approvalId =
      request.backendRequestId === undefined ? undefined : this.byBackendRequest.get(request.backendRequestId);
    if (approvalId === undefined) {
      return Promise.resolve({ decision: "channel_lost", actor: "channel_lost" });
    }
    return this.wait(approvalId);
  }

  private wait(approvalId: ApprovalId): Promise<ApprovalAnswer> {
    const expiry = this.waiters.get(approvalId);
    if (expiry !== undefined) {
      // 理论上同一审批不会重复等待；万一出现，跟随同一次答案。
      return new Promise<ApprovalAnswer>((resolve) => {
        expiry.resolvers.push(resolve);
      });
    }
    const approval = this.store.approvals.get(approvalId);
    if (approval === null || approval.state !== "pending") {
      return Promise.resolve({ decision: "channel_lost", actor: "channel_lost" });
    }
    const remainingMs = Math.max(0, Date.parse(approval.summary.expiresAt) - Date.now());
    return new Promise<ApprovalAnswer>((resolve) => {
      const timer = setTimeout(() => {
        // 到期先落 expired，再给出与「用户拒绝」严格区分的 timeout 答案。
        try {
          this.store.expireApproval(approvalId, { actor: "product_expiry", state: "expired" });
        } catch {
          // 已被并行决策/清理：保持答案不变。
        }
        this.resolveWaiter(approvalId, { decision: "timeout", actor: "product_expiry" });
      }, remainingMs);
      this.waiters.set(approvalId, { resolvers: [resolve], timer });
    });
  }

  private resolveWaiter(approvalId: ApprovalId, answer: ApprovalAnswer): void {
    const waiter = this.waiters.get(approvalId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    const backendRequestId = this.backendRequestByApproval.get(approvalId);
    if (backendRequestId !== undefined && this.byBackendRequest.get(backendRequestId) === approvalId) {
      this.byBackendRequest.delete(backendRequestId);
    }
    this.backendRequestByApproval.delete(approvalId);
    for (const resolve of waiter.resolvers) resolve(answer);
  }

  /**
   * operator 决定一条待批。必须携带操作者在 approval.list 看到的上下文
   * （payloadHash／serverEpoch／attemptId），证明「参数没变、没换代、没换执行」。
   * 任何校验失败都会先把审批落为不可复用状态再抛错；绝不留下可用的 pending，
   * 落库失败时绝不返回 allow_once（决策由本方法单点落库）。
   */
  decide(input: {
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
    readonly payloadHash: string;
    readonly serverEpoch: number;
    readonly attemptId: string;
  }): Approval {
    if (!isId("approval", input.approvalId)) {
      throw new ZBridgeError("INVALID_ARGUMENT", "approvalId 形状非法");
    }
    const approval = this.store.approvals.get(input.approvalId);
    if (approval === null) {
      throw new ZBridgeError("NOT_FOUND", "审批不存在");
    }
    const summary = approval.summary;
    if (approval.state !== "pending") {
      const code = approval.state === "denied" || approval.state === "approved" ? "APPROVAL_DENIED" : "APPROVAL_EXPIRED";
      throw new ZBridgeError(code, "审批已不在 pending 状态，许可不可复用", { details: { state: approval.state } });
    }
    // 改参：操作者看到的 payloadHash 与当前审批不一致 → 拒绝并作废。
    if (summary.payloadHash !== input.payloadHash) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("APPROVAL_EXPIRED", "审批内容（payloadHash）与操作者所见不一致；改参后的请求不能复用旧许可");
    }
    // 换执行：attempt 不一致。
    if (summary.attemptId !== input.attemptId) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("APPROVAL_EXPIRED", "审批属于另一次执行（attemptId 不一致），不可复用");
    }
    // 换代：操作者视角或当前 worker 代际任一不一致。
    if (summary.serverEpoch !== input.serverEpoch) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("EPOCH_MISMATCH", "审批的 serverEpoch 与操作者所见不一致");
    }
    // 换代：审批绑定 worker 必须仍是持久化活动代际；多后端并发时不能拿全局“最后代际”误判。
    try {
      this.store.services.requireActiveServer(summary.serverEpoch);
    } catch {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("EPOCH_MISMATCH", "审批绑定的 worker 代际已失效，不能放行", {
        details: { approvalEpoch: summary.serverEpoch },
      });
    }

    // run 必须仍然活跃，且审批必须属于它当前这次 attempt；旧回调不能复活已终结 run。
    let run: Run;
    try {
      run = this.store.runs.require(summary.runId);
    } catch {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("APPROVAL_EXPIRED", "审批对应的 run 已不存在");
    }
    if (isTerminalRunState(run.state) || run.backendAttemptId !== summary.attemptId) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("APPROVAL_EXPIRED", "run 已终结或审批不属于当前执行；旧审批不能复活任何任务", {
        details: { runState: run.state },
      });
    }
    // workspace generation 变化后旧审批不可用。
    const workspace = this.store.workspaces.require(summary.workspaceId);
    const session = this.store.sessions.require(summary.sessionId);
    if (session.workspaceGeneration !== workspace.generation) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("POLICY_REVOKED", "workspace 已重新登记（generation 变化），旧审批不可复用", {
        details: { sessionGeneration: session.workspaceGeneration, workspaceGeneration: workspace.generation },
      });
    }
    // 有等待中的执行才可决定；等待者消失说明执行侧已经收敛（超时/断连/取消）。
    const waiter = this.waiters.get(input.approvalId);
    if (waiter === undefined) {
      this.expireQuietly(input.approvalId);
      throw new ZBridgeError("APPROVAL_EXPIRED", "该审批已没有等待中的执行，决定不会被应用");
    }

    // 单点落库：本方法是唯一把 pending → 决定写库的地方。
    // 落库失败（含已过期）时**绝不**把 allow_once 交给等待者。
    let updated: Approval;
    try {
      updated = this.store.recordLocalApprovalDecision(input.approvalId, input.decision);
    } catch (error) {
      this.resolveWaiter(input.approvalId, { decision: "channel_lost", actor: "channel_lost" });
      if (error instanceof ZBridgeError) throw error;
      throw new ZBridgeError("APPROVAL_EXPIRED", "审批落库失败，许可不会被应用");
    }
    this.resolveWaiter(input.approvalId, { decision: input.decision, actor: "operator" });
    return updated;
  }

  private expireQuietly(approvalId: ApprovalId): void {
    try {
      this.store.expireApproval(approvalId, { actor: "product_expiry", state: "expired" });
    } catch {
      // 已不在 pending。
    }
  }

  /** run 终结/取消时清空它的待批：resolve channel_lost，不复活。 */
  sweepRun(runId: RunId): void {
    for (const approval of this.store.listPendingApprovals(runId)) {
      try {
        this.store.expireApproval(approval.approvalId, { actor: "channel_lost", state: "cancelled" });
      } catch {
        // 已处理。
      }
      this.resolveWaiter(approval.approvalId, { decision: "channel_lost", actor: "channel_lost" });
    }
  }

  /** daemon 关停：所有待批按通道丢失处理，等待中的执行会按既有语义收敛。 */
  sweepAll(): void {
    for (const approval of this.store.listPendingApprovals()) {
      try {
        this.store.expireApproval(approval.approvalId, { actor: "channel_lost", state: "cancelled" });
      } catch {
        // 已处理。
      }
      this.resolveWaiter(approval.approvalId, { decision: "channel_lost", actor: "channel_lost" });
    }
  }

  list(): readonly ApprovalListItem[] {
    const pending = new Set(this.waiters.keys());
    return this.store.listPendingApprovals().map((approval) => ({
      approvalId: approval.approvalId,
      runId: approval.summary.runId,
      sessionId: approval.summary.sessionId,
      workspaceId: approval.summary.workspaceId,
      attemptId: approval.summary.attemptId,
      serverEpoch: approval.summary.serverEpoch,
      requestKind: approval.summary.requestKind,
      toolName: approval.summary.toolName,
      toolCallId: approval.summary.toolCallId,
      argumentsText:
        approval.summary.argumentsText.length > ARGUMENTS_DISPLAY_LIMIT
          ? `${approval.summary.argumentsText.slice(0, ARGUMENTS_DISPLAY_LIMIT)}…[truncated]`
          : approval.summary.argumentsText,
      targetPaths: approval.summary.targetPaths,
      payloadHash: approval.summary.payloadHash,
      expiresAt: approval.summary.expiresAt,
      state: approval.state,
      waitlisted: pending.has(approval.approvalId),
    }));
  }

  pendingCount(): number {
    return this.waiters.size;
  }
}
