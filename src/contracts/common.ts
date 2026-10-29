/**
 * 调用主体与请求上下文。
 *
 * 铁律（技术规格 §1）：principal 只能由服务端在传输层解析，**不能**从工具 JSON 的
 * userId / principalId 之类字段取得。MCP 参数里出现这类字段一律按未知字段拒绝。
 */
import { ZBridgeError } from "./errors.ts";
import type { PrincipalId, WorkspaceId } from "./ids.ts";

/** RFC3339 / ISO8601 UTC 毫秒时间戳，例如 2026-10-21T02:56:08.123Z。 */
export type IsoTimestamp = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === "string" && ISO_RE.test(value);
}

export function assertIsoTimestamp(value: unknown, field: string): IsoTimestamp {
  if (!isIsoTimestamp(value)) {
    throw new ZBridgeError("INVALID_ARGUMENT", `${field} 必须是 ISO8601 UTC 毫秒时间戳`, {
      details: { field },
    });
  }
  return value;
}

/** 调用来源。operator 通道与普通执行通道分开，不能只靠 socket 文件名区分。 */
export type CallerSource = "mcp-stdio" | "mcp-http" | "operator-cli" | "local-cli";

export type PrincipalRole = "owner";

export interface Principal {
  readonly principalId: PrincipalId;
  /** v1 单用户，但仍需逐 workspace 校验。空数组表示默认无任何工作区权限。 */
  readonly allowedWorkspaces: readonly WorkspaceId[];
  readonly role: PrincipalRole;
}

export interface RequestContext {
  readonly principal: Principal;
  readonly source: CallerSource;
  readonly traceId: string;
  readonly receivedAt: IsoTimestamp;
}

/**
 * 资源归属校验。不属于当前主体的资源统一抛 NOT_FOUND，
 * 不区分「不存在」与「存在但无权」，避免用错误码做存在性探测。
 */
export function assertOwned(principal: Principal, ownerId: PrincipalId, resource: string): void {
  if (principal.principalId !== ownerId) {
    throw new ZBridgeError("NOT_FOUND", `${resource} 不存在`);
  }
}

export function assertWorkspaceAllowed(principal: Principal, workspaceId: WorkspaceId): void {
  if (!principal.allowedWorkspaces.includes(workspaceId)) {
    // 同样是 NOT_FOUND：未登记和无权访问对外不可区分。
    throw new ZBridgeError("NOT_FOUND", "workspace 不存在");
  }
}
