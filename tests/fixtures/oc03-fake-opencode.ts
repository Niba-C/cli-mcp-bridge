/**
 * 离线模拟的 OpenCode 1.18.32 HTTP 服务（**只用于测试**）。
 *
 * 它由 adapter 通过 `spawn` 启动（与真实 `opencode serve` 走同一条代码路径：
 * 从自身 stdout 读地址、独占进程组、临时 Basic 认证），但完全不联网、不调用模型。
 *
 * 用途：
 * - 协议回放：消息／part／事件形状来自锁定 OpenCode 版本的采集样本；
 * - 故障注入：SSE 分片/CRLF/重复/未知事件/中途断开、HTTP 无响应、abort 无响应、
 *   工具子进程比服务活得久、错归属、错供应商。
 *
 * 参数：node oc03-fake-opencode.ts --log <requests.jsonl> --scenario <name> [--announce <url-host>]
 * 场景名见下方 `SCENARIOS`。
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const logPath = arg("log");
const scenarioName = arg("scenario") ?? "text-happy";
const announceHost = arg("announce-host") ?? "127.0.0.1";
const workdir = process.cwd();
const secret = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
const auth = secret.length > 0 ? `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}` : null;

if (logPath === null) {
  process.stderr.write("missing --log\n");
  process.exit(2);
}
mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(logPath, "");

const sessionId = "ses_fake0000000000000000000001";
/**
 * 用户消息 ID 由 adapter 在 prompt_async 里显式给出；服务端必须原样使用，
 * 否则归属就退化成「猜最后一条消息」——那正是产品不允许的。
 */
let activeUserId = "msg_user0000000000000000000001";
const parentUser = () => activeUserId;
/**
 * OC-08：本轮请求的模型（providerID/modelID）。默认取受控配置的 config.model，
 * 每次 POST /prompt_async 按请求体更新；消息身份按它回显。
 * 场景可以用显式参数覆盖（provider-mismatch / model-mismatch 注入身份错误）。
 */
let activeModel = { providerID: "minimax", modelID: "MiniMax-M3.1-Flash" };
const nowMs = () => Date.now();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PartRecord {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: Record<string, unknown>;
  synthetic?: boolean;
}

interface MessageRecord {
  info: Record<string, unknown>;
  parts: PartRecord[];
}

const messages: MessageRecord[] = [];
const permissions: Record<string, unknown>[] = [];
const sseClients = new Set<ServerResponse>();
const requestLog: unknown[] = [];

function record(entry: unknown): void {
  requestLog.push(entry);
  appendFileSync(logPath as string, `${JSON.stringify(entry)}\n`);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function messageById(id: string): MessageRecord | null {
  return messages.find((message) => message.info["id"] === id) ?? null;
}

function pushEvent(type: string, properties: Record<string, unknown>, id?: string): void {
  const frameId = id ?? `evt_fake${String(eventCounter++).padStart(10, "0")}`;
  const payload = { id: frameId, type, properties };
  broadcast(payload);
}
let eventCounter = 1;

interface SseOptions {
  readonly chunkBytes?: number;
  readonly crlf?: boolean;
  readonly duplicate?: boolean;
}

function encodeFrame(payload: unknown, options: SseOptions): Buffer {
  const eol = options.crlf === true ? "\r\n" : "\n";
  const data = JSON.stringify(payload);
  // 拆成两行 `data:`：只在字符串外的逗号处切，插入的换行是合法 JSON 空白，
  // 这样既验证了多行 data 的拼接，又不会把 JSON 字符串切断。
  const split = safeSplitIndex(data);
  const lines = [`data: ${data.slice(0, split)}`, `data: ${data.slice(split)}`, "", ""];
  return Buffer.from(lines.join(eol), "utf8");
}

/** 找到第一个「字符串外、深度 0」的逗号后的位置；找不到就整行不拆。 */
function safeSplitIndex(json: string): number {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth <= 1 && index > 8) return index + 1;
  }
  return json.length;
}

function broadcast(payload: unknown): void {
  const options = scenario.sse ?? {};
  for (const client of sseClients) {
    try {
      const frame = encodeFrame(payload, options);
      writeChunked(client, frame, options);
      if (options.duplicate === true) writeChunked(client, frame, options);
    } catch {
      sseClients.delete(client);
    }
  }
}

