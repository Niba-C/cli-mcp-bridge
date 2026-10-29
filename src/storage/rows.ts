/**
 * SQLite 行读取的最小类型收窄工具。
 *
 * `node:sqlite` 返回 `Record<string, SQLOutputValue>`；直接断言会掩盖 schema 与代码
 * 漂移。这里对每个字段做显式检查，错误信息只包含列名，不回显值（值可能含用户内容）。
 */
import { ZBridgeError } from "../contracts/errors.ts";

export type SqlRow = Record<string, unknown>;

function fail(column: string, expected: string): never {
  throw new ZBridgeError("INVALID_ARGUMENT", `数据库列 ${column} 不是预期的 ${expected}`, {
    details: { column, expected },
  });
}

export function str(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") fail(column, "TEXT");
  return value;
}

export function num(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") fail(column, "INTEGER");
  return value;
}

export function nullableStr(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") fail(column, "TEXT|null");
  return value;
}

export function nullableNum(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "number") fail(column, "INTEGER|null");
  return value;
}

/** SQLite 没有布尔类型；写入前统一转 0/1，避免把 JS boolean 直接绑参。 */
export function boolInt(value: boolean): number {
  return value ? 1 : 0;
}
