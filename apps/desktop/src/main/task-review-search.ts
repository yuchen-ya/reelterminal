import { z } from 'zod';
import { isCurrentTaskUnit, isTextTaskUnit, type TaskReviewSnapshot, type TaskTextReviewUnit } from '../shared/task-review';
import type { TaskSearchScope } from '../shared/task-review-runtime-types';
import { isTaskModelInputScopeCurrent, type TaskEvidenceRef } from '../shared/task-review-context';
import { isTaskIssueCurrent } from '../shared/task-review-selectors';
import { parseTaskModelJSON, taskModelEvidenceSchema, taskModelReferences, taskModelTargetFields } from './task-review-model-references';
import { TaskModelError } from './task-review-provider';

const MAX_CANDIDATES = 24;
const MAX_TEXT_CHARS = 24000;
const MAX_EXCERPT_CHARS = 1600;
const expansionSchema = z.object({ terms: z.array(z.string().trim().min(1).max(60)).max(8) });
const matchSchema = z.object({ matches: z.array(z.object({ ...taskModelTargetFields, reason: z.string().trim().min(1).max(500), sourceRefs: z.array(taskModelEvidenceSchema).min(1).max(3) })).max(20) });

export function taskSearchUnits(snapshot: TaskReviewSnapshot, allowedSourceVersionIds: readonly string[], scope: TaskSearchScope): TaskTextReviewUnit[] {
  const allowed = new Set(allowedSourceVersionIds);
  const available = snapshot.units.filter(unit => allowed.has(unit.sourceVersionId) && isCurrentTaskUnit(snapshot, unit));
  if (scope.kind === 'task') return available.filter(isTextTaskUnit);
  if (scope.kind === 'sources') {
    if (new Set(scope.sourceVersionIds).size !== scope.sourceVersionIds.length || scope.sourceVersionIds.some(id => !allowed.has(id))) throw new TaskModelError('Search sources are outside the current authorized scope');
    return available.filter(isTextTaskUnit).filter(unit => scope.sourceVersionIds.includes(unit.sourceVersionId));
  }
  const keys = new Set(scope.targets.map(target => `${target.sourceVersionId}/${target.unitId}`));
  const units = available.filter(unit => keys.has(`${unit.sourceVersionId}/${unit.id}`));
  if (keys.size !== scope.targets.length || units.length !== keys.size) throw new TaskModelError('Search units are outside the current authorized source versions');
  return units.filter(isTextTaskUnit);
}

export function parseTaskSearchExpansion(raw: string): string[] {
  if (raw.length > 4000) throw new TaskModelError('Search expansion exceeds its response budget');
  const parsed = parseTaskModelJSON(expansionSchema, raw);
  return [...new Set(parsed.terms)];
}

function queryTerms(query: string, expansion: readonly string[]): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...segmenter.segment(query)].filter(segment => segment.isWordLike).map(segment => segment.segment);
  return [...new Set([query, ...expansion, ...words].map(term => term.toLocaleLowerCase().trim()).filter(term => term.length > 1))];
}

/** Local recall scans only the selected scope. Ranking gets bounded exact excerpts. */
export function prepareTaskSearchCandidates(snapshot: TaskReviewSnapshot, units: TaskTextReviewUnit[], query: string, expansion: readonly string[]) {
  const terms = queryTerms(query, expansion);
  const sourceIds = [...new Set(units.map(unit => unit.sourceVersionId))];
  const unitIds = new Set(units.map(unit => unit.id));
  const summaries = new Map<string, string[]>();
  for (const issue of snapshot.issues) {
    if (!unitIds.has(issue.unitId) || !isTaskIssueCurrent(snapshot, issue) || !isTaskModelInputScopeCurrent(snapshot, issue.inputSourceVersionIds, sourceIds)) continue;
    summaries.set(issue.unitId, [...(summaries.get(issue.unitId) ?? []), issue.title, issue.hypothesis]);
  }
  const scored = units.map((unit, ordinal) => {
    const text = unit.text.toLocaleLowerCase();
    let score = 0;
    let firstMatch = -1;
    for (const term of terms) {
      const index = text.indexOf(term);
      if (index >= 0) { score += 2 + Math.min(term.length, 20); firstMatch = firstMatch < 0 ? index : Math.min(firstMatch, index); }
      if (summaries.get(unit.id)?.some(summary => summary.toLocaleLowerCase().includes(term))) score += 1;
    }
    return { unit, ordinal, score, firstMatch };
  });
  const positive = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
  const pool = [...positive];
  // No lexical hit is not proof of no semantic match. Include a bounded spread
  // of additional units and report that the model did not inspect the rest.
  const seen = new Set(pool.map(item => item.unit.id));
  for (let i = 0; i < Math.min(MAX_CANDIDATES, scored.length); i++) {
    const item = scored[Math.floor(i * scored.length / Math.min(MAX_CANDIDATES, scored.length))];
    if (!seen.has(item.unit.id)) { pool.push(item); seen.add(item.unit.id); }
  }
  let remaining = MAX_TEXT_CHARS;
  const ranges: TaskEvidenceRef[] = [];
  for (const { unit, firstMatch } of pool.slice(0, MAX_CANDIDATES)) {
    if (!remaining) break;
    const start = firstMatch < 0 ? 0 : Math.max(0, firstMatch - 240);
    const end = Math.min(unit.text.length, start + Math.min(MAX_EXCERPT_CHARS, remaining));
    if (start === end) continue;
    ranges.push({ unitId: unit.id, sourceVersionId: unit.sourceVersionId, start, end, text: unit.text.slice(start, end) });
    remaining -= end - start;
  }
  const complete = ranges.length === units.length && ranges.every(range => range.start === 0 && range.end === units.find(unit => unit.id === range.unitId)!.text.length);
  return { ranges, complete };
}

export function parseTaskSearchMatches(snapshot: TaskReviewSnapshot, ranges: TaskEvidenceRef[], raw: string) {
  if (raw.length > 40000) throw new TaskModelError('Model search exceeds its response budget');
  const rawMatches = parseTaskModelJSON(matchSchema, raw);
  const references = taskModelReferences(snapshot, ranges, [...new Set(ranges.map(range => range.sourceVersionId))]);
  const parsed = { matches: rawMatches.matches.map((match, index) => ({ ...match, ...references.target(match, ['matches', index]), sourceRefs: match.sourceRefs.map((ref, refIndex) => references.evidence(ref, ['matches', index, 'sourceRefs', refIndex])) })) };
  const inputSourceVersionIds = [...new Set(ranges.map(range => range.sourceVersionId))].sort();
  if (new Set(parsed.matches.map(match => match.unitId)).size !== parsed.matches.length) throw new TaskModelError('Model search returned duplicate units');
  for (const match of parsed.matches) {
    if (!ranges.some(range => range.unitId === match.unitId && range.sourceVersionId === match.sourceVersionId)) throw new TaskModelError('Model search returned an unknown source unit');
    if (match.sourceRefs.some(ref => ref.unitId !== match.unitId || ref.sourceVersionId !== match.sourceVersionId || !ranges.some(range => range.unitId === ref.unitId && range.sourceVersionId === ref.sourceVersionId && ref.start >= range.start && ref.end <= range.end))) throw new TaskModelError('Search evidence is outside the supplied exact ranges');
  }
  return parsed.matches.map(match => ({ ...match, inputSourceVersionIds }));
}
