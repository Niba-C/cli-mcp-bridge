/**
 * 审批请求的处理（技术规格 §5、§8）。
 *
 * 本项只做「把后端权限请求转成产品审批，并把 once/reject 发回去」：
 * - **严格归属**：只接受「本会话 + tool.messageID 属于本 run 已归属的 assistant 消息
 *   + 有明确 callID」的请求。归属缺失就跳过（记一次警告），绝不对未知来源发许可；
 * - **期限**：等待操作者的时间不超过 `min(run deadline, approval deadline)`；
 *   超时返回 timeout 且**不再发送**任何回复，迟到的 allow 一律丢弃；
 * - 超时与通道丢失分开：timeout 是产品期限，channel_lost 不是用户拒绝；
 * - 同一 callID 被拒绝后再次出现，不再询问，直接 reject（复用已记录的拒绝）；
 * - 不实现 operator 通道、控制通道隔离或 always：只发 once/reject。
 */
import { ZBridgeError } from "../../contracts/errors.ts";
import type { ApprovalAnswer, BackendApprovalRequest, BackendEventSink } from "../../contracts/backend.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { OpenCodeApi } from "./client.ts";
import {
  approvalArgumentsText,
  approvalTargetPaths,
  classifyPermission,
  type RawPermissionRequest,
} from "./protocol.ts";

export interface ApprovalContext {
  readonly runId: RunId;
  readonly attemptId: string;
  readonly serverEpoch: number;
  /** 本 run 绑定的后端会话；全局 /permission 里其它会话的请求一律忽略。 */
  readonly sessionId: string;
  readonly deadlineMs: number;
  readonly approvalTimeoutMs: number;
  /** 该 messageID 是否属于本 run 的 assistant 消息。 */
  readonly ownsMessage: (messageId: string) => boolean;
}

export type ApprovalProcessing =
  | { readonly kind: "none" }
  | { readonly kind: "skipped"; readonly reason: string; readonly requestId: string | null }
  | { readonly kind: "allowed"; readonly requestId: string }
  | { readonly kind: "denied"; readonly requestId: string }
  | { readonly kind: "repeat_denied"; readonly requestId: string }
  | { readonly kind: "timeout"; readonly requestId: string }
  | { readonly kind: "channel_lost"; readonly requestId: string }
  | { readonly kind: "reply_failed"; readonly requestId: string; readonly detail: string };

const MAX_TRACKED = 256;

export class ApprovalCoordinator {
  private readonly handled = new Set<string>();
  private readonly deniedCalls = new Set<string>();
  private readonly warned = new Set<string>();

  get handledCount(): number {
    return this.handled.size;
  }

  private remember(requestId: string): void {
    this.handled.add(requestId);
    if (this.handled.size > MAX_TRACKED) {
      const oldest = this.handled.values().next();
      if (oldest.done !== true) this.handled.delete(oldest.value);
    }
  }

  /**
   * 只有「本会话 + 本 run 的消息 + 明确 callID」才进入审批。
   * 任何一项缺失都不处理，绝不用 `unknown-<id>` 伪造关联。
   */
  private ownedBy(
    request: RawPermissionRequest,
    context: ApprovalContext,
  ): { ok: true } | { ok: false; reason: string } {
    if (request.sessionId !== context.sessionId) return { ok: false, reason: "foreign_session" };
    if (request.toolMessageId === null) return { ok: false, reason: "missing_tool_message" };
    if (!context.ownsMessage(request.toolMessageId)) return { ok: false, reason: "unattributed_message" };
    if (request.toolCallId === null || request.toolCallId.length === 0) return { ok: false, reason: "missing_call_id" };
    return { ok: true };
  }

