import { parse } from "csv-parse/browser/esm/sync";
import { WORKBENCH_MAX_ROWS_PER_DATASET } from "@reelterminal/core/types/workbench";
import type { WorkbenchContentInput } from "@reelterminal/agent-facade";
import { reviewError } from "./guards";

type DataInput = Extract<WorkbenchContentInput, { type: "data" }>;
function table(headers: readonly string[], values: readonly (readonly (string | null)[])[]): DataInput {
  if (!headers.length || headers.length > 64 || !values.length || values.length > WORKBENCH_MAX_ROWS_PER_DATASET) throw reviewError("INVALID_PARAMS", "表格需要 1–64 列和 1–5000 行数据");
  const columns = headers.map((title, index) => ({ columnId: crypto.randomUUID(), title: title || `列 ${index + 1}` }));
  return { type: "data", datasetId: crypto.randomUUID(), columns, proposals: [], rows: values.map(row => {
    if (row.length !== columns.length) throw reviewError("INVALID_PARAMS", "表格每行的列数必须一致");
    return { rowId: crypto.randomUUID(), cells: Object.fromEntries(columns.map((column, index) => [column.columnId, row[index]])) };
  }) };
}

/** Use csv-parse's browser distribution; preserve cell whitespace and quoted newlines. */
export function parseReviewCsv(text: string): DataInput {
  let count = 0;
  const records = parse(text, { bom: true, max_record_size: 200_000, on_record: record => {
    if (++count > WORKBENCH_MAX_ROWS_PER_DATASET + 1) throw reviewError("INVALID_PARAMS", "CSV 超过 5000 行数据，请拆分后导入");
    return record;
  } });
  if (records.length < 2) throw reviewError("INVALID_PARAMS", "CSV 第一行是列名，后面至少需要一行数据");
  return table(records[0], records.slice(1));
}

/** JSON input is an array of flat records. Native source bytes remain separately retained. */
export function parseReviewJson(text: string): DataInput {
  let records: unknown;
  try { records = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw reviewError("INVALID_PARAMS", "JSON 格式无效"); throw error; }
  if (!Array.isArray(records) || !records.length || records.length > WORKBENCH_MAX_ROWS_PER_DATASET || records.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw reviewError("INVALID_PARAMS", "JSON 需要包含 1–5000 个对象的数组");
  const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
  const values = records.map(row => headers.map(key => {
    const value: unknown = row[key];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
    throw reviewError("INVALID_PARAMS", "JSON 单元格仅支持文本、布尔值、有限数值或 null；大整数请写成字符串");
  }));
  return table(headers, values);
}

export function decodeReviewText(bytes: ArrayBuffer): string {
  const prefix = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const encoding = prefix[0] === 255 && prefix[1] === 254 ? "utf-16le" : prefix[0] === 254 && prefix[1] === 255 ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (error) { if (error instanceof TypeError) throw reviewError("INVALID_PARAMS", "文本需要使用 UTF-8，或带 BOM 的 UTF-16 编码"); throw error; }
}
