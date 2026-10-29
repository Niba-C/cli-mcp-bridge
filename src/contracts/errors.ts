/**
 * 统一错误码（技术规格 §9）。
 *
 * 约束：
 * - 只能从这里定义的码里选，不允许各模块自定义字符串，否则 MCP 调用方无法稳定分支；
 * - retryable 由服务端显式给出，但**不能**因为 retryable=true 就自动重新 dispatch 写执行：
 *   unknown outcome 必须人工确认（技术规格 §4）；
 * - details 只允许非敏感、结构性信息，禁止堆栈、凭证、源码片段（由 sanitizeDetails 强制）。
 */
import type { JsonValue } from "./json.ts";
import { CONTRACT_VERSION, type ContractVersion } from "./version.ts";

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "WORKSPACE_NOT_ALLOWED",
  "PROFILE_NOT_ALLOWED",
  "SESSION_BUSY",
  "SESSION_CLOSED",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_EXPIRED",
  "EPOCH_MISMATCH",
  "REVISION_CONFLICT",
  "RESULT_NOT_READY",
  "CURSOR_EXPIRED",
  "ARTIFACT_EXPIRED",
  "RESOURCE_EXHAUSTED",
  "QUEUE_EXPIRED",
  "BACKEND_UNAVAILABLE",
  "BACKEND_PROTOCOL_MISMATCH",
  "STOP_UNCONFIRMED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "INPUT_REQUIRED_UNSUPPORTED",
  "INPUT_ANSWER_UNREPRESENTABLE",
  "POLICY_REVOKED",
  "DAEMON_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 默认 retryable。只有「同一个幂等 key 重发不会造成第二次写」的传输类错误为 true。
 * 注意 SESSION_BUSY=false：start 对繁忙会话不做隐式排队（技术规格 §6）。
 */
export const RETRYABLE_BY_DEFAULT: Readonly<Record<ErrorCode, boolean>> = Object.freeze({
  INVALID_ARGUMENT: false,
  UNAUTHORIZED: false,
  NOT_FOUND: false,
  WORKSPACE_NOT_ALLOWED: false,
  PROFILE_NOT_ALLOWED: false,
  SESSION_BUSY: false,
  SESSION_CLOSED: false,
  IDEMPOTENCY_CONFLICT: false,
  REQUEST_EXPIRED: false,
  EPOCH_MISMATCH: false,
  REVISION_CONFLICT: false,
  RESULT_NOT_READY: false,
  CURSOR_EXPIRED: false,
  ARTIFACT_EXPIRED: false,
  RESOURCE_EXHAUSTED: true,
  QUEUE_EXPIRED: false,
  BACKEND_UNAVAILABLE: true,
  BACKEND_PROTOCOL_MISMATCH: false,
  STOP_UNCONFIRMED: false,
  APPROVAL_REQUIRED: false,
  APPROVAL_DENIED: false,
  APPROVAL_EXPIRED: false,
  INPUT_REQUIRED_UNSUPPORTED: false,
  INPUT_ANSWER_UNREPRESENTABLE: false,
  POLICY_REVOKED: false,
  DAEMON_UNAVAILABLE: true,
});

/** 只允许出现在 details 里的结构性字段；命中敏感名单的键会被丢弃。 */
const SENSITIVE_DETAIL_KEY_RE =
  /(api[-_]?key|token|secret|passw|credential|authorization|cookie|bearer|private[-_]?key|session[-_]?key)/i;

const MAX_DETAIL_STRING = 512;
const MAX_DETAIL_DEPTH = 4;

export type ErrorDetails = Readonly<Record<string, JsonValue>>;

export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;
}

function sanitize(value: JsonValue, depth: number): JsonValue | undefined {
  if (depth > MAX_DETAIL_DEPTH) return undefined;
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const safe = sanitize(item, depth + 1);
      if (safe !== undefined) items.push(safe);
    }
    return items;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY_RE.test(key)) continue;
    const safe = sanitize(child, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

/** 过滤敏感键并截断超长字符串；返回新对象，不改调用方数据。 */
export function sanitizeDetails(details: ErrorDetails | undefined): ErrorDetails | undefined {
  if (!details) return undefined;
  const safe = sanitize(details as JsonValue, 0);
  if (safe === undefined || safe === null || typeof safe !== "object" || Array.isArray(safe)) {
    return undefined;
  }
  // 全部键都被判为敏感时不要留一个空对象，避免调用方误以为「还有细节」。
  if (Object.keys(safe).length === 0) return undefined;
  return safe as ErrorDetails;
}

export class ZBridgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: ErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ZBridgeError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[code];
    this.details = sanitizeDetails(options.details);
  }

  /** 对外错误体：不含堆栈、不含 cause。 */
  toWire(): WireError {
    return this.details
      ? { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
      : { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isZBridgeError(value: unknown): value is ZBridgeError {
  return value instanceof ZBridgeError;
}

/** 把任意异常收敛成对外错误体；未知异常一律 INTERNAL 语义归入 BACKEND_UNAVAILABLE=false 的保守态。 */
export function toWireError(error: unknown): WireError {
  if (isZBridgeError(error)) return error.toWire();
  if (error instanceof TypeError) {
    return { code: "INVALID_ARGUMENT", message: "请求参数不合法", retryable: false };
  }
  return { code: "INVALID_ARGUMENT", message: "请求无法处理", retryable: false };
}

/** MCP 工具错误响应：SDK 层用 isError 标记，同时给机器可读 code。OC-05 接线时直接用。 */
export function toMcpToolError(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { contractVersion: ContractVersion; error: WireError };
} {
  const wire = toWireError(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${wire.code}: ${wire.message}` }],
    structuredContent: { contractVersion: CONTRACT_VERSION, error: wire },
  };
}
