import { z } from 'zod';
import { taskCriteriaBasisSchema } from './task-review-context';

/** One record contract for task persistence and portable export manifests. */
export const taskDecisionRecordSchema = z.object({
  id: z.string().uuid(), unitId: z.string().uuid(), sourceVersionId: z.string().uuid(),
  policyRevision: z.number().int().nonnegative().safe(), purpose: z.string().trim().min(1).max(1000),
  status: z.enum(['kept', 'rework', 'discarded']), note: z.string().max(200000),
  replacementText: z.string().max(2 * 1024 * 1024).optional(), createdAt: z.number().nonnegative(),
  criteriaBasis: taskCriteriaBasisSchema.optional(),
}).strict();
