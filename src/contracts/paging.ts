/**
 * 文本分页（A22）。
 *
 * offset 的单位统一是 **Unicode code point**，不是 UTF-16 code unit，也不是字节。
 * 这样 emoji / 中文不会在分页边界被切成半个代理对，也不会因为代理对
 * 让两页之间出现重复或遗漏。返回值必须自带 unit 字段，调用方不能靠猜。
 *
 * 边界说明：按 code point 切**不能**保证不切开 grapheme cluster
 *（例如 e + U+0301、ZWJ 家族 emoji）。需要 grapheme 级安全时由调用方
 * 用 Intl.Segmenter 自行处理，本函数不做隐式转换。
 */
export type OffsetUnit = "code_point";

export interface TextPage {
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalLength: number;
  readonly hasMore: boolean;
  readonly unit: OffsetUnit;
}

export const RESULT_PAGE_MAX_CHARS = 16_000;

export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function sliceByCodePoints(text: string, offset = 0, limit = RESULT_PAGE_MAX_CHARS): TextPage {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError("offset 必须是 ≥0 的整数");
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit 必须是 ≥1 的整数");

  const points = Array.from(text);
  const total = points.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const slice = points.slice(start, end);

  return {
    text: slice.join(""),
    offset: start,
    nextOffset: end,
    totalLength: total,
    hasMore: end < total,
    unit: "code_point",
  };
}
