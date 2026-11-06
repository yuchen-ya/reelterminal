import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskReviewSnapshot } from "../../../../../desktop/src/shared/task-review";
import { isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type {
  TaskAgentBridge,
  TaskAgentJob,
  TaskAgentState,
} from "../../../../../desktop/src/shared/task-review-runtime-types";
import { errorMessage } from "./bridge";
import { currentSources } from "./queries";

export interface TaskAgentTargetInput {
  root: string;
  taskId: string;
}

export interface PreflightCoverage {
  total: number;
  analyzed: number;
  inFlight: number;
  failed: number;
  unanalyzed: number;
}

const activeStatuses: TaskAgentJob["status"][] = ["queued", "running"];

interface AgentReadSession {
  agent: TaskAgentBridge;
  target: TaskAgentTargetInput;
  active: boolean;
  refreshing: boolean;
  pending: boolean;
  epoch: number;
}

/** Runtime projects only effective source/policy/criteria checkpoint IDs. */
export function analyzedUnitIds(snapshot: TaskReviewSnapshot, state: TaskAgentState | null): Set<string> {
  const current = new Set(currentSources(snapshot).map((source) => source.id));
  const deferred = new Set(state?.deferredUnitIds ?? []);
  const units = new Map(snapshot.units.filter(isTextTaskUnit).filter((unit) => current.has(unit.sourceVersionId)).map((unit) => [unit.id, unit]));
  const result = new Set<string>();
  for (const job of state?.jobs ?? []) {
    if (job.taskId !== snapshot.taskId || job.policyRevision !== snapshot.policyRevision || job.status === "stale") continue;
    for (const id of job.completedUnitIds) {
      const unit = units.get(id);
      if (unit && !deferred.has(id) && job.sourceVersionIds.includes(unit.sourceVersionId)) result.add(id);
    }
  }
  return result;
}

export function jobsActive(state: TaskAgentState | null): boolean {
  return state?.jobs.some((job) => activeStatuses.includes(job.status)) ?? false;
}

/**
 * Coverage uses main's effective completedUnitIds projection, deduplicated
 * against current sources/policy. A finished job is not proof that every
 * requested unit was analyzed; deferred and unknown units stay uncovered.
 */
export function preflightCoverage(
  snapshot: TaskReviewSnapshot,
  state: TaskAgentState | null,
): PreflightCoverage {
  const scoped = state?.grant
    ? currentSources(snapshot)
        .filter(
          (source) =>
            state.grant!.scope === "task" ||
            state.grant!.sourceEntryIds.includes(source.entryId),
        )
        .map((source) => source.id)
    : currentSources(snapshot).map((source) => source.id);
  const scope = new Set(scoped);
  const units = snapshot.units.filter(isTextTaskUnit).filter((unit) => scope.has(unit.sourceVersionId));
  const analyzed = analyzedUnitIds(snapshot, state);
  const jobs = (state?.jobs ?? []).filter((job) => job.taskId === snapshot.taskId &&
    job.policyRevision === snapshot.policyRevision && job.status !== "stale");
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const matches = (job: TaskAgentJob, unitId: string) => {
    const unit = unitsById.get(unitId);
    return unit !== undefined && job.sourceVersionIds.includes(unit.sourceVersionId);
  };
  const inFlight = new Set<string>();
  for (const job of jobs) {
    if (activeStatuses.includes(job.status))
      for (const unitId of job.unitIds) if (matches(job, unitId) && !analyzed.has(unitId)) inFlight.add(unitId);
  }
  const failed = new Set<string>();
  for (const job of jobs) {
    if (job.status !== "failed" && job.status !== "interrupted") continue;
    for (const unitId of job.unitIds)
      if (matches(job, unitId) && !analyzed.has(unitId) && !inFlight.has(unitId)) failed.add(unitId);
  }
  let analyzedCount = 0;
  let inFlightCount = 0;
  let failedCount = 0;
  for (const unit of units) {
    if (failed.has(unit.id)) failedCount++;
    else if (inFlight.has(unit.id)) inFlightCount++;
    else if (analyzed.has(unit.id)) analyzedCount++;
  }
  return {
    total: units.length,
    analyzed: analyzedCount,
    inFlight: inFlightCount,
    failed: failedCount,
    unanalyzed: units.length - analyzedCount - inFlightCount - failedCount,
  };
}

/**
 * Renderer view of the main-process agent runtime. Reads poll only while work
 * is active or after each task change; re-preflight itself is driven by
 * desktop main once the task grant exists, so the reviewer never re-confirms
 * authorization after content updates.
 */
export function useTaskAgentState(
  agent: TaskAgentBridge | null,
  target: TaskAgentTargetInput | null,
  taskRevision: number | null,
) {
  const [state, setState] = useState<TaskAgentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<AgentReadSession | null>(null);
  const root = target?.root;
  const taskId = target?.taskId;

  const currentSession = useCallback(() => {
    const session = sessionRef.current;
    return session?.active && session.agent === agent &&
      session.target.root === root && session.target.taskId === taskId ? session : null;
  }, [agent, root, taskId]);

  const refresh = useCallback(async (invalidate = false) => {
    const session = currentSession();
    if (!session) return;
    if (invalidate) session.epoch++;
    session.pending = true;
    if (session.refreshing) return;
    session.refreshing = true;
    try {
      do {
        session.pending = false;
        const epoch = session.epoch;
        try {
          const next = await session.agent.getState(session.target);
          if (session.active && epoch === session.epoch) {
            setState(next);
            setError(null);
          }
        } catch (problem) {
          if (session.active && epoch === session.epoch) setError(errorMessage(problem));
        }
        // Multiple revisions during one read coalesce into one fresh read.
        // Terminal jobs cannot rely on the active-job timer to catch up.
      } while (session.active && session.pending);
    } finally {
      session.refreshing = false;
    }
  }, [currentSession]);

  useEffect(() => {
    setState(null);
    setError(null);
    if (!agent || root === undefined || taskId === undefined) return;
    const session: AgentReadSession = {
      agent, target: { root, taskId }, active: true, refreshing: false, pending: false, epoch: 0,
    };
    sessionRef.current = session;
    return () => {
      session.active = false;
      session.pending = false;
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [agent, root, taskId]);

  useEffect(() => { void refresh(true); }, [refresh, taskRevision]);

  useEffect(() => {
    if (!jobsActive(state)) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [state, refresh]);

  const run = useCallback(
    async (operation: () => Promise<TaskAgentState>) => {
      const session = currentSession();
      if (!session) return;
      const epoch = ++session.epoch;
      try {
        const next = await operation();
        if (!session.active) return;
        if (epoch !== session.epoch) { void refresh(); return; }
        // A read started during the mutation must not replace its result.
        session.epoch++;
        setState(next);
        setError(null);
      } catch (problem) {
        if (!session.active) return;
        if (epoch === session.epoch) {
          session.epoch++;
          setError(errorMessage(problem));
        }
        void refresh();
      }
    },
    [currentSession, refresh],
  );

  const authorize = useCallback(
    (sourceVersionIds: string[]) =>
      target &&
      run(() => agent!.authorize({ ...target, scope: "task", sourceVersionIds })),
    [agent, run, target],
  );
  const revoke = useCallback(
    () => target && run(() => agent!.revoke(target)),
    [agent, run, target],
  );
  const cancelJob = useCallback(
    (jobId: string) => target && run(() => agent!.cancelJob({ ...target, jobId })),
    [agent, run, target],
  );
  const retryJob = useCallback(
    (jobId: string) => target && run(() => agent!.retryJob({ ...target, jobId })),
    [agent, run, target],
  );
  const startPreflight = useCallback(
    () => target && run(() => agent!.startPreflight(target)),
    [agent, run, target],
  );
  const continueAnalysis = useCallback(
    () => target && run(() => agent!.continueAnalysis(target)),
    [agent, run, target],
  );

  return { state, error, refresh, authorize, revoke, cancelJob, retryJob, startPreflight, continueAnalysis };
}

export type TaskAgentRuntime = ReturnType<typeof useTaskAgentState>;
