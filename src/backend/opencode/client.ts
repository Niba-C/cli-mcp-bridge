/**
 * OpenCode 1.18.32 HTTP API 映射（技术规格 §5）。
 *
 * 业务层不需要知道 URL、查询参数或状态码：这里按安装版本的 OpenAPI 固定路径，
 * 并且只返回结构化结果。所有方法都是「一次请求」，不重试。
 */
import {
  OPENCODE_API,
  abortPath,
  messagesPath,
  parseMessageList,
  parsePermissionList,
  parseSessionStatus,
  permissionReplyPath,
  promptAsyncPath,
  sessionPath,
  type ParsedMessages,
  type ParsedPermissions,
  type SessionStatusKind,
} from "./protocol.ts";
import { OpencodeHttpClient, type HttpFailure, type HttpResult } from "./http.ts";

export interface SessionCreateInput {
  readonly title: string;
  readonly permission: readonly { permission: string; pattern: string; action: string }[];
  readonly providerID: string;
  readonly modelID: string;
}

export interface PromptInput {
  readonly messageID: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly text: string;
}

export interface ProviderSummary {
  readonly ids: readonly string[];
  readonly connected: readonly string[];
  readonly models: Readonly<Record<string, readonly string[]>>;
}

export type ProviderResult = { readonly ok: true; readonly value: ProviderSummary } | HttpFailure;
export type SessionResult = { readonly ok: true; readonly sessionId: string } | HttpFailure;
export type VoidResult = { readonly ok: true } | HttpFailure;
export type MessagesResult = { readonly ok: true; readonly value: ParsedMessages } | HttpFailure;
export type PermissionsResult = { readonly ok: true; readonly value: ParsedPermissions } | HttpFailure;
export type StatusResult = { readonly ok: true; readonly value: SessionStatusKind } | HttpFailure;

function ok(http: HttpResult): http is Extract<HttpResult, { ok: true }> {
  return http.ok;
}

function failure(http: HttpFailure): HttpFailure {
  return http;
}

export class OpenCodeApi {
  private readonly http: OpencodeHttpClient;

  constructor(http: OpencodeHttpClient) {
    this.http = http;
  }

  get client(): OpencodeHttpClient {
    return this.http;
  }

  /** 健康检查：版本字段缺失时返回 null，由调用方按「无法证明版本」处理。 */
  async health(): Promise<{ readonly ok: true; readonly version: string | null; readonly healthy: boolean } | HttpFailure> {
    const result = await this.http.requestJson(OPENCODE_API.health, { timeoutMs: 5_000 });
    if (!ok(result)) return failure(result);
    const record = result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : {};
    const version = typeof record["version"] === "string" ? record["version"] : null;
    const healthy = record["healthy"] !== false;
    return { ok: true, version, healthy };
  }

  /**
   * 只保留供应商／模型标识与连接状态。
   * 响应里可能带 `options`（含密钥），这里**不返回**该字段。
   */
  async providers(): Promise<ProviderResult> {
    const result = await this.http.requestJson(OPENCODE_API.provider);
    if (!ok(result)) return failure(result);
    const record = result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : {};
    const all = Array.isArray(record["all"]) ? record["all"] : [];
    const ids: string[] = [];
    const models: Record<string, readonly string[]> = {};
    for (const item of all) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const provider = item as Record<string, unknown>;
      const id = typeof provider["id"] === "string" ? provider["id"] : null;
      if (id === null) continue;
      ids.push(id);
      const modelMap = provider["models"];
      models[id] =
        modelMap !== null && typeof modelMap === "object" && !Array.isArray(modelMap)
          ? Object.keys(modelMap as Record<string, unknown>)
          : [];
    }
    const connected = Array.isArray(record["connected"])
      ? record["connected"].filter((value): value is string => typeof value === "string")
      : [];
    return { ok: true, value: { ids, connected, models } };
  }

  async createSession(input: SessionCreateInput): Promise<SessionResult> {
    const result = await this.http.requestJson(OPENCODE_API.session, {
      method: "POST",
      write: true,
      body: {
        title: input.title,
        permission: input.permission,
        // POST /session 的 model 形状是 {id, providerID}（不是 {providerID, modelID}）。
        model: { id: input.modelID, providerID: input.providerID },
      },
    });
    if (!ok(result)) return failure(result);
    const record = result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : {};
    const id = typeof record["id"] === "string" ? record["id"] : null;
    if (id === null) return { ok: false, kind: "unknown", status: result.status, message: "创建会话的响应缺少 id", body: result.body };
    return { ok: true, sessionId: id };
  }

  async getSession(sessionId: string): Promise<{ readonly ok: true; readonly sessionId: string } | HttpFailure> {
    const result = await this.http.requestJson(sessionPath(sessionId));
    if (!ok(result)) return failure(result);
    const record = result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>)
      : {};
    const id = typeof record["id"] === "string" ? record["id"] : null;
    if (id === null || id !== sessionId) {
      return { ok: false, kind: "unknown", status: result.status, message: "读取会话没有确认同一 ID", body: null };
    }
    return { ok: true, sessionId: id };
  }

  /**
   * 提交任务。返回 2xx 只表示受理：204 没有任何执行证据，
   * 必须再靠历史消息确认（技术规格 §3）。
   */
  async promptAsync(sessionId: string, input: PromptInput): Promise<{ readonly ok: true; readonly status: number } | HttpFailure> {
    const result = await this.http.requestJson(promptAsyncPath(sessionId), {
      method: "POST",
      write: true,
      body: {
        messageID: input.messageID,
        model: { providerID: input.providerID, modelID: input.modelID },
        parts: [{ type: "text", text: input.text }],
      },
    });
    if (!ok(result)) return failure(result);
    return { ok: true, status: result.status };
  }

  async messages(sessionId: string): Promise<MessagesResult> {
    const result = await this.http.requestJson(`${messagesPath(sessionId)}?limit=200`);
    if (!ok(result)) return failure(result);
    return { ok: true, value: parseMessageList(result.body) };
  }

  async permissions(): Promise<PermissionsResult> {
    const result = await this.http.requestJson(OPENCODE_API.permission);
    if (!ok(result)) return failure(result);
    return { ok: true, value: parsePermissionList(result.body) };
  }

  async replyPermission(requestId: string, reply: "once" | "reject"): Promise<VoidResult> {
    const result = await this.http.requestJson(permissionReplyPath(requestId), {
      method: "POST",
      write: true,
      body: { reply },
    });
    if (!ok(result)) return failure(result);
    return { ok: true };
  }

  async abort(sessionId: string): Promise<{ readonly ok: true; readonly acknowledged: boolean } | HttpFailure> {
    const result = await this.http.requestJson(abortPath(sessionId), { method: "POST", write: true });
    if (!ok(result)) return failure(result);
    return { ok: true, acknowledged: result.body !== false };
  }

  async sessionStatus(sessionId: string): Promise<StatusResult> {
    const result = await this.http.requestJson(OPENCODE_API.sessionStatus);
    if (!ok(result)) return failure(result);
    return { ok: true, value: parseSessionStatus(result.body, sessionId) };
  }

  async openEventStream(signal: AbortSignal): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | HttpFailure> {
    const stream = await this.http.openStream(OPENCODE_API.event, signal);
    if (!stream.ok) return stream;
    return { ok: true, body: stream.body };
  }
}
