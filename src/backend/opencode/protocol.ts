/**
 * OpenCode 1.18.32 的纯协议映射（无 IO）。
 *
 * 这里只做三件事：把已采集样本里的 JSON 收敛成内部形状、按显式 ID 做归属、
 * 把状态字段翻译成产品词汇。任何网络、进程或存储动作都不在这里。
 *
 * 归属规则（技术规格 §3、§6）刻意不用「最后一条消息」：
 * - 用户消息必须是 `id === 本 run 显式 messageID` 且 `role === "user"`；
 * - assistant 必须是 `parentID === 该 messageID` 且 `sessionID` 相同。
 * 剩余任何 assistant（例如同一会话里其他 run 的回复）都不参与本 run 的判定。
 */

export const OPENCODE_API = {
  health: "/global/health",
  event: "/event",
  provider: "/provider",
  session: "/session",
  sessionStatus: "/session/status",
  permission: "/permission",
} as const;

export function sessionPath(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`;
}

export function messagesPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/message`;
}

export function promptAsyncPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/prompt_async`;
}

export function abortPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/abort`;
}

export function permissionReplyPath(requestId: string): string {
  return `/permission/${encodeURIComponent(requestId)}/reply`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 工具状态。`unknown` 表示「有工具 part，但状态缺失或无法识别」——
 * 绝不能当成已结束：那会让 finish=stop 误报成功。
 */
export const TOOL_STATES = ["pending", "running", "completed", "error", "unknown"] as const;
export type OpencodeToolState = (typeof TOOL_STATES)[number];

function asToolState(value: unknown): OpencodeToolState {
  return value === "pending" || value === "running" || value === "completed" || value === "error"
    ? value
    : "unknown";
}

export const PART_TYPES = ["text", "reasoning", "tool", "step-start", "step-finish"] as const;

export interface OpencodePart {
  readonly id: string;
  readonly messageId: string;
  readonly type: string;
  /** 只有 `type === "text"` 且非 synthetic/ignored 时才算 assistant 正文。 */
  readonly text: string | null;
  readonly callId: string | null;
  readonly toolName: string | null;
  /** 缺状态或状态无法识别时是 `unknown`，不是 null。 */
  readonly toolState: OpencodeToolState;
  readonly toolInput: Record<string, unknown> | null;
  readonly synthetic: boolean;
  readonly ignored: boolean;
}

export interface OpencodeMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly parentId: string | null;
  readonly createdMs: number | null;
  readonly completedMs: number | null;
  readonly finish: string | null;
  readonly errorName: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** assistant 自报的 token 用量；缺失为 null（不是 0）。 */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly parts: readonly OpencodePart[];
}

export interface ParsedMessages {
  readonly messages: readonly OpencodeMessage[];
  readonly skipped: number;
}

function parsePart(raw: unknown, messageId: string): OpencodePart | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = str(record["id"]);
  const type = str(record["type"]);
  if (id === null || type === null) return null;
  const state = asRecord(record["state"]);
  return {
    id,
    messageId: str(record["messageID"]) ?? messageId,
    type,
    text: str(record["text"]),
    callId: str(record["callID"]),
    toolName: str(record["tool"]),
    toolState: state === null ? "unknown" : asToolState(state["status"]),
    toolInput: state === null ? null : asRecord(state["input"]),
    synthetic: record["synthetic"] === true,
    ignored: record["ignored"] === true,
  };
}

function parseMessage(raw: unknown): OpencodeMessage | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const info = asRecord(record["info"]);
  if (info === null) return null;
  const id = str(info["id"]);
  const sessionId = str(info["sessionID"]);
  const role = str(info["role"]);
  if (id === null || sessionId === null) return null;
  if (role !== "user" && role !== "assistant") return null;
  const time = asRecord(info["time"]);
  const error = asRecord(info["error"]);
  const tokens = asRecord(info["tokens"]);
  // 用户消息把模型放在 `model` 子对象里；assistant 用顶层 providerID/modelID。
  const model = asRecord(info["model"]);
  const partsRaw = asArray(record["parts"]);
  const parts: OpencodePart[] = [];
  for (const partRaw of partsRaw) {
    const part = parsePart(partRaw, id);
    if (part !== null) parts.push(part);
  }
  return {
    id,
    sessionId,
    role,
    parentId: str(info["parentID"]),
    createdMs: time === null ? null : num(time["created"]),
    completedMs: time === null ? null : num(time["completed"]),
    finish: str(info["finish"]),
    errorName: error === null ? null : str(error["name"]),
    providerId: str(info["providerID"]) ?? (model === null ? null : str(model["providerID"])),
    modelId: str(info["modelID"]) ?? (model === null ? null : str(model["modelID"])),
    inputTokens: tokens === null ? null : num(tokens["input"]),
    outputTokens: tokens === null ? null : num(tokens["output"]),
    parts,
  };
}

