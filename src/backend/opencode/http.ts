/**
 * 极薄的 HTTP 客户端（技术规格 §6）。
 *
 * 关键约束：
 * - **一次发送**：每个请求只 fetch 一次，没有重试中间件，也没有「失败后再试一次」的默认值；
 * - 有限超时：所有请求都有 AbortSignal 期限，读请求也一样；
 * - 三态区分：本地就拒绝（not_sent）、服务端明确拒绝（rejected，4xx）、
 *   结果不明（unknown，超时/中断/5xx/连接异常）。写请求绝不会被归类成「没发出」，
 *   除非调用方在发送前就验证失败；
 * - 响应体有界，超长只截断用于诊断，不整体读进内存。
 */

export type HttpFailureKind = "not_sent" | "rejected" | "unknown";

export interface HttpSuccess {
  readonly ok: true;
  readonly status: number;
  readonly body: unknown;
  readonly bytes: number;
}

export interface HttpFailure {
  readonly ok: false;
  readonly kind: HttpFailureKind;
  readonly status: number | null;
  readonly message: string;
  readonly body: unknown;
}

export type HttpResult = HttpSuccess | HttpFailure;

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpClientOptions {
  readonly baseUrl: string;
  /** 已构造好的 Authorization 头；本模块不接触密码明文。 */
  readonly authorization: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** 仅测试注入：记录每次请求，用于断言「写请求只发一次」。 */
  readonly onRequest?: (info: { readonly method: string; readonly route: string }) => void;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly timeoutMs?: number;
  /** 写请求：非 2xx 一律按 rejected/unknown 处理，由调用方决定是否 unknown。 */
  readonly write?: boolean;
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError" || name === "DOMException";
}

function causeCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export class OpencodeHttpClient {
  private readonly options: HttpClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private url(route: string): string {
    return `${this.options.baseUrl}${route}`;
  }

  private headers(write: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: this.options.authorization, Accept: "application/json" };
    if (write) headers["Content-Type"] = "application/json";
    return headers;
  }

  /**
   * 发送一次 JSON 请求。
   *
   * 注意：`not_sent` 只可能出现在「参数在本地就无法序列化」这种确定情形；
   * 网络异常一律 `unknown`，因为无法证明服务端没有收到请求。
   */
  async requestJson(route: string, request: RequestOptions = {}): Promise<HttpResult> {
    const method = request.method ?? "GET";
    const write = request.write === true;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let payload: string | undefined;
    if (request.body !== undefined) {
      try {
        payload = JSON.stringify(request.body);
      } catch {
        return { ok: false, kind: "not_sent", status: null, message: "请求体无法序列化", body: null };
      }
    }
    this.options.onRequest?.({ method, route });

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(route), {
        method,
        headers: this.headers(write),
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, kind: "unknown", status: null, message: `请求超时或被中断（${timeoutMs}ms）`, body: null };
      }
      const code = causeCode(error);
      return {
        ok: false,
        kind: "unknown",
        status: null,
        message: code === null ? "请求失败，结果不明" : `请求失败（${code}），结果不明`,
        body: null,
      };
    }

    const { text, truncated } = await readBounded(response);
    const body = parseBody(text);
    if (response.ok) {
      return { ok: true, status: response.status, body: truncated ? null : body, bytes: text.length };
    }
    if (!write) {
      return {
        ok: false,
        kind: "unknown",
        status: response.status,
        message: `HTTP ${response.status}`,
        body,
      };
    }
    // 4xx 是服务端明确拒绝（没有写入）；5xx 与其它状态无法证明没写，按 unknown。
    const kind: HttpFailureKind = response.status >= 400 && response.status < 500 ? "rejected" : "unknown";
    return { ok: false, kind, status: response.status, message: `HTTP ${response.status}`, body };
  }

  /**
   * 打开 SSE 流。只对「建立连接」设超时，拿到响应后由调用方控制生命周期。
   * 连接失败一律 unknown：不能因为流没建上就断言后端没在跑。
   */
  async openStream(
    route: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; body: ReadableStream<Uint8Array>; status: number } | HttpFailure> {
    this.options.onRequest?.({ method: "GET", route });
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(route), {
        method: "GET",
        headers: { Authorization: this.options.authorization, Accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      return {
        ok: false,
        kind: "unknown",
        status: null,
        message: isAbortError(error) ? "SSE 连接超时或被中断" : "SSE 连接失败",
        body: null,
      };
    }
    if (!response.ok || response.body === null) {
      return { ok: false, kind: "unknown", status: response.status, message: `SSE HTTP ${response.status}`, body: null };
    }
    return { ok: true, body: response.body, status: response.status };
  }
}

async function readBounded(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
  }
}

/** 把 HttpFailure 收敛成对外错误码；调用方通常只在诊断路径使用。 */
export function httpFailureCode(failure: HttpFailure): string {
  if (failure.status === 404) return "NOT_FOUND";
  if (failure.kind === "not_sent") return "INVALID_ARGUMENT";
  return "BACKEND_UNAVAILABLE";
}
