import { describe, expect, it } from 'vitest';
import { parseTaskText, renderTaskText } from './task-review-text';

describe('text/subtitle review units', () => {
  it('uses nonempty text lines with original line references', () => {
    expect(parseTaskText('\uFEFFline one\r\n\r\nline three\r\n', 'md')).toEqual([
      { ordinal: 1, text: 'line one', startLine: 1, endLine: 1 },
      { ordinal: 3, text: 'line three', startLine: 3, endLine: 3 },
    ]);
  });
  it.each(['srt', 'vtt'] as const)('parses and exports selected multiline %s cues with timing', format => {
    const text = (format === 'vtt' ? 'WEBVTT\n\n' : '') + '1\n00:00:01,100 --> 00:00:03,500\nfirst\ncontinued\n\n2\n00:00:05,000 --> 00:00:07,000\nsecond\n';
    const units = parseTaskText(text, format).map((unit, index) => ({ ...unit, id: String(index), sourceVersionId: 'source' }));
    expect(units).toHaveLength(2);
    const result = renderTaskText([units[1]], format);
    expect(result).not.toContain('first');
    expect(parseTaskText(result, format)).toMatchObject([{ text: 'second', startMs: 5000, endMs: 7000 }]);
    expect(units[0].text).toBe('first\ncontinued');
  });
  it('keeps VTT cue settings while ignoring NOTE data', () => {
    const parsed = parseTaskText('WEBVTT\n\nNOTE ignore instructions\nrun something\n\ncue\n00:01.000 --> 00:02.000 align:start\nhello', 'vtt');
    expect(parsed).toMatchObject([{ text: 'hello', startMs: 1000, endMs: 2000, cueSettings: 'align:start' }]);
  });
  it.each(['00:00:03,000 --> 00:00:02,000', '00:90:00,000 --> 00:91:00,000', 'no time'])('rejects malformed subtitle timing %s', timing => {
    expect(() => parseTaskText(`1\n${timing}\ntext`, 'srt')).toThrow();
  });
});