/** 解析 `GET /session/{id}/message` 的响应；坏条目计数而不是静默丢弃。 */
export function parseMessageList(raw: unknown): ParsedMessages {
  const list = asArray(raw);
  const messages: OpencodeMessage[] = [];
  let skipped = 0;
  for (const item of list) {
    const parsed = parseMessage(item);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    messages.push(parsed);
  }
  return { messages, skipped };
}

export interface Attribution {
  readonly user: OpencodeMessage | null;
  /** 归属本 run 的 assistant 消息，按创建时间稳定排序。 */
  readonly assistants: readonly OpencodeMessage[];
  /** 历史里确实存在本 run 的用户消息。 */
  readonly confirmed: boolean;
  /** 存在相同 ID 但角色/会话不符的消息：出现即视为协议异常。 */
  readonly conflict: boolean;
}

/**
 * 按显式 messageID + parentID + sessionID 归属；与时间、顺序、其他 run 无关。
 */
export function attributeRun(
  messages: readonly OpencodeMessage[],
  input: { readonly sessionId: string; readonly userMessageId: string },
): Attribution {
  const user = messages.find((message) => message.id === input.userMessageId) ?? null;
  const conflict = user !== null && (user.role !== "user" || user.sessionId !== input.sessionId);
  if (user === null || conflict) {
    // 用户消息缺失时，任何 assistant 都不能算作本 run 的证据。
    return { user: null, assistants: [], confirmed: false, conflict };
  }
  const assistants = messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.parentId === input.userMessageId &&
        message.sessionId === input.sessionId,
    )
    .slice()
    .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { user, assistants, confirmed: true, conflict: false };
}

export interface ToolObservation {
  readonly callId: string;
  readonly toolName: string;
  readonly state: OpencodeToolState;
}

export interface ToolSummary {
  /** 仍可能产生副作用：pending／running／状态缺失都算未结束。 */
  readonly pending: boolean;
  readonly observations: readonly ToolObservation[];
  /** 同一 callID 在多个 assistant 消息里重复出现时，以最后一次状态为准。 */
  readonly anyError: boolean;
  /** 存在状态缺失／无法识别的工具：证据不足，不能宣称工具已结束。 */
  readonly unconfirmed: boolean;
}

/**
 * 跨多段 assistant 消息归集工具状态（tool-calls 之后常有多条 assistant）。
 *
 * 关键：坏条目不能被「悄悄丢掉」。有 `callID` 但没有可识别状态的 tool part
 * 记为 `unknown` 并保持 pending，宁可让 run 收敛为 unknown，也不能把
 * `toolsPending=false` 当成「工具都已结束」。
 */
export function collectTools(assistants: readonly OpencodeMessage[]): ToolSummary {
  const byCall = new Map<string, ToolObservation>();
  for (const message of assistants) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      // 连 callID 都缺的坏 part 也要占位，避免被当成「没有工具」。
      const callId = part.callId ?? `part:${part.id}`;
      byCall.set(callId, {
        callId,
        toolName: part.toolName ?? "unknown",
        state: part.toolState,
      });
    }
  }
  const observations = [...byCall.values()];
  return {
    pending: observations.some((item) => item.state !== "completed" && item.state !== "error"),
    observations,
    anyError: observations.some((item) => item.state === "error"),
    unconfirmed: observations.some((item) => item.state === "unknown"),
  };
}

/** 只取 assistant 的正文 part：排除 reasoning、synthetic 与 ignored。 */
export function assistantTextParts(message: OpencodeMessage): readonly OpencodePart[] {
  return message.parts.filter(
    (part) => part.type === "text" && part.synthetic !== true && part.ignored !== true,
  );
}

export function assistantText(assistants: readonly OpencodeMessage[]): string {
  const chunks: string[] = [];
  for (const message of assistants) {
    for (const part of assistantTextParts(message)) {
      if (part.text !== null && part.text.length > 0) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

/** 最后一条归属 assistant 的消息级字段；没有 assistant 时全部为 null。 */
export function lastAssistantFields(assistants: readonly OpencodeMessage[]): {
  readonly finish: string | null;
  readonly errorName: string | null;
  readonly messageCompleted: boolean;
  readonly providerId: string | null;
  readonly modelId: string | null;
} {
  const last = assistants.at(-1) ?? null;
  if (last === null) {
    return { finish: null, errorName: null, messageCompleted: false, providerId: null, modelId: null };
  }
  return {
    finish: last.finish,
    errorName: last.errorName,
    messageCompleted: last.completedMs !== null,
    providerId: last.providerId,
    modelId: last.modelId,
  };
}

export interface RawPermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly command: string | null;
  readonly diff: string | null;
  readonly toolMessageId: string | null;
  readonly toolCallId: string | null;
}

export interface ParsedPermissions {
  readonly requests: readonly RawPermissionRequest[];
  readonly skipped: number;
}

export function parsePermissionList(raw: unknown): ParsedPermissions {
  const requests: RawPermissionRequest[] = [];
  let skipped = 0;
  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) {
      skipped += 1;
      continue;
    }
    const id = str(record["id"]);
    const sessionId = str(record["sessionID"]);
    const permission = str(record["permission"]);
    if (id === null || sessionId === null || permission === null) {
      skipped += 1;
      continue;
    }
    const metadata = asRecord(record["metadata"]);
    const tool = asRecord(record["tool"]);
    requests.push({
      id,
      sessionId,
      permission,
      patterns: asArray(record["patterns"]).map((value) => str(value)).filter((value): value is string => value !== null),
      command: metadata === null ? null : str(metadata["command"]),
      diff: metadata === null ? null : str(metadata["diff"]),
      toolMessageId: tool === null ? null : str(tool["messageID"]),
      toolCallId: tool === null ? null : str(tool["callID"]),
    });
  }
  return { requests, skipped };
}