/** 按 N 字节切片写出：用来把 UTF-8 多字节字符切开。 */
function writeChunked(response: ServerResponse, frame: Buffer, options: SseOptions): void {
  const size = options.chunkBytes ?? 0;
  if (size <= 0) {
    response.write(frame);
    return;
  }
  for (let offset = 0; offset < frame.length; offset += size) {
    response.write(frame.subarray(offset, offset + size));
  }
}

interface Step {
  readonly delay: number;
  readonly run: () => void | Promise<void>;
}

interface Scenario {
  readonly promptBehaviour?: "accept" | "reject" | "destroy" | "hang";
  readonly connected?: readonly string[];
  readonly models?: readonly string[];
  readonly sse?: SseOptions;
  readonly steps: readonly Step[];
  readonly onAbort?: "settle" | "ignore" | "crash";
  readonly abortsAcknowledged?: boolean;
  readonly onReply?: Record<string, readonly Step[]>;
  readonly child?: { readonly marker: string; readonly delayMs: number; readonly escaped: boolean };
  /** 不等待 prompt_async，服务一启动就跑时间线（用于 worker 级的自杀/崩溃场景）。 */
  readonly autoStart?: boolean;
  /**
   * 每次收到 prompt_async 都重置并重跑时间线（OC-05 同会话续接轮用）。
   * 默认 false：OC-03/04 的时间线只跑一次，第二轮 prompt 不产生新消息。
   */
  readonly restartTimelineOnPrompt?: boolean;
}

// ---------------------------------------------------------------- 场景定义

function userMessage(at: number) {
  return {
    delay: at,
    run: () => {
      // 必须在 step 真正执行时读取：activeUserId 由 POST /prompt_async 设置，
      // 场景定义阶段还只是初始占位值。
      const id = activeUserId;
      const message: MessageRecord = {
        info: {
          id,
          sessionID: sessionId,
          role: "user",
          time: { created: nowMs() },
          agent: "build",
          model: { providerID: activeModel.providerID, modelID: activeModel.modelID },
        },
        parts: [],
      };
      messages.push(message);
      pushEvent("message.updated", { sessionID: sessionId, info: message.info });
    },
  };
}

function assistantStart(at: number, messageId: string, parentId: string | (() => string), providerID?: string, modelID?: string) {
  return {
    delay: at,
    run: () => {
      if (messageById(messageId) !== null) return;
      const message: MessageRecord = {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: "assistant",
          parentID: typeof parentId === "function" ? parentId() : parentId,
          mode: "build",
          agent: "build",
          path: { cwd: process.cwd(), root: "/" },
          cost: 0,
          tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          // 未显式覆盖时回显本轮请求的模型（身份校验按选定值进行）。
          modelID: modelID ?? activeModel.modelID,
          providerID: providerID ?? activeModel.providerID,
          time: { created: nowMs() },
        },
        parts: [],
      };
      messages.push(message);
      pushEvent("message.updated", { sessionID: sessionId, info: message.info });
    },
  };
}

function textStep(at: number, messageId: string, partId: string, delta: string) {
  return {
    delay: at,
    run: () => {
      const message = messageById(messageId);
      if (message === null) return;
      const existing = message.parts.find((item) => item.id === partId);
      if (existing === undefined) {
        message.parts.push({ id: partId, sessionID: sessionId, messageID: messageId, type: "text", text: "" });
        pushEvent("message.part.updated", {
          sessionID: sessionId,
          part: { id: partId, sessionID: sessionId, messageID: messageId, type: "text", text: "" },
        });
      }
      const part = message.parts.find((item) => item.id === partId);
      if (part !== undefined) part.text = `${part.text ?? ""}${delta}`;
      pushEvent("message.part.delta", {
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
        field: "text",
        delta,
      });
    },
  };
}

function reasoningStep(at: number, messageId: string, partId: string, delta: string) {
  return {
    delay: at,
    run: () => {
      const message = messageById(messageId);
      if (message === null) return;
      if (!message.parts.some((item) => item.id === partId)) {
        message.parts.push({ id: partId, sessionID: sessionId, messageID: messageId, type: "reasoning", text: "" });
        pushEvent("message.part.updated", {
          sessionID: sessionId,
          part: { id: partId, sessionID: sessionId, messageID: messageId, type: "reasoning", text: "" },
        });
      }
      pushEvent("message.part.delta", {
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
        field: "text",
        delta,
      });
    },
  };
}

