import { t as translate } from "../../i18n";
import { uiMessage as canonicalMessage } from "../../i18n/messages";
import { parse } from "csv-parse/browser/esm/sync";
import { WORKBENCH_MAX_ROWS_PER_DATASET } from "@reelterminal/core/types/workbench";
import type { WorkbenchContentInput } from "@reelterminal/agent-facade";
import { reviewError } from "./guards";

type DataInput = Extract<WorkbenchContentInput, { type: "data" }>;
function table(headers: readonly string[], values: readonly (readonly (string | null)[])[]): DataInput {
  if (!headers.length || headers.length > 64 || !values.length || values.length > WORKBENCH_MAX_ROWS_PER_DATASET) throw reviewError("INVALID_PARAMS", canonicalMessage("A table requires 1–64 columns and 1–5000 data rows"));
  const columns = headers.map((title, index) => ({ columnId: crypto.randomUUID(), title: title || translate("Column {{v0}}", { v0: index + 1 }) }));
  return { type: "data", datasetId: crypto.randomUUID(), columns, proposals: [], rows: values.map(row => {
    if (row.length !== columns.length) throw reviewError("INVALID_PARAMS", canonicalMessage("Every table row must have the same number of columns"));
    return { rowId: crypto.randomUUID(), cells: Object.fromEntries(columns.map((column, index) => [column.columnId, row[index]])) };
  }) };
}

/** Use csv-parse's browser distribution; preserve cell whitespace and quoted newlines. */
export function parseReviewCsv(text: string): DataInput {
  let count = 0;
  const records = parse(text, { bom: true, max_record_size: 200_000, on_record: record => {
    if (++count > WORKBENCH_MAX_ROWS_PER_DATASET + 1) throw reviewError("INVALID_PARAMS", canonicalMessage("CSV exceeds 5000 data rows; split it before importing"));
    return record;
  } });
  if (records.length < 2) throw reviewError("INVALID_PARAMS", canonicalMessage("The first CSV row contains column names and must be followed by at least one data row"));
  return table(records[0], records.slice(1));
}

/** JSON input is an array of flat records. Native source bytes remain separately retained. */
export function parseReviewJson(text: string): DataInput {
  let records: unknown;
  try { records = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw reviewError("INVALID_PARAMS", canonicalMessage("Invalid JSON format")); throw error; }
  if (!Array.isArray(records) || !records.length || records.length > WORKBENCH_MAX_ROWS_PER_DATASET || records.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw reviewError("INVALID_PARAMS", canonicalMessage("JSON must contain an array of 1–5000 objects"));
  const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
  const values = records.map(row => headers.map(key => {
    const value: unknown = row[key];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
    throw reviewError("INVALID_PARAMS", canonicalMessage("JSON cells support only text, booleans, finite numbers or null; encode large integers as strings"));
  }));
  return table(headers, values);
}

export function decodeReviewText(bytes: ArrayBuffer): string {
  const prefix = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const encoding = prefix[0] === 255 && prefix[1] === 254 ? "utf-16le" : prefix[0] === 254 && prefix[1] === 255 ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (error) { if (error instanceof TypeError) throw reviewError("INVALID_PARAMS", canonicalMessage("Text must use UTF-8 or UTF-16 with a BOM")); throw error; }
}
