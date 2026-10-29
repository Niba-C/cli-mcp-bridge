/**
 * Unix socket 传输（OC-04 §1）。
 *
 * 服务端：两条 socket 分开——client 与 operator 的可用 kind 集合不同，身份由
 * **哪条 socket 收到连接**决定，请求体里没有任何身份字段可伪造。
 * socket 文件 0600、目录 0700；同 macOS 用户的进程仍可连接，这是已记录的边界限制。
 *
 * 客户端：连接、发一帧、按 id 等待响应、超时断开。断开连接不影响 daemon 侧任务。
 */
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { toWireError, ZBridgeError, type ErrorCode, type WireError } from "../contracts/errors.ts";
import {
  encodeResponse,
  isClientKind,
  isOperatorKind,
  MAX_FRAME_BYTES,
  parseRequestFrame,
  validatePayload,
  type IpcEnvelope,
} from "./protocol.ts";

export type SocketSource = "client" | "operator";

export interface IpcRequestContext {
  readonly source: SocketSource;
  readonly envelope: IpcEnvelope;
  /**
   * 本请求的断连信号：socket 关闭/出错时触发。长等待（run.wait）用它结束轮询
   * 并清理计时器；查询中止只结束等待，不取消已受理 run 或后台停止操作。
   */
  readonly signal: AbortSignal;
}

export type IpcHandler = (context: IpcRequestContext) => Promise<unknown> | unknown;

export interface IpcServerOptions {
  readonly path: string;
  readonly source: SocketSource;
  readonly handler: IpcHandler;
}

const CONNECTION_BUFFER_LIMIT = MAX_FRAME_BYTES;

export class IpcServer {
  private readonly options: IpcServerOptions;
  private server: Server | null = null;
  /** net.Server 没有 closeAllConnections（那是 http.Server 的 API）；自己跟踪并关闭。 */
  private readonly connections = new Set<Socket>();

  constructor(options: IpcServerOptions) {
    this.options = options;
  }

  get path(): string {
    return this.options.path;
  }

  /**
   * 监听前先处理遗留 socket 文件：只有确认没有活着的监听者才删除。
   * 判断方法：尝试连接；连得上说明有人监听，拒绝启动。
   */
  async start(): Promise<void> {
    if (this.server !== null) return;
    if (existsSync(this.options.path)) {
      const live = await probeSocket(this.options.path, 500);
      if (live) {
        throw new ZBridgeError("DAEMON_UNAVAILABLE", "目标 socket 已有监听者，拒绝启动", {
          details: { socket: this.options.source },
        });
      }
      unlinkSync(this.options.path);
    }
    const server = createServer((socket) => {
      this.handleConnection(socket);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.path, () => resolve());
      });
    } catch (error) {
      this.server = null;
      // macOS sun_path 上限 104 字节：路径过长时给出可读的错误，而不是裸 EINVAL。
      throw new ZBridgeError(
        "DAEMON_UNAVAILABLE",
        `IPC socket 监听失败（${this.options.path}）：路径过长或不可用；请缩短 --data-dir`,
        error instanceof Error ? { cause: error } : {},
      );
    }
    chmodSync(this.options.path, 0o600);
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.on("close", () => {
      this.connections.delete(socket);
    });
    /** 本连接上仍在处理的请求；断连时全部收到 abort，长等待立刻收尾。 */
    const inFlight = new Set<AbortController>();
    socket.on("close", () => {
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    });
    socket.on("error", () => {
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > CONNECTION_BUFFER_LIMIT) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        void this.respond(socket, line, inFlight);
      }
    });
  }

  private async respond(socket: Socket, line: string, inFlight: Set<AbortController>): Promise<void> {
    const controller = new AbortController();
    inFlight.add(controller);
    let responseLine: string;
    try {
      const envelope = parseRequestFrame(line);
      const allowed = this.options.source === "client" ? isClientKind(envelope.kind) : isOperatorKind(envelope.kind);
      if (!allowed) {
        throw new ZBridgeError("UNAUTHORIZED", `当前通道不允许调用 ${envelope.kind}`);
      }
      const payload = validatePayload(envelope.kind, envelope.payload);
      const result = await this.options.handler({
        source: this.options.source,
        envelope: { ...envelope, payload },
        signal: controller.signal,
      });
      responseLine = encodeResponse({ v: 1, id: envelope.id, ok: true, result });
    } catch (error) {
      // IpcProtocolError 继承 ZBridgeError，code 不会在这里被冲掉：
      // 校验失败保持 INVALID_ARGUMENT，身份/通道越界保持 UNAUTHORIZED。
      const wire = error instanceof ZBridgeError ? error.toWire() : toWireError(error);
      const id = (() => {
        try {
          return parseRequestFrame(line).id;
        } catch {
          return "unknown";
        }
      })();
      responseLine = encodeResponse({ v: 1, id, ok: false, error: wire });
    } finally {
      inFlight.delete(controller);
    }
    if (!socket.destroyed) {
      socket.write(responseLine);
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    // net.Server 没有 closeAllConnections（那是 http.Server 的 API）：
    // 自己销毁跟踪到的连接，避免挂着的客户端阻塞 close 回调。
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.connections.clear();
    });
    try {
      if (existsSync(this.options.path)) unlinkSync(this.options.path);
    } catch {
      // 清理失败不影响关闭。
    }
  }
}