function toolStep(
  at: number,
  messageId: string,
  partId: string,
  callID: string,
  tool: string,
  status: "pending" | "running" | "completed" | "error",
) {
  return {
    delay: at,
    run: () => {
      const message = messageById(messageId);
      if (message === null) return;
      const state: Record<string, unknown> =
        status === "completed"
          ? { status, input: { command: "sh ./work.sh" }, output: "ok", title: "work.sh", metadata: {}, time: { start: nowMs(), end: nowMs() } }
          : status === "error"
            ? { status, input: { command: "sh ./work.sh" }, error: "permission denied", time: { start: nowMs(), end: nowMs() } }
            : { status, input: { command: "sh ./work.sh" }, time: { start: nowMs() } };
      const part: PartRecord = {
        id: partId,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID,
        tool,
        state,
      };
      const existing = message.parts.find((item) => item.id === partId);
      if (existing === undefined) message.parts.push(part);
      else Object.assign(existing, part);
      pushEvent("message.part.updated", { sessionID: sessionId, part, time: nowMs() });
    },
  };
}

function finishStep(
  at: number,
  messageId: string,
  finish: string,
  options: { complete?: boolean; errorName?: string } = {},
) {
  return {
    delay: at,
    run: () => {
      const message = messageById(messageId);
      if (message === null) return;
      const info = message.info;
      info["finish"] = finish;
      if (options.complete !== false) {
        info["time"] = { ...(info["time"] as Record<string, unknown>), completed: nowMs() };
      }
      if (options.errorName !== undefined) {
        info["error"] = { name: options.errorName, data: { message: "aborted" } };
      }
      pushEvent("message.updated", { sessionID: sessionId, info });
      pushEvent("message.updated", { sessionID: sessionId, info });
    },
  };
}

function idleStep(at: number) {
  return {
    delay: at,
    run: () => {
      pushEvent("session.status", { sessionID: sessionId, status: { type: "idle" } });
      pushEvent("session.idle", { sessionID: sessionId });
    },
  };
}

function closeSseStep(at: number) {
  return {
    delay: at,
    run: () => {
      for (const client of sseClients) client.end();
      sseClients.clear();
    },
  };
}

function permissionStep(at: number, requestId: string, messageId: string, callID: string, permission: string, command: string) {
  return {
    delay: at,
    run: () => {
      permissions.push({
        id: requestId,
        sessionID: sessionId,
        permission,
        patterns: [command],
        metadata: { command },
        always: ["sh *"],
        tool: { messageID: messageId, callID },
      });
      pushEvent("permission.asked", {
        id: requestId,
        sessionID: sessionId,
        permission,
        patterns: [command],
        metadata: { command },
        always: ["sh *"],
        tool: { messageID: messageId, callID },
      });
    },
  };
}

function childStep(at: number, marker: string, delayMs: number, escaped: boolean) {
  return {
    delay: at,
    run: () => {
      const target = marker.startsWith("/") ? marker : `${workdir}/${marker}`;
      const child = spawn(
        "/bin/sh",
        ["-c", `sleep ${Math.max(1, Math.round(delayMs / 1000))}; printf "late\\n" >> ${JSON.stringify(target)}; sleep 5`],
        { detached: escaped, stdio: "ignore" },
      );
      record({ at: nowMs(), event: "child_spawned", pid: child.pid ?? 0, escaped, marker: target });
      child.unref();
    },
  };
}

const M1 = "msg_asst0000000000000000000001";
const M2 = "msg_asst0000000000000000000002";

