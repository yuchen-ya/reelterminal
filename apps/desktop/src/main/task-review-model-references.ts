import { z } from 'zod';
import type { TaskReviewSnapshot, TaskUnitTarget } from '../shared/task-review';
import { validateTaskEvidence, type TaskEvidenceRef } from '../shared/task-review-context';
import { TaskModelError } from './task-review-provider';

export const taskModelTargetFields = { unitId: z.string().uuid(), sourceVersionId: z.string().uuid().optional() };
// Model wire objects project their declared fields. Domain and IPC schemas
// remain strict; none of the model's extra metadata enters canonical records.
export const taskModelTargetSchema = z.object(taskModelTargetFields);
export const taskModelUnitReferenceSchema = z.union([z.string().uuid(), taskModelTargetSchema]);
/** Models quote exact text; offsets are optional and always checked by main. */
export const taskModelEvidenceSchema = taskModelTargetSchema.extend({ text: z.string().min(1).max(16000), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional() });

const safeFields = new Set('understanding groundedClaims content hypotheses targets openQuestions question coverage unitId sourceVersionId status reason issues id severity title hypothesis sourceRefs criteriaRefs options label scenes kind purpose decisionMode checkIntent issueIds text start end matches terms'.split(' '));
const controlFields = new Set('manual humanDecisions decisions decisionActions actions fileActions toolCalls permissions authority grant grants authorization'.split(' '));
type ModelPath = readonly (string | number)[];
export class TaskModelContractError extends TaskModelError {
  constructor(readonly code: string, path: ModelPath) {
    super(`Model response invalid [${code}] at ${path.length ? path.map(part => typeof part === 'number' ? part : safeFields.has(part) || controlFields.has(part) ? part : 'field').join('.') : '$'}`);
  }
}

export function parseTaskModelJSON<T extends z.ZodType>(schema: T, raw: string): z.infer<T> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new TaskModelContractError('JSON_INVALID', []); }
  const pending: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.value === null || typeof item.value !== 'object') continue;
    if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => pending.push({ value: child, path: [...item.path, index] }));
    } else {
      for (const [field, child] of Object.entries(item.value)) {
        const path = [...item.path, field];
        if (controlFields.has(field)) throw new TaskModelContractError('CONTROL_FIELD_NOT_ALLOWED', path);
        pending.push({ value: child, path });
      }
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new TaskModelContractError('SCHEMA_INVALID', result.error.issues[0].path.map(part => typeof part === 'number' ? part : String(part)));
  return result.data;
}

/** References can resolve only against exact ranges actually sent in this request. */
export function taskModelReferences(snapshot: TaskReviewSnapshot, ranges: readonly TaskEvidenceRef[], authorizedSourceVersionIds: readonly string[]) {
  validateTaskEvidence(snapshot, [...ranges], authorizedSourceVersionIds);
  const targets = new Map<string, TaskUnitTarget>();
  for (const range of ranges) {
    const prior = targets.get(range.unitId);
    if (prior && prior.sourceVersionId !== range.sourceVersionId) throw new TaskModelContractError('TARGET_AMBIGUOUS', []);
    targets.set(range.unitId, { unitId: range.unitId, sourceVersionId: range.sourceVersionId });
  }
  function target(reference: z.infer<typeof taskModelUnitReferenceSchema>, path: ModelPath): TaskUnitTarget {
    const unitId = typeof reference === 'string' ? reference : reference.unitId;
    const bound = targets.get(unitId);
    if (!bound) throw new TaskModelContractError('TARGET_NOT_SUPPLIED', path);
    if (typeof reference !== 'string' && reference.sourceVersionId !== undefined && reference.sourceVersionId !== bound.sourceVersionId) throw new TaskModelContractError('SOURCE_VERSION_MISMATCH', path);
    return { ...bound };
  }
  function evidence(reference: z.infer<typeof taskModelEvidenceSchema>, path: ModelPath): TaskEvidenceRef {
    const bound = target(reference, path);
    const sent = ranges.filter(range => range.unitId === bound.unitId && range.sourceVersionId === bound.sourceVersionId);
    const { start, end, text } = reference;
    // A valid explicit location disambiguates repeated exact quotes. Incorrect
    // offsets never authorize searching outside the supplied excerpts.
    const explicit = start !== undefined && end !== undefined && sent.some(range => start >= range.start && end <= range.end && end > start && range.text.slice(start - range.start, end - range.start) === text);
    let position = start;
    if (!explicit) {
      const positions = new Set<number>();
      for (const range of sent) {
        let index = range.text.indexOf(text);
        while (index >= 0) {
          positions.add(range.start + index);
          if (positions.size > 1) throw new TaskModelContractError('EVIDENCE_AMBIGUOUS', path);
          index = range.text.indexOf(text, index + 1);
        }
      }
      if (!positions.size) throw new TaskModelContractError('EVIDENCE_NOT_SUPPLIED', path);
      position = positions.values().next().value!;
    }
    const normalized = { ...bound, start: position!, end: position! + text.length, text };
    validateTaskEvidence(snapshot, [normalized], authorizedSourceVersionIds);
    return normalized;
  }
  return { target, evidence };
}
