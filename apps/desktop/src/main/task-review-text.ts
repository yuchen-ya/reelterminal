import type { TaskTextReviewUnit, TaskTextFormat } from '../shared/task-review';

export type ParsedTaskUnit = Omit<TaskTextReviewUnit, 'id' | 'sourceVersionId'>;
const timing = /^(\d{2,}:)?(\d{2}):(\d{2})[.,](\d{3})$/;

function milliseconds(value: string): number {
  const match = timing.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw new Error('Invalid subtitle timestamp');
  return ((Number(match[1]?.slice(0, -1) ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

export function parseTaskText(text: string, format: TaskTextFormat): ParsedTaskUnit[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (format === 'txt' || format === 'md')
    return lines.flatMap((line, index) => line.trim() ? [{ ordinal: index + 1, text: line, startLine: index + 1, endLine: index + 1 }] : []);
  if (format === 'vtt' && !/^WEBVTT(?:[ \t].*)?$/.test(lines[0])) throw new Error('Missing WEBVTT header');
  const units: ParsedTaskUnit[] = [];
  let position = format === 'vtt' ? 1 : 0;
  while (position < lines.length) {
    if (!lines[position].trim()) { position++; continue; }
    const start = position;
    const block: string[] = [];
    while (position < lines.length && lines[position].trim()) block.push(lines[position++]);
    if (format === 'vtt' && /^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(block[0])) continue;
    const timingIndex = block[0].includes('-->') ? 0 : 1;
    const match = /^(\S+)\s+-->\s+(\S+)(?:[ \t]+(.*))?$/.exec(block[timingIndex] ?? '');
    if (!match || block.length <= timingIndex + 1) throw new Error(`Invalid subtitle cue near line ${start + 1}`);
    const startMs = milliseconds(match[1]);
    const endMs = milliseconds(match[2]);
    if (endMs <= startMs) throw new Error('Subtitle end must follow its start');
    units.push({ ordinal: units.length + 1, text: block.slice(timingIndex + 1).join('\n'), startLine: start + 1, endLine: position, startMs, endMs, ...(match[3] ? { cueSettings: match[3] } : {}) });
  }
  return units;
}

function stamp(value: number, format: TaskTextFormat): string {
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value / 60000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(value % 1000).padStart(3, '0')}`;
}

export function renderTaskText(units: TaskTextReviewUnit[], format: TaskTextFormat): string {
  if (format === 'txt' || format === 'md') return units.map(unit => unit.text).join('\n') + '\n';
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + units.map((unit, index) =>
    `${index + 1}\n${stamp(unit.startMs!, format)} --> ${stamp(unit.endMs!, format)}${unit.cueSettings ? ` ${unit.cueSettings}` : ''}\n${unit.text}\n`,
  ).join('\n');
}