const SCENARIOS: Record<string, Scenario> = {
  "oc05-long-unicode": {
    steps: [
      userMessage(10),
      assistantStart(40, M1, parentUser),
      textStep(60, M1, "prt_long", "中" + "中文🙂".repeat(5_000)),
      finishStep(90, M1, "stop"),
      idleStep(100),
    ],
  },
  "text-happy": {
    steps: [
      userMessage(10),
      assistantStart(40, M1, parentUser),
      reasoningStep(50, M1, "prt_reason1", "内部推理：不要泄漏"),
      textStep(60, M1, "prt_text1", "READY"),
      finishStep(90, M1, "stop"),
      idleStep(100),
    ],
  },
  // OC-05 同会话续接：每轮 prompt_async 都重跑时间线，且 assistant 消息每轮用
  // 新 ID（否则 assistantStart 会因「已存在」跳过，第二轮无法归属/完成）。
  "text-happy-repeat": {
    restartTimelineOnPrompt: true,
    steps: (() => {
      let roundMessageId = "";
      const uniqueSuffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      return [
        {
          delay: 10,
          run: () => {
            roundMessageId = `msg_rep_${uniqueSuffix()}`;
            userMessage(0).run();
          },
        },
        { delay: 30, run: () => assistantStart(0, roundMessageId, parentUser).run() },
        { delay: 10, run: () => reasoningStep(0, roundMessageId, `prt_r_${roundMessageId}`, "内部推理：不要泄漏").run() },
        { delay: 10, run: () => textStep(0, roundMessageId, `prt_t_${roundMessageId}`, "READY").run() },
        { delay: 30, run: () => finishStep(0, roundMessageId, "stop").run() },
        { delay: 10, run: () => idleStep(0).run() },
      ];
    })(),
  },
  "tool-round": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "pending"),
      toolStep(50, M1, "prt_tool1", "call_1", "bash", "running"),
      toolStep(60, M1, "prt_tool1", "call_1", "bash", "completed"),
      finishStep(70, M1, "tool-calls"),
      assistantStart(90, M2, parentUser),
      textStep(100, M2, "prt_text2", "DONE"),
      finishStep(120, M2, "stop"),
      idleStep(130),
    ],
  },
  "wrong-parent": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, "msg_other0000000000000000000001"),
      textStep(40, M1, "prt_text1", "NOT-MY-RUN"),
      finishStep(60, M1, "stop"),
      idleStep(70),
    ],
  },
  "tool-calls-only": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "completed"),
      finishStep(60, M1, "tool-calls"),
      idleStep(70),
    ],
  },
  "idle-only": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      textStep(40, M1, "prt_text1", "PARTIAL"),
      idleStep(60),
    ],
  },
  "sse-close": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      textStep(40, M1, "prt_text1", "PARTIAL"),
      closeSseStep(60),
    ],
  },
  "backend-error": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      textStep(40, M1, "prt_text1", "oops"),
      finishStep(60, M1, "error", { errorName: "ProviderAuthError" }),
      idleStep(70),
    ],
  },
  "provider-mismatch": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser, "deepseek", "deepseek-chat"),
      textStep(40, M1, "prt_text1", "wrong provider"),
      finishStep(60, M1, "stop"),
    ],
  },
  /** 第一段 assistant 用了外国供应商，末段回到 minimax：不能因为末段正常就 completed。 */
  "provider-mismatch-early": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser, "deepseek", "deepseek-chat"),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "completed"),
      finishStep(50, M1, "tool-calls"),
      assistantStart(70, M2, parentUser),
      textStep(80, M2, "prt_text2", "looks fine"),
      finishStep(100, M2, "stop"),
    ],
  },
  /** 工具 part 存在但状态无法识别：不能被当成「工具已结束」。 */
  "unknown-tool-state": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      {
        delay: 40,
        run: () => {
          const message = messageById(M1);
          if (message === null) return;
          const part: PartRecord = {
            id: "prt_tool_weird",
            sessionID: sessionId,
            messageID: M1,
            type: "tool",
            callID: "call_weird",
            tool: "bash",
            state: { status: "unrecognized", input: { command: "sh ./x.sh" } },
          };
          message.parts.push(part);
          pushEvent("message.part.updated", { sessionID: sessionId, part });
        },
      },
      textStep(50, M1, "prt_text1", "done already"),
      finishStep(70, M1, "stop"),
      idleStep(80),
    ],
  },
  /**
   * 归属不明与跨会话的权限请求：本 run 只应处理自己的那一条，
   * 而且绝不能给 foreign-session／无 messageID 的请求发许可。
   */
  "permission-foreign": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_own", "bash", "running"),
      {
        delay: 50,
        run: () => {
          const foreign = {
            id: "per_foreign0001",
            sessionID: "ses_foreign00000000000000001",
            permission: "bash",
            patterns: ["cat /etc/passwd"],
            metadata: { command: "cat /etc/passwd" },
            always: [],
            tool: { messageID: M1, callID: "call_foreign" },
          };
          const anonymous = {
            id: "per_anonymous01",
            sessionID: sessionId,
            permission: "bash",
            patterns: ["sh ./anonymous.sh"],
            metadata: { command: "sh ./anonymous.sh" },
            always: [],
          };
          const own = {
            id: "per_own00000001",
            sessionID: sessionId,
            permission: "bash",
            patterns: ["sh ./own.sh"],
            metadata: { command: "sh ./own.sh" },
            always: [],
            tool: { messageID: M1, callID: "call_own" },
          };
          permissions.push(foreign, anonymous, own);
          for (const request of [foreign, anonymous, own]) {
            pushEvent("permission.asked", request as unknown as Record<string, unknown>);
          }
        },
      },
    ],
    onReply: {
      once: [
        toolStep(10, M1, "prt_tool1", "call_own", "bash", "completed"),
        textStep(20, M1, "prt_text2", "OK"),
        finishStep(30, M1, "stop"),
        idleStep(40),
      ],
      reject: [
        toolStep(10, M1, "prt_tool1", "call_own", "bash", "error"),
        finishStep(30, M1, "stop"),
        idleStep(40),
      ],
    },
  },
  "sse-faults": {
    sse: { chunkBytes: 3, crlf: true, duplicate: true },
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      reasoningStep(40, M1, "prt_reason1", "内部推理不应出现在正文"),
      textStep(50, M1, "prt_text1", "你好"),
      textStep(60, M1, "prt_text1", "，世界"),
      textStep(70, M1, "prt_text1", "🌍"),
      {
        delay: 75,
        run: () => {
          pushEvent("experimental.unknown.event", { sessionID: sessionId, note: "ignore me" });
          pushEvent("session.updated", { sessionID: sessionId, info: { id: sessionId } });
        },
      },
      finishStep(100, M1, "stop"),
      idleStep(110),
    ],
  },
  "permission-deny": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      permissionStep(50, "per_fake0001", M1, "call_1", "bash", "sh ./work.sh"),
    ],
    onReply: {
      reject: [
        toolStep(10, M1, "prt_tool1", "call_1", "bash", "error"),
        textStep(20, M1, "prt_text2", "REJECTED"),
        finishStep(30, M1, "stop"),
        idleStep(40),
      ],
      once: [
        toolStep(10, M1, "prt_tool1", "call_1", "bash", "completed"),
        textStep(20, M1, "prt_text2", "DONE"),
        finishStep(30, M1, "stop"),
        idleStep(40),
      ],
    },
  },
  "permission-reject-no-final": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      permissionStep(50, "per_fake0001", M1, "call_1", "bash", "sh ./work.sh"),
    ],
    onReply: {
      reject: [
        toolStep(10, M1, "prt_tool1", "call_1", "bash", "error"),
        finishStep(20, M1, "tool-calls"),
        idleStep(30),
      ],
    },
  },
  "abort-settle": {
    onAbort: "settle",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
    ],
  },
  "abort-ignore": {
    onAbort: "ignore",
    child: { marker: "late-ignore.txt", delayMs: 2_000, escaped: false },
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      childStep(50, "late-ignore.txt", 2_000, false),
    ],
  },
  "worker-crash": {
    onAbort: "ignore",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      childStep(50, "late-crash.txt", 2_000, false),
    ],
  },
  /**
   * OC-04 daemon 崩溃恢复场景：工具一直挂着，shell 子进程在 6 秒后写 marker。
   * daemon 被 SIGKILL 后重启，恢复逻辑必须在 6 秒窗口内确认身份并回收进程组，
   * 使 marker 永远不出现。
   */
  "daemon-crash": {
    onAbort: "ignore",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      childStep(50, "oc04-crash-marker.txt", 6_000, false),
    ],
  },
  /**
   * OC-04「服务先死、daemon 再死」窗口：服务在 2.5s 时 SIGKILL 自己，
   * 逃逸子进程（detached，独立进程组）在 5s 后写 marker。
   * daemon 的周期观测必须在服务存活期记下子进程身份；daemon 被杀后重启，
   * 恢复逻辑凭记录的身份逐个回收逃逸子进程，marker 永不出现。
   */
  "daemon-crash-service-first": {
    onAbort: "ignore",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
      childStep(50, "oc04-escaped-marker.txt", 8_000, true),
      {
        delay: 2_500,
        run: () => {
          process.kill(process.pid, "SIGKILL");
        },
      },
    ],
  },
  /** 受理后派生子进程（脱离进程组），然后自杀：用于验证「没有后代证据就不算停」。 */
  "self-kill-escaped": {
    autoStart: true,
    steps: [
      userMessage(10),
      childStep(30, "escaped-child.txt", 3_000, true),
      {
        delay: 120,
        run: () => {
          process.kill(process.pid, "SIGKILL");
        },
      },
    ],
  },
  "deadline-stall": {
    onAbort: "settle",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      toolStep(40, M1, "prt_tool1", "call_1", "bash", "running"),
    ],
  },
  /**
   * OC-06：先产生正文增量再挂住，run 会真正进入 running（deadline-stall 只有工具事件，
   * 停留在 starting）。用于「运行中 cancel」和「运行中 daemon 强退」两条 MCP 链路。
   */
  "text-stall": {
    onAbort: "settle",
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser),
      textStep(50, M1, "prt_text1", "PARTIAL"),
      toolStep(60, M1, "prt_tool1", "call_1", "bash", "running"),
    ],
  },
  "provider-foreign": {
    connected: ["minimax", "deepseek"],
    steps: [userMessage(10), assistantStart(30, M1, parentUser), finishStep(50, M1, "stop")],
  },
  "provider-missing-model": {
    models: ["some-other-model"],
    steps: [userMessage(10), assistantStart(30, M1, parentUser), finishStep(50, M1, "stop")],
  },
  /** OC-08：供应商正确但模型 ID 与本轮请求不符 → BACKEND_PROTOCOL_MISMATCH。 */
  "model-mismatch": {
    steps: [
      userMessage(10),
      assistantStart(30, M1, parentUser, undefined, "wrong-model-id"),
      textStep(40, M1, "prt_text1", "wrong model"),
      finishStep(60, M1, "stop"),
    ],
  },
  /** 提交被明确拒绝：4xx，没有写入。 */
  "prompt-reject": {
    promptBehaviour: "reject",
    steps: [],
  },
  /** 提交的响应丢失（socket destroy）：客户端只能判 unknown。 */
  "prompt-unknown": {
    promptBehaviour: "destroy",
    steps: [],
  },
  /** 受理了 204，但历史里没有本 run 的消息：不能凭 204 认为已发送。 */
  "prompt-accepted-no-history": {
    steps: [],
  },
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * 启动即校验受控配置：真实 `opencode serve` 会因为配置形状不对而拒绝启动，
 * 模拟服务也必须这样，否则「配置写错了但测试仍通过」才是真正的漏洞。
 * OC-08 起期望值从受控配置本身派生（任意登记供应商集合都成立），
 * 不再硬编码 minimax。
 */
