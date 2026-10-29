/**
 * OC-09 管理状态：配置项与私有文件的内部指纹。
 *
 * 只用于比较「磁盘配置」与「daemon 已加载快照」是否一致；哈希本身不是凭据，
 * 也不输出文件内容。OpenCode 的 executable/providerConfigFile 单独比较：
 * 它们可能来自本次命令行的兼容覆盖，不能误判为已写回配置。
 */
import { readFileSync } from "node:fs";
import type { BackendConfigEntry } from "../contracts/config.ts";
import { canonicalJson, sha256Hex } from "../contracts/json.ts";
import { OPENCODE_ADAPTER_ID } from "../contracts/version.ts";

/** OpenCode 配置项中由启动覆盖单独比较的字段。 */
const OPENCODE_OVERRIDE_FIELDS = new Set(["executable", "providerConfigFile"]);

export function backendEntryFingerprint(entry: BackendConfigEntry): string {
  if (entry.adapter === OPENCODE_ADAPTER_ID) {
    const normalized = Object.fromEntries(
      Object.entries(entry).filter(([key]) => !OPENCODE_OVERRIDE_FIELDS.has(key)),
    );
    return sha256Hex(canonicalJson(normalized));
  }
  return sha256Hex(canonicalJson(entry));
}

/** 供应商配置的语义摘要：对象键顺序不同但内容相同视为一致。 */
export function providerEntriesDigest(entries: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson(entries));
}

/**
 * 私有文件摘要：优先按 JSON 语义规范化，非 JSON 文件按原文哈希。
 * 不可读时返回固定标记，让两侧都得到相同结果，而不是抛错。
 */
export function privateFileDigest(path: string | null): string | null {
  if (path === null) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "unreadable";
  }
  try {
    return `json:${sha256Hex(canonicalJson(JSON.parse(text)))}`;
  } catch {
    return `raw:${sha256Hex(text)}`;
  }
}
