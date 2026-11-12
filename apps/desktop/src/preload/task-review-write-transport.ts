import { CHANNELS } from '../shared/channels';
import { taskReviewSchemas } from '../shared/task-review-schema';
import type { TaskReviewSnapshot } from '../shared/task-review';
import type { TaskDecisionOutcome, TaskDecisionReply } from '../shared/task-review-bridge';
import { TaskWriteRecovery, type DecisionIntent } from '../shared/task-write-recovery';

/** Protect the public preload entry too; a disabled React button is not authority. */
export function createTaskReviewTransport(invoke: (channel: string, envelope: { method: string; input: unknown }) => Promise<any>) {
  const roots = new Map<string, TaskWriteRecovery>();
  return async (channel: string, method: string, raw: Record<string, any>): Promise<any> => {
    const root = raw.root;
    const barrier = typeof root === 'string' ? roots.get(root) : undefined;
    if (channel === CHANNELS.taskReview && method === 'open') return invoke(channel, { method, input: raw });
    if (channel === CHANNELS.taskReview && method === 'getDecisionOutcome') {
      const result = await invoke(channel, { method, input: raw }) as TaskDecisionOutcome;
      if (barrier?.pending) barrier.resolve(result);
      return result;
    }
    if (channel === CHANNELS.taskReviewMedia && (method === 'cancel' || method === 'thumbnail')) {
      if (barrier?.taskId && raw.taskId !== barrier.taskId) throw new Error('媒体目标已变化');
      return invoke(channel, { method, input: raw });
    }
    barrier?.guard(barrier.epoch);
    const batch = method === 'decideBatch';
    if (channel !== CHANNELS.taskReview || (!batch && method !== 'decide')) return invoke(channel, { method, input: raw });
    if (typeof root !== 'string' || typeof raw.taskId !== 'string') throw new Error('Invalid decision target');
    const decisionId = (batch ? raw.batchId : raw.decisionId) ?? globalThis.crypto.randomUUID();
    taskReviewSchemas.getDecisionOutcome.parse({ root, taskId: raw.taskId, decisionId });
    const payload = batch ? { ...raw, batchId: decisionId } : { ...raw, decisionId };
    const parsed = batch ? taskReviewSchemas.decideBatch.safeParse(payload) : taskReviewSchemas.decide.safeParse(payload);
    const input: Record<string, any> = parsed.success ? parsed.data : payload;
    const members: DecisionIntent[] | undefined = batch ? taskReviewSchemas.decideBatch.shape.targets.parse(input.targets).map(target => ({
      decisionId: target.decisionId, unitId: target.unitId, sourceVersionId: target.sourceVersionId,
      purpose: input.purpose, status: input.status, note: input.note, revision: input.expectedRevision,
    })) : undefined;
    const gate = barrier ?? new TaskWriteRecovery(root);
    roots.set(root, gate);
    gate.bind({ root, taskId: raw.taskId } as TaskReviewSnapshot);
    gate.begin(members ? { ...members[0], decisionId, batch: members } : {
      decisionId, unitId: input.unitId, sourceVersionId: input.sourceVersionId, purpose: input.purpose,
      status: input.status, note: input.note, replacementText: input.replacementText, revision: input.expectedRevision,
    });
    try {
      const reply = await invoke(channel, { method, input }) as TaskDecisionReply;
      const receipt = reply.decisionReceipt;
      if (!receipt || receipt.decisionId !== decisionId) throw new Error('Decision response requires exact verification');
      gate.resolve({ snapshot: reply, decisionId, outcome: receipt.outcome });
      return reply;
    } catch {
      const pending = gate.pending;
      if (pending && pending.decisionId === decisionId) gate.uncertain(pending);
      throw new Error('本次决定保存结果待核对，任务写入已暂停');
    }
  };
}