const TOOL_PERMISSIONS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "bash",
  "shell",
  "execute",
  "webfetch",
  "fetch",
  "mcp",
]);

/**
 * 权限种类分类。本机实测只有 edit 与 bash；其余名字保留为 unknown，
 * 让操作者看到「未分类」而不是被误当成常规工具授权。
 */
export function classifyPermission(permission: string): "tool_permission" | "unknown" {
  return TOOL_PERMISSIONS.has(permission) ? "tool_permission" : "unknown";
}

const MAX_ARGUMENT_TEXT = 16_384;

/** 决策所需的参数文本；只进受保护存储，不进普通日志。 */
export function approvalArgumentsText(request: RawPermissionRequest): string {
  const lines: string[] = [`permission: ${request.permission}`];
  if (request.command !== null && request.command.length > 0) lines.push(`command: ${request.command}`);
  if (request.patterns.length > 0) lines.push(`patterns: ${request.patterns.join(", ")}`);
  if (request.toolCallId !== null) lines.push(`callID: ${request.toolCallId}`);
  if (request.diff !== null && request.diff.length > 0) lines.push(`diff:\n${request.diff}`);
  const text = lines.join("\n");
  return text.length > MAX_ARGUMENT_TEXT ? `${text.slice(0, MAX_ARGUMENT_TEXT)}…[truncated]` : text;
}

export function approvalTargetPaths(request: RawPermissionRequest): readonly string[] {
  return request.patterns.filter((pattern) => pattern.trim().length > 0).slice(0, 32);
}

export type SessionStatusKind = "idle" | "busy" | "retry" | "absent";

/** `GET /session/status` 只作调度提示：缺项不等于完成，busy 也不等于有进展。 */
export function parseSessionStatus(raw: unknown, sessionId: string): SessionStatusKind {
  const record = asRecord(raw);
  if (record === null) return "absent";
  const entry = asRecord(record[sessionId]);
  if (entry === null) return "absent";
  const type = str(entry["type"]);
  if (type === "idle" || type === "busy" || type === "retry") return type;
  return "absent";
}

const MESSAGE_ID_RE = /^msg[A-Za-z0-9_-]*$/;

export function isBackendMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value) && value.length <= 96;
}

/**
 * 生成本 run 的用户消息 ID（显式传给 prompt_async）。
 *
 * 前缀 + 毫秒时间戳十六进制 + 随机段：满足 OpenAPI 的 `^msg` 约束，并且
 * 大致按时间排序，便于与历史消息对账。它只用于归属，不承担幂等保证。
 */
let lastMessageTimestamp = -1;
let messageCounter = 0;

/** 与固定版本 id/id.ts 的低 48 位时间编码一致，不能直接拼普通毫秒 hex。 */
export function newUserMessageId(nowMs: number, randomHex: string): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError("消息时间戳必须是有限非负数");
  const timestamp = Math.max(Math.floor(nowMs), lastMessageTimestamp);
  if (timestamp !== lastMessageTimestamp) {
    lastMessageTimestamp = timestamp;
    messageCounter = 0;
  }
  messageCounter += 1;
  if (messageCounter >= 0x1000) {
    lastMessageTimestamp += 1;
    messageCounter = 1;
  }
  const encoded = (BigInt(lastMessageTimestamp) * 0x1000n + BigInt(messageCounter)) & 0xffffffffffffn;
  const suffix = randomHex.replace(/[^0-9a-f]/gi, "").slice(0, 14).padEnd(14, "0");
  return `msg_${encoded.toString(16).padStart(12, "0")}${suffix}`;
}

/** 事件 ID 只用于去重；缺失时返回 null，不能编造一个 ID。 */
export function eventIdOf(raw: unknown): string | null {
  const record = asRecord(raw);
  return record === null ? null : str(record["id"]);
}
