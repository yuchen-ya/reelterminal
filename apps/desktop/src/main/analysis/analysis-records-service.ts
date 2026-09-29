import { randomUUID } from "node:crypto";
import {
  listAnalysisRecords,
  loadAnalysisRecord,
  type AnalysisRecordView,
} from "@reelterminal/agent-facade/analysis-records";
import type {
  FacadeResult,
  MediaAnalyzeStartResult,
  JobStatusView,
} from "@reelterminal/agent-facade";
import type { LiveSessionHost } from "../live/live-session-host";

export interface AnalysisRecordSummary {
  readonly id: string;
  readonly projectId: string;
  readonly finishedAt: string;
  readonly subject: { readonly mediaId: string; readonly name: string };
  readonly analysisTypes: readonly string[];
  readonly stale: AnalysisRecordView["stale"];
  readonly recheckOf: string | null;
}

export interface AnalysisRecordListView {
  readonly records: readonly AnalysisRecordSummary[];
  /** Pre-project-id records cannot be assigned to the open project safely. */
  readonly legacyUnscopedCount: number;
}

export interface AnalysisRecordsService {
  list(args: {
    readonly projectId: string;
    readonly mediaId?: string;
    readonly limit?: number;
  }): Promise<AnalysisRecordListView>;
  get(args: {
    readonly projectId: string;
    readonly recordId: string;
  }): Promise<AnalysisRecordView>;
  recheck(args: {
    readonly projectId: string;
    readonly recordId: string;
    readonly allowCloudUpload?: boolean;
  }): Promise<FacadeResult<MediaAnalyzeStartResult>>;
  jobStatus(jobId: string): Promise<FacadeResult<JobStatusView>>;
}

function projectMismatch(): Error {
  return new Error("This analysis record does not belong to the open project");
}

export function createAnalysisRecordsService(
  artifactRoot: string,
  host: Pick<LiveSessionHost, "isEnabled" | "callExternal">,
): AnalysisRecordsService {
  const loadForProject = async (
    projectId: string,
    recordId: string,
  ): Promise<AnalysisRecordView> => {
    const record = await loadAnalysisRecord(artifactRoot, recordId);
    if (record.projectId !== projectId) throw projectMismatch();
    return record;
  };

  return {
    async list({ projectId, mediaId, limit }) {
      const records = await listAnalysisRecords(artifactRoot, {
        ...(mediaId ? { mediaId } : {}),
      });
      // Filter before limiting: records from other projects must not consume
      // this project's history window.
      const matching = records.filter((record) => record.projectId === projectId);
      return {
        records: matching.slice(0, limit ?? matching.length).map((record) => ({
          id: record.id,
          projectId: record.projectId,
          finishedAt: record.finishedAt,
          subject: { mediaId: record.subject.mediaId, name: record.subject.name },
          analysisTypes: record.analysisTypes,
          stale: record.stale,
          recheckOf: record.recheckOf,
        })),
        legacyUnscopedCount: records.filter(
          (record) => !record.projectId || record.projectId === "unknown",
        ).length,
      };
    },

    get({ projectId, recordId }) {
      return loadForProject(projectId, recordId);
    },

    async recheck({ projectId, recordId, allowCloudUpload = false }) {
      const record = await loadForProject(projectId, recordId);
      const usesCloud = record.config.analysisTypes.includes("videoReview");
      if (usesCloud && !allowCloudUpload) {
        return {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message:
              "This recheck includes cloud video review. Authorize this upload for this run before retrying.",
          },
        };
      }
      if (!host.isEnabled) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED",
            message:
              "Enable Agent Access to run a recheck. Browsing saved analysis remains available while it is disabled.",
          },
        };
      }

      const result = await host.callExternal("media.analyze_start", {
        mediaId: record.subject.mediaId,
        analysisTypes: [...record.config.analysisTypes],
        startSec: record.config.startSec,
        endSec: record.config.endSec,
        recheckOfRecordId: record.id,
        idempotencyKey: `analysis-gui-recheck-${randomUUID()}`,
        ...(usesCloud
          ? {
              cloudUpload: true,
              ...(record.config.reviewQuestion
                ? { reviewQuestion: record.config.reviewQuestion }
                : {}),
            }
          : {}),
      });
      return result as FacadeResult<MediaAnalyzeStartResult>;
    },

    async jobStatus(jobId) {
      if (!host.isEnabled) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED",
            message: "Agent Access was disabled before the recheck finished.",
          },
        };
      }
      return (await host.callExternal("job.status", { jobId })) as FacadeResult<JobStatusView>;
    },
  };
}
