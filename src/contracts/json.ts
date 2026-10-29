/**
 * 规范化 JSON 与哈希。
 *
 * 审批绑定、幂等 receipt、工件清单都依赖「同一份语义 → 同一个哈希」。
 * 规则（写进技术规格 §7 的规范化要求）：
 * - 对象键按 UTF-16 码元升序排序（不用 locale 比较，避免环境差异）；
 * - 数组顺序原样保留，字符串原样保留（不 trim、不重排 shell 引号——那会改变执行含义）；
 * - 只接受 JSON 能无损表示的类型，Date/Map/undefined/NaN/BigInt/函数 一律抛错，
 *   不允许「静默丢弃字段」导致哈希与真实执行参数不一致。
 */
import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${path}: 非有限数字不能进入规范化 JSON`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${path}: 不支持的类型 ${typeof value}`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`${path}: 存在循环引用`);
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, index) => encode(item, `${path}[${index}]`, seen));
      return `[${parts.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`${path}: 只接受普通对象，收到 ${obj.constructor?.name ?? "未知类型"}`);
    }

    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys.map((key) => {
      const child = (obj as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new CanonicalJsonError(`${path}.${key}: undefined 不允许出现，请显式省略该字段`);
      }
      return `${JSON.stringify(key)}:${encode(child, `${path}.${key}`, seen)}`;
    });
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** 确定性序列化。同一语义结构在不同进程、不同键插入顺序下输出字节完全相同。 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set<object>());
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 规范哈希的对外表示：带算法前缀，便于将来替换而不破坏已有记录。 */
export function payloadHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** 深拷贝到纯 JSON 结构，同时触发一次规范化校验（拒绝不支持的类型）。 */
export function toJsonValue<T>(value: T): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}
