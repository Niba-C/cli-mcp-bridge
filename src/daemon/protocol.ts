/**
 * 本地 IPC 协议（OC-04 §1、§4）。
 *
 * 帧格式：NDJSON —— 每行一个 JSON 消息，上限 1 MiB，超限立即断开。
 * 请求由哪条 socket 进来决定身份：`client.sock` 是普通查询/执行通道，
 * `operator.sock` 才有审批决定、解除阻塞和关停权限。请求体里**没有** principal、
 * env、路径、后端 URL 或凭据字段——strict schema 会把这类注入当未知字段拒绝。
 */
import { z } from "zod";
import { ZBridgeError, type ErrorCode } from "../contracts/errors.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const IPC_PROTOCOL_VERSION = 1;

export const SESSION_ID_RE = /^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const APPROVAL_ID_RE = /^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** strictObject：多一个字段（哪怕是 principalId/env/path）都是 INVALID_ARGUMENT。 */
const runStartPayload = z
  .strictObject({
    prompt: z.string().min(1).max(64 * 1024),
    clientRequestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, "clientRequestId 只允许字母数字与 . _ : -"),
    sessionId: z.string().regex(SESSION_ID_RE).optional(),
    workspaceSlug: z.string().regex(SLUG_RE).optional(),
    waitMs: z.number().int().min(0).max(25_000).optional(),
    /** OC-05：MCP agent_start 必须携带；新请求经 admitRun 校验，重试重放回执。 */
    serviceEpoch: z.number().int().min(0).optional(),
    /**
     * OC-08：完整 `providerID/modelID`（新后端为原生单段 ID）。格式与允许列表
     * 在服务端受理路径校验（INVALID_ARGUMENT／PROFILE_NOT_ALLOWED）；
     * 省略沿用会话选择或缺省 default。
     */
    model: z.string().min(1).max(257).optional(),
    /**
     * OC-09：显式后端选择。省略时新会话使用 daemon 加载的 defaultBackend，
     * 已有会话继承其持久化归属。跨后端复用会话由受理路径拒绝。
     */
    backend: z.enum(["opencode", "codebuddy", "qoder"]).optional(),
  })
  .refine((value) => value.sessionId !== undefined || value.workspaceSlug !== undefined, {
    message: "sessionId 与 workspaceSlug 至少提供一个",
  });