  /**
   * 处理至多一个待批请求。返回 `none` 表示没有属于本 run 的请求。
   */
  async process(
    requests: readonly RawPermissionRequest[],
    context: ApprovalContext,
    api: OpenCodeApi,
    sink: BackendEventSink,
    now: () => number,
  ): Promise<ApprovalProcessing> {
    for (const request of requests) {
      if (this.handled.has(request.id)) continue;
      const owner = this.ownedBy(request, context);
      if (!owner.ok) {
        if (!this.warned.has(request.id)) {
          this.warned.add(request.id);
          sink.emit({
            type: "warning",
            code: "APPROVAL_UNATTRIBUTED",
            message: `忽略归属不明的权限请求（${owner.reason}）`,
          });
        }
        continue;
      }
      return this.decideOne(request, context, api, sink, now);
    }
    return { kind: "none" };
  }

  private async decideOne(
    request: RawPermissionRequest,
    context: ApprovalContext,
    api: OpenCodeApi,
    sink: BackendEventSink,
    now: () => number,
  ): Promise<ApprovalProcessing> {
    this.remember(request.id);
    const callId = request.toolCallId as string;
    const remainingUntilDeadline = Math.min(context.deadlineMs, now() + context.approvalTimeoutMs) - now();
    if (remainingUntilDeadline <= 0) return { kind: "timeout", requestId: request.id };

    // 同一 callID 已被拒绝：复用拒绝，不再打扰操作者，也不放行。
    if (this.deniedCalls.has(callId)) {
      const sent = await api.replyPermission(request.id, "reject");
      return sent.ok
        ? { kind: "repeat_denied", requestId: request.id }
        : { kind: "reply_failed", requestId: request.id, detail: sent.message };
    }

    const expiresAtMs = Math.min(now() + context.approvalTimeoutMs, context.deadlineMs);
    const approvalRequest: BackendApprovalRequest = {
      requestKind: classifyPermission(request.permission),
      toolName: request.permission,
      toolCallId: callId,
      attemptId: context.attemptId,
      serverEpoch: context.serverEpoch,
      backendRequestId: request.id,
      argumentsText: approvalArgumentsText(request),
      targetPaths: approvalTargetPaths(request),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    sink.emit({ type: "approval_requested", request: approvalRequest });

    let answer: ApprovalAnswer | "expired";
    try {
      answer = await raceWithDeadline(sink.requestApproval(approvalRequest), remainingUntilDeadline);
    } catch (error) {
      // 本地决策通道异常：不是用户拒绝，也不能放行。
      sink.emit({
        type: "warning",
        code: "APPROVAL_CHANNEL_LOST",
        message: error instanceof ZBridgeError ? error.code : "审批通道异常",
      });
      return { kind: "channel_lost", requestId: request.id };
    }
    if (answer === "expired") {
      sink.emit({ type: "warning", code: "APPROVAL_EXPIRED", message: "审批等待超过期限，未发送任何回复" });
      return { kind: "timeout", requestId: request.id };
    }
    if (answer.decision === "timeout") return { kind: "timeout", requestId: request.id };
    if (answer.decision === "channel_lost") return { kind: "channel_lost", requestId: request.id };

    // 迟到的许可不可复用：决策返回时已经超过期限，就不发给后端。
    if (now() > expiresAtMs) {
      sink.emit({ type: "warning", code: "APPROVAL_EXPIRED", message: "迟到的审批结果已丢弃" });
      return { kind: "timeout", requestId: request.id };
    }

    const reply = answer.decision === "allow_once" ? "once" : "reject";
    if (reply === "reject") this.deniedCalls.add(callId);
    const sent = await api.replyPermission(request.id, reply);
    if (!sent.ok) {
      return { kind: "reply_failed", requestId: request.id, detail: `${sent.kind}: ${sent.message}` };
    }
    return reply === "once"
      ? { kind: "allowed", requestId: request.id }
      : { kind: "denied", requestId: request.id };
  }
}

/**
 * 有界等待：超过期限就返回 "expired"。
 *
 * 刻意不取消底层 Promise（取消会诱使调用方去伪造结论），只是不再采纳它的结果；
 * 同时挂一个吞掉异常的处理器，避免迟到的 rejection 变成未处理异常。
 */
async function raceWithDeadline(
  promise: Promise<ApprovalAnswer>,
  timeoutMs: number,
): Promise<ApprovalAnswer | "expired"> {
  promise.catch(() => undefined);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