function probeSocket(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(path);
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 把对端回的 wire error 还原成 ZBridgeError，保留 code、retryable 与**已脱敏的**
 * details。服务端在 `toWire()` 之前已经过 sanitizeDetails；这里再构造一次
 * ZBridgeError 会重复过滤，幂等且不会把敏感键带回来。丢掉 details 会让
 * gateway 对外错误体与 daemon 内部错误体不一致（例如 SESSION_BUSY 的
 * blockedRunId、REVISION_CONFLICT 的当前 revision）。
 */
function wireToError(wire: WireError | undefined): ZBridgeError {
  if (wire === undefined || typeof wire.code !== "string") {
    return new ZBridgeError("DAEMON_UNAVAILABLE", "IPC 调用失败");
  }
  return new ZBridgeError(wire.code as ErrorCode, wire.message, {
    retryable: wire.retryable,
    ...(wire.details === undefined ? {} : { details: wire.details }),
  });
}

export interface IpcCallOptions {
  readonly timeoutMs?: number;
  /**
   * 中止信号：触发后立即销毁 socket 并拒绝请求。
   * gateway 的 agent_wait 用它保证「断连/AbortSignal 清理计时器与监听器」，
   * 不留下等待中的 socket。
   */
  readonly signal?: AbortSignal;
}

/** 单次请求；不维护连接池——本地 socket 建连成本可忽略，且无状态最安全。 */
export function ipcCall<T = unknown>(path: string, kind: string, payload: Record<string, unknown>, options: IpcCallOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<T>((resolve, reject) => {
    const socket = netConnect(path);
    let buffer = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
  const timer = setTimeout(() => {
    fail(new ZBridgeError("DAEMON_UNAVAILABLE", "IPC 请求超时", { details: { kind } }));
  }, timeoutMs);
  const onAbort = (): void => {
    fail(new ZBridgeError("DAEMON_UNAVAILABLE", "IPC 请求已中止", { details: { kind } }));
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      fail(new ZBridgeError("DAEMON_UNAVAILABLE", "IPC 请求已中止", { details: { kind } }));
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  const settle = <T>(value: T): T => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    return value;
  };
  socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ v: 1, id, kind, payload })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message["id"] !== id) continue;
        settle(null);
        settled = true;
        socket.destroy();
        if (message["ok"] === true) {
          resolve(message["result"] as T);
        } else {
          reject(wireToError(message["error"] as WireError | undefined));
        }
        return;
      }
    });
    socket.on("timeout", () => {
      fail(new ZBridgeError("DAEMON_UNAVAILABLE", "IPC 连接超时"));
    });
    socket.on("error", (error: Error) => {
      fail(new ZBridgeError("DAEMON_UNAVAILABLE", `IPC 连接失败: ${error.message}`));
    });
  });
}