/** MCP agent_wait 的受控等待：最多 8 run、25 秒；超时只结束等待，不停止 run。 */
const runWaitPayload = z.strictObject({
  runs: z
    .array(
      z.strictObject({
        runId: z.string().regex(RUN_ID_RE),
        afterRevision: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(8),
  returnWhen: z.enum(["any_change", "any_terminal", "all_terminal"]).optional(),
  timeoutMs: z.number().int().min(0).max(25_000).optional(),
});

/** 停止类工具公共形状：expectedRevision + serviceEpoch + clientRequestId 幂等。 */
const runStopReceiptPayload = z.strictObject({
  runId: z.string().regex(RUN_ID_RE),
  clientRequestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  expectedRevision: z.number().int().min(0),
  serviceEpoch: z.number().int().min(0),
});

const sessionClosePayload = z.strictObject({
  sessionId: z.string().regex(SESSION_ID_RE),
  clientRequestId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  expectedRevision: z.number().int().min(0),
  serviceEpoch: z.number().int().min(0),
});

const sessionListPayload = z.strictObject({
  cursor: z.string().max(256).optional(),
  workspaceId: z.string().regex(/^ws_[0-9a-f-]+$/).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const artifactReadPayload = z.strictObject({
  artifactId: z.string().regex(/^art_[0-9a-f-]+$/),
  offset: z.number().int().min(0).optional(),
  limitChars: z.number().int().min(1).max(16_000).optional(),
});

export const CLIENT_KINDS = [
  "ping",
  "workspace.list",
  "session.create",
  "session.list",
  "session.close",
  "run.start",
  "run.get",
  "run.wait",
  "run.events",
  "run.result",
  "run.stop",
  "run.interrupt",
  "run.cancel",
  "artifact.read",
] as const;

export const OPERATOR_KINDS = [
  "ping",
  "workspace.list",
  "run.get",
  "approval.list",
  "approval.decide",
  "session.release",
  "daemon.status",
  "management.status",
  "daemon.shutdown",
] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

const runGetPayload = z
  .strictObject({
    runId: z.string().regex(RUN_ID_RE).optional(),
    clientRequestId: z.string().min(1).max(200).optional(),
  })
  .refine((value) => value.runId !== undefined || value.clientRequestId !== undefined, {
    message: "runId 与 clientRequestId 至少提供一个",
  });

/** 每个 kind 一张 strict 表；表里没有的 kind 直接拒绝。 */
export const PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.freeze({
    ping: z.strictObject({}),
    "workspace.list": z.strictObject({}),
    "session.create": z.strictObject({
      workspaceSlug: z.string().regex(SLUG_RE),
      profile: z.enum(["review"]).default("review"),
      sessionId: z.string().regex(SESSION_ID_RE).optional(),
      /** OC-09：低层创建会话时直接指定归属；省略按历史行为归 opencode。 */
      backend: z.enum(["opencode", "codebuddy", "qoder"]).optional(),
    }),
    "run.start": runStartPayload,
    "run.get": runGetPayload,
    "run.wait": runWaitPayload,
    "run.events": z.strictObject({
      runId: z.string().regex(RUN_ID_RE),
      afterSeq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    "run.result": z.strictObject({ runId: z.string().regex(RUN_ID_RE) }),
    "run.stop": z.strictObject({
      runId: z.string().regex(RUN_ID_RE).optional(),
      clientRequestId: z.string().min(1).max(200).optional(),
      intent: z.enum(["interrupt", "cancel"]).default("cancel"),
    }),
    "run.interrupt": runStopReceiptPayload,
    "run.cancel": runStopReceiptPayload,
    "session.list": sessionListPayload,
    "session.close": sessionClosePayload,
    "artifact.read": artifactReadPayload,
    "approval.list": z.strictObject({}),
    // 决定必须带上操作者在 approval.list 里看到的上下文：
    // payloadHash 证明参数未变，serverEpoch/attemptId 证明没换代、没换执行。
    "approval.decide": z.strictObject({
      approvalId: z.string().regex(APPROVAL_ID_RE),
      decision: z.enum(["allow_once", "deny"]),
      payloadHash: z.string().min(8).max(80),
      serverEpoch: z.number().int().min(1),
      attemptId: z.string().min(1).max(80),
    }),
    "session.release": z.strictObject({
      sessionId: z.string().regex(SESSION_ID_RE),
      note: z.string().min(1).max(256).optional(),
    }),
    "daemon.status": z.strictObject({}),
    // management.status 只对 operator socket 开放，返回加载摘要与配置指纹（不含内容）。
    "management.status": z.strictObject({}),
    "daemon.shutdown": z.strictObject({}),
  });

export interface IpcEnvelope {
  readonly v: number;
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/**
 * 协议层错误直接继承 ZBridgeError：服务端不需要特判就能把
 * INVALID_ARGUMENT／UNAUTHORIZED 原样回给调用方，不会在转换时丢码。
 */
export class IpcProtocolError extends ZBridgeError {
  constructor(code: ErrorCode, message: string) {
    super(code, message);
    this.name = "IpcProtocolError";
  }
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["v", "id", "kind", "payload"]);

/** 解析并校验一帧请求；任何形状错误都抛 IpcProtocolError，由服务端统一回错误响应。 */
export function parseRequestFrame(line: string): IpcEnvelope {
  if (line.length > MAX_FRAME_BYTES) {
    throw new IpcProtocolError("INVALID_ARGUMENT", "请求帧超过 1MiB 上限");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new IpcProtocolError("INVALID_ARGUMENT", "请求不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IpcProtocolError("INVALID_ARGUMENT", "请求必须是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  // 外层同样 strict：principal/env/path 等多余字段不允许出现在信封上。
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new IpcProtocolError("INVALID_ARGUMENT", `请求信封包含未知字段 ${key}`);
    }
  }
  if (record["v"] !== IPC_PROTOCOL_VERSION) {
    throw new IpcProtocolError("INVALID_ARGUMENT", `协议版本必须是 ${IPC_PROTOCOL_VERSION}`);
  }
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new IpcProtocolError("INVALID_ARGUMENT", "id 必须是 1–64 字符");
  }
  const kind = record["kind"];
  if (typeof kind !== "string") {
    throw new IpcProtocolError("INVALID_ARGUMENT", "kind 必须是字符串");
  }
  const payload = record["payload"];
  if (payload === undefined || payload === null) {
    return { v: IPC_PROTOCOL_VERSION, id, kind, payload: {} };
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new IpcProtocolError("INVALID_ARGUMENT", "payload 必须是 JSON 对象");
  }
  return { v: IPC_PROTOCOL_VERSION, id, kind, payload: payload as Record<string, unknown> };
}

/** 校验 payload 形状；错误信息只含 zod 路径与原因，不回显敏感内容。 */
export function validatePayload(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  const schema = PAYLOAD_SCHEMAS[kind];
  if (schema === undefined) {
    throw new IpcProtocolError("INVALID_ARGUMENT", `未知请求类型 ${kind}`);
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "$" : issue.path.join(".") || "$";
    throw new IpcProtocolError("INVALID_ARGUMENT", `payload 校验失败: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return result.data as Record<string, unknown>;
}

export function isClientKind(kind: string): kind is ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(kind);
}

export function isOperatorKind(kind: string): kind is OperatorKind {
  return (OPERATOR_KINDS as readonly string[]).includes(kind);
}

export function encodeResponse(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}