function validateWorkerConfig(): { providers: Record<string, { models?: Record<string, unknown> }>; defaultModel: { providerID: string; modelID: string } } {
  const configPath = process.env["OPENCODE_CONFIG"];
  if (configPath === undefined || configPath.length === 0) fail("missing OPENCODE_CONFIG");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    fail("worker config is not valid JSON");
  }
  const permission = parsed["permission"];
  if (Array.isArray(permission)) {
    fail("config.permission must be a PermissionConfig (string/object), not a PermissionRuleset array");
  }
  if (permission === null || typeof permission !== "object") fail("config.permission must be an object");
  const enabled = parsed["enabled_providers"];
  if (!Array.isArray(enabled) || enabled.length === 0 || enabled.some((id) => typeof id !== "string")) {
    fail("config.enabled_providers must be a non-empty string array");
  }
  const providers = parsed["provider"];
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) fail("config.provider must be an object");
  const providerIds = Object.keys(providers as Record<string, unknown>);
  if (providerIds.length === 0) fail("config.provider must not be empty");
  const enabledSorted = [...(enabled as string[])].sort();
  if (providerIds.join(",") !== enabledSorted.join(",")) {
    fail("config.enabled_providers must match config.provider keys (sorted)");
  }
  const modelRefValue = parsed["model"];
  if (typeof modelRefValue !== "string" || modelRefValue.split("/").length !== 2) fail("config.model must be provider/model");
  if (parsed["small_model"] !== modelRefValue) fail("config.small_model must equal config.model");
  const [defaultProvider, defaultModelId] = (modelRefValue as string).split("/");
  if (defaultProvider === undefined || defaultModelId === undefined || defaultProvider.length === 0 || defaultModelId.length === 0) {
    fail("config.model must be provider/model with non-empty segments");
  }
  if (!providerIds.includes(defaultProvider)) fail("config.model provider must be in config.provider");
  if (Array.isArray(parsed["plugin"]) && parsed["plugin"].length > 0) fail("config.plugin must be empty");
  const mcp = parsed["mcp"];
  if (mcp !== null && typeof mcp === "object" && !Array.isArray(mcp) && Object.keys(mcp).length > 0) {
    fail("config.mcp must be empty");
  }
  return {
    providers: providers as Record<string, { models?: Record<string, unknown> }>,
    defaultModel: { providerID: defaultProvider as string, modelID: defaultModelId as string },
  };
}

