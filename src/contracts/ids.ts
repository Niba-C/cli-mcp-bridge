/**
 * 业务 ID 的唯一生成/校验入口。
 *
 * 设计要点（技术规格 §2）：
 * - 前缀让日志和 IPC 里能一眼分辨实体，避免把 sessionId / backendSessionId 混为一谈；
 * - 校验必须严格，外部传入的字符串只能通过 parseXxx 进入系统，不能直接断言成类型。
 */
import { randomUUID } from "node:crypto";

export const ID_PREFIX = {
  principal: "prn",
  workspace: "ws",
  session: "ses",
  run: "run",
  directive: "dir",
  approval: "apr",
  input: "inp",
  artifact: "art",
} as const;

export type IdKind = keyof typeof ID_PREFIX;
export type Id<K extends IdKind> = `${(typeof ID_PREFIX)[K]}_${string}`;

export type PrincipalId = Id<"principal">;
export type WorkspaceId = Id<"workspace">;
export type SessionId = Id<"session">;
export type RunId = Id<"run">;
export type DirectiveId = Id<"directive">;
export type ApprovalId = Id<"approval">;
export type InputRequestId = Id<"input">;
export type ArtifactId = Id<"artifact">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function build(kind: IdKind, body: string): string {
  return `${ID_PREFIX[kind]}_${body}`;
}

/**
 * 生成 ID。`uuid` 参数只用于测试和确定性回放，生产调用不要传。
 * 传入非法 uuid 会直接抛错，避免把脏值写进数据库。
 */
export function newId<K extends IdKind>(kind: K, uuid: string = randomUUID()): Id<K> {
  if (!UUID_RE.test(uuid)) {
    throw new TypeError(`newId(${kind}): uuid 形状非法`);
  }
  return build(kind, uuid) as Id<K>;
}

/** 类型守卫：只接受「前缀 + 标准 uuid」这一种形状。 */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIX[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  return UUID_RE.test(value.slice(prefix.length));
}

export class InvalidIdError extends TypeError {
  readonly kind: IdKind;
  constructor(kind: IdKind, _value: unknown) {
    // 不回显原始值：外部 ID 可能夹带路径或用户输入片段，日志里只需知道形状不对。
    super(`invalid ${kind} id`);
    this.name = "InvalidIdError";
    this.kind = kind;
  }
}

export function parseId<K extends IdKind>(kind: K, value: unknown): Id<K> {
  if (!isId(kind, value)) throw new InvalidIdError(kind, value);
  return value;
}

/** 外部 ID → 探测实体类型；用于「不属于本主体的 ID 一律 NOT_FOUND」的格式判定。 */
export function detectIdKind(value: unknown): IdKind | null {
  if (typeof value !== "string") return null;
  for (const kind of Object.keys(ID_PREFIX) as IdKind[]) {
    if (isId(kind, value)) return kind;
  }
  return null;
}
