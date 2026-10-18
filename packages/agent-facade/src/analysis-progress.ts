/**
 * One progress allocation for every media.analyze_start execution path.
 *
 * The stages run in a fixed order and each gets a disjoint sub-range, so
 * progress never moves backwards when several analysis types are requested
 * (previously beatGrid could reach 100% and speechActivity/candidates then
 * restarted at 87.5%/50%). Headless and live sessions share this plan.
 */
export type AnalysisProgressStage =
  | "videoReview"
  | "audioSummary"
  | "silence"
  | "beatGrid"
  | "speechActivity"
  | "speechTranscript"
  | "speakerDiarization"
  | "syncOffset"
  | "candidates";

export interface AnalysisProgressPlan {
  percent(stage: AnalysisProgressStage, fraction: number): number;
  range(stage: AnalysisProgressStage): { readonly start: number; readonly end: number } | null;
}

interface StageSpec {
  readonly stage: AnalysisProgressStage;
  readonly weight: number;
}

const START = 0.1;
const END = 0.98;

/** Stage order matches runAnalysisJob's execution order. */
const ORDER: readonly AnalysisProgressStage[] = [
  "videoReview",
  "audioSummary",
  "silence",
  "beatGrid",
  "speechActivity",
  "speechTranscript",
  "speakerDiarization",
  "syncOffset",
  "candidates",
];

const WEIGHTS: Readonly<Record<AnalysisProgressStage, number>> = {
  videoReview: 3,
  audioSummary: 1,
  silence: 1,
  beatGrid: 1,
  speechActivity: 1,
  speechTranscript: 3,
  speakerDiarization: 2,
  syncOffset: 1,
  candidates: 2,
};

function presentStages(analysisTypes: readonly string[]): StageSpec[] {
  const present = new Set<AnalysisProgressStage>();
  if (analysisTypes.includes("videoReview")) present.add("videoReview");
  if (analysisTypes.includes("audioSummary")) present.add("audioSummary");
  if (analysisTypes.includes("silence")) present.add("silence");
  if (analysisTypes.includes("beatGrid")) present.add("beatGrid");
  if (analysisTypes.includes("speechActivity")) present.add("speechActivity");
  if (analysisTypes.includes("speechTranscript")) present.add("speechTranscript");
  if (analysisTypes.includes("speakerDiarization")) present.add("speakerDiarization");
  if (analysisTypes.includes("syncOffset")) present.add("syncOffset");
  if (analysisTypes.some((type) => type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames")) {
    present.add("candidates");
  }
  return ORDER.filter((stage) => present.has(stage)).map((stage) => ({ stage, weight: WEIGHTS[stage] }));
}

export function buildAnalysisProgressPlan(analysisTypes: readonly string[]): AnalysisProgressPlan {
  const stages = presentStages(analysisTypes);
  const totalWeight = stages.reduce((sum, stage) => sum + stage.weight, 0);
  const ranges = new Map<AnalysisProgressStage, { start: number; end: number }>();
  let cursor = START;
  for (const stage of stages) {
    const span = totalWeight > 0 ? ((END - START) * stage.weight) / totalWeight : 0;
    ranges.set(stage.stage, { start: cursor, end: cursor + span });
    cursor += span;
  }
  return {
    percent(stage, fraction) {
      const range = ranges.get(stage);
      if (!range) return Math.max(0, Math.min(1, fraction));
      const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
      return range.start + (range.end - range.start) * clamped;
    },
    range(stage) {
      const range = ranges.get(stage);
      return range ? { ...range } : null;
    },
  };
}