const workerConfig = validateWorkerConfig();
activeModel = { ...workerConfig.defaultModel };

/** 供应商配置对象里声明的模型 ID 列表；没有 models 键（或为空）时返回 null。 */
function modelsFromConfig(id: string): string[] | null {
  const entry = workerConfig.providers[id];
  const models = entry?.models;
  if (models === null || typeof models !== "object" || Array.isArray(models)) return null;
  const ids = Object.keys(models);
  return ids.length > 0 ? ids : null;
}

const scenario: Scenario = SCENARIOS[scenarioName] ?? fail(`unknown scenario: ${scenarioName}`);

// ---------------------------------------------------------------- 步骤执行

let timeline: Promise<void> | null = null;

async function runSteps(steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    await delay(step.delay);
    await step.run();
  }
}

function startTimeline(): void {
  if (timeline !== null) return;
  timeline = runSteps(scenario.steps).catch(() => undefined);
}

// ---------------------------------------------------------------- HTTP 服务

function authorized(request: IncomingMessage): boolean {
  if (auth === null) return true;
  return request.headers["authorization"] === auth;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    try {
      response.destroy();
    } catch {
      // ignore
    }
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = `${request.method ?? "GET"} ${url.pathname}`;

  if (!authorized(request)) {
    record({ at: nowMs(), route, authenticated: false });
    json(response, 401, { message: "unauthorized" });
    return;
  }

  if (route === "GET /global/health") {
    record({ at: nowMs(), route, authenticated: true });
    json(response, 200, { healthy: true, version: "1.18.32" });
    return;
  }

  if (route === "GET /provider") {
    record({ at: nowMs(), route, authenticated: true });
    // OC-08：供应商清单从受控配置派生（登记集合与各自声明的模型）；
    // 场景可用 models 覆盖 default 供应商的模型列表（缺模型类故障注入）。
    const providerIds = Object.keys(workerConfig.providers);
    const modelsFor = (id: string): string[] => {
      if (id === workerConfig.defaultModel.providerID && scenario.models !== undefined) {
        return [...scenario.models];
      }
      // 不替供应商“补声明”默认模型：provider 配置没写 models 就是没声明，
      // 启动检查必须能在「default 模型写错/未声明」上失败（与真实 OpenCode 一致）。
      return modelsFromConfig(id) ?? [];
    };
    const all = providerIds.map((id) => ({
      id,
      name: id,
      models: Object.fromEntries(modelsFor(id).map((modelId) => [modelId, { id: modelId }])),
    }));
    json(response, 200, {
      all,
      connected: scenario.connected ?? providerIds,
      default: { [providerIds[0] as string]: modelsFor(providerIds[0] as string)[0] },
    });
    return;
  }

  if (route === "POST /session") {
    const body = await readBody(request);
    record({ at: nowMs(), route, body: JSON.parse(body || "{}") });
    json(response, 200, {
      id: sessionId,
      slug: "fake-session",
      version: "1.18.32",
      projectID: "global",
      directory: process.cwd(),
      path: "fake",
      title: "fake",
      time: { created: nowMs(), updated: nowMs() },
    });
    return;
  }

  if (route === "GET /session/status") {
    record({ at: nowMs(), route });
    json(response, 200, {});
    return;
  }

  if (url.pathname === `/session/${sessionId}` && request.method === "GET") {
    record({ at: nowMs(), route });
    json(response, 200, { id: sessionId, time: { created: nowMs(), updated: nowMs() } });
    return;
  }

  if (url.pathname === `/session/${sessionId}/message` && request.method === "GET") {
    record({
      at: nowMs(),
      route,
      count: messages.length,
      roles: messages.map((message) => message.info["role"]),
      firstId: messages.at(0)?.info["id"] ?? null,
    });
    json(response, 200, messages);
    return;
  }

  if (url.pathname === `/session/${sessionId}/prompt_async` && request.method === "POST") {
    const body = await readBody(request);
    const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    record({ at: nowMs(), route, body: parsed });
    // 服务端必须采用客户端显式给出的 messageID（否则归属就不可信）。
    if (typeof parsed["messageID"] === "string" && parsed["messageID"].startsWith("msg")) {
      activeUserId = parsed["messageID"];
    }
    // OC-08：记录本轮请求的模型；消息身份按它回显（mismatch 场景另行覆盖）。
    const requested = parsed["model"];
    if (requested !== null && typeof requested === "object" && !Array.isArray(requested)) {
      const ref = requested as Record<string, unknown>;
      if (typeof ref["providerID"] === "string" && typeof ref["modelID"] === "string") {
        activeModel = { providerID: ref["providerID"] as string, modelID: ref["modelID"] as string };
      }
    }
    const behaviour = scenario.promptBehaviour ?? "accept";
    if (behaviour === "reject") {
      json(response, 400, { message: "rejected by fake" });
      return;
    }
    if (behaviour === "destroy") {
      response.destroy();
      return;
    }
    if (behaviour === "hang") {
      return;
    }
    response.writeHead(204);
    response.end();
    if (scenario.restartTimelineOnPrompt === true) timeline = null;
    startTimeline();
    return;
  }

  if (url.pathname === `/session/${sessionId}/abort` && request.method === "POST") {
    record({ at: nowMs(), route });
    if (scenario.onAbort === "crash") {
      response.destroy();
      process.kill(process.pid, "SIGKILL");
      return;
    }
    if (scenario.onAbort === "settle") {
      // abort 可能早于 assistant 消息出现（例如 tool 还没开始）：短暂等一下，
      // 让 abort 打在真实存在的消息上，而不是静默什么都不做。
      for (let attempt = 0; attempt < 100 && messageById(M1) === null; attempt += 1) await delay(10);
      const message = messageById(M1);
      if (message !== null) {
        const tool = message.parts.find((part) => part.type === "tool");
        if (tool !== undefined) tool.state = { status: "completed", input: {}, output: "", title: "aborted", metadata: {}, time: { start: nowMs(), end: nowMs() } };
        message.info["finish"] = "stop";
        message.info["error"] = { name: "MessageAbortedError", data: { message: "aborted" } };
        message.info["time"] = { ...(message.info["time"] as Record<string, unknown>), completed: nowMs() };
        pushEvent("message.updated", { sessionID: sessionId, info: message.info });
        pushEvent("message.part.updated", { sessionID: sessionId, part: tool });
      }
      pushEvent("session.idle", { sessionID: sessionId });
    }
    json(response, 200, scenario.abortsAcknowledged !== false);
    return;
  }

  if (url.pathname === "/permission" && request.method === "GET") {
    record({ at: nowMs(), route });
    json(response, 200, permissions);
    return;
  }

  const replyMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
  if (replyMatch !== null && request.method === "POST") {
    const requestId = replyMatch[1] as string;
    const body = await readBody(request);
    const parsed = JSON.parse(body || "{}") as { reply?: string };
    record({ at: nowMs(), route, requestId, reply: parsed.reply ?? null });
    const index = permissions.findIndex((item) => item["id"] === requestId);
    if (index >= 0) permissions.splice(index, 1);
    json(response, 200, true);
    const followUp = scenario.onReply?.[parsed.reply ?? "reject"] ?? [];
    void runSteps(followUp);
    return;
  }

  if (url.pathname === "/event" && request.method === "GET") {
    record({ at: nowMs(), route });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", properties: {} })}\n\n`);
    sseClients.add(response);
    request.on("close", () => sseClients.delete(response));
    return;
  }

  record({ at: nowMs(), route, unmatched: true });
  json(response, 404, { message: "not found" });
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  // 与真实 opencode serve 的输出形状一致：adapter 从 stdout 解析地址。
  process.stdout.write(`opencode server listening on http://${announceHost}:${port}\n`);
  if (scenario.autoStart === true) startTimeline();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const client of sseClients) client.end();
    server.close();
    process.exit(0);
  });
}
