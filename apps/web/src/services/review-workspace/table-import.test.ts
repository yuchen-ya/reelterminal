import { describe, expect, it } from "vitest";
import { decodeReviewText, parseReviewCsv, parseReviewJson } from "./table-import";

describe("review table inputs", () => {
  it("preserves quoted commas, line breaks, whitespace and duplicate column names", () => {
    const data = parseReviewCsv('\ufeffname,name\r\n"A, B","line 1\nline 2"\r\n  kept  ,""\r\n');
    expect(data.columns.map(column => column.title)).toEqual(["name", "name"]);
    expect(data.columns[0].columnId).not.toBe(data.columns[1].columnId);
    expect(data.rows.map(row => data.columns.map(column => row.cells[column.columnId]))).toEqual([["A, B", "line 1\nline 2"], ["  kept  ", ""]]);
    expect(() => parseReviewCsv('a,b\n"unterminated,b')).toThrow();
  });

  it("keeps JSON null distinct from empty text and rejects unsafe numbers and nested cells", () => {
    const data = parseReviewJson('[{"text":"","value":null},{"text":"001","value":12.5}]');
    expect(data.rows.map(row => data.columns.map(column => row.cells[column.columnId]))).toEqual([["", null], ["001", "12.5"]]);
    expect(() => parseReviewJson('[{"value":9007199254740993}]')).toThrow("大整数");
    expect(() => parseReviewJson('[{"value":{"hidden":true}}]')).toThrow("单元格");
  });

  it("decodes BOM text explicitly and rejects malformed UTF-8", () => {
    expect(decodeReviewText(new Uint8Array([255, 254, 65, 0, 13, 0, 10, 0]).buffer)).toBe("A\r\n");
    expect(() => decodeReviewText(new Uint8Array([255, 128, 128]).buffer)).toThrow("编码");
  });
});
