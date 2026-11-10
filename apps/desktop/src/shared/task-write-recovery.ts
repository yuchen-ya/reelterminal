import type { TaskReviewSnapshot } from './task-review';
import type { TaskDecisionOutcome } from './task-review-bridge';

export interface DecisionIntent {
  decisionId: string;
  unitId: string;
  sourceVersionId: string;
  purpose: string;
  status: string;
  note: string;
  replacementText?: string;
  revision: number;
}
export interface RecoveryState {
  outcome: 'unknown' | 'committed' | 'not-committed';
  decisionId: string;
  message: string;
}

/** A renderer-session write barrier, not a durable command journal. */
export class TaskWriteRecovery {
  epoch = 0;
  taskId: string | null = null;
  blocked = false;
  inFlight = false;
  pending: DecisionIntent | null = null;
  state: RecoveryState | null = null;
  constructor(readonly root: string) {}

  bind(snapshot: TaskReviewSnapshot) {
    if (snapshot.root !== this.root || this.taskId !== null && snapshot.taskId !== this.taskId)
      throw new Error('审阅目标已变化；未解除写入保护');
    this.taskId = snapshot.taskId;
  }
  guard(epoch: number, allowSaving = false) {
    if ((this.blocked && !(allowSaving && this.inFlight)) || epoch !== this.epoch) throw new Error('写入已暂停；请先核对本次决定的保存结果');
  }
  begin(intent: DecisionIntent) {
    this.blocked = true;
    this.inFlight = true;
    this.pending = intent;
    this.state = { outcome: 'unknown', decisionId: intent.decisionId, message: '本次决定正在保存；其他任务写入暂时等待。' };
  }
  complete(decisionId: string) {
    if (this.pending?.decisionId !== decisionId) throw new Error('决定保存身份已变化');
    this.blocked = false;
    this.inFlight = false;
    this.pending = null;
    this.state = null;
  }
  uncertain(intent: DecisionIntent) {
    this.inFlight = false;
    this.epoch++;
    this.blocked = true;
    this.pending = intent;
    this.state = { outcome: 'unknown', decisionId: intent.decisionId, message: "The decision outcome is unknown. Decisions, autosave and other task writes are paused; your input is preserved." };
  }
  resolve(result: TaskDecisionOutcome): TaskReviewSnapshot {
    const intent = this.pending;
    if (!intent || result.decisionId !== intent.decisionId) throw new Error('核对的决定身份不匹配');
    this.bind(result.snapshot);
    if (result.snapshot.revision < intent.revision) throw new Error('核对结果早于本次决定');
    const decision = result.snapshot.decisions.find(item => item.id === intent.decisionId);
    const action = result.snapshot.decisionActions.some(item => item.kind === 'decide' && item.decisionId === intent.decisionId);
    const sameTarget = decision?.unitId === intent.unitId && decision?.sourceVersionId === intent.sourceVersionId && decision?.purpose === intent.purpose && decision?.status === intent.status && decision?.note === intent.note && decision?.replacementText === intent.replacementText;
    if (result.outcome === 'committed' && (!decision || !action || !sameTarget)) throw new Error('缺少本次决定的精确记录，仍暂停写入');
    if (result.outcome === 'not-committed' && (decision || action)) throw new Error('未提交回执与决定记录冲突');
    if (result.outcome === 'unknown') throw new Error('仍无法确认本次决定；revision变化不代表提交成功');
    this.epoch++;
    this.blocked = false;
    this.inFlight = false;
    this.pending = null;
    this.state = { outcome: result.outcome, decisionId: intent.decisionId, message: result.outcome === 'committed'
      ? "This exact decision was found. Do not submit it again; the authoritative snapshot is current."
      : "This decision was not committed. Your input is preserved; you can explicitly submit again." };
    return result.snapshot;
  }
}

// Preserve an unresolved barrier across component remounts/task tab switches.
const barriers = new WeakMap<object, Map<string, TaskWriteRecovery>>();
export function taskWriteRecovery(root: string, bridge: object) {
  let roots = barriers.get(bridge);
  if (!roots) { roots = new Map(); barriers.set(bridge, roots); }
  let barrier = roots.get(root);
  if (!barrier) { barrier = new TaskWriteRecovery(root); roots.set(root, barrier); }
  return barrier;
}
