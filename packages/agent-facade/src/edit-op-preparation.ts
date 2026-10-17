/**
 * Per-op async preparation shared by headless and live edit.apply/edit.validate.
 *
 * File-backed ops (media.replace/media.relink) and record-driven ducking need
 * I/O before translation. Both are prepared against the SAME sequential draft
 * the op is about to be applied to, so an earlier op in the batch (clip.add,
 * clip.move, media.relink, …) is visible — no pre-batch snapshot is used.
 */
import type { Project } from "@reelterminal/core/types/project";

import { enrichDuckingFromAnalysisOps } from "./ducking-from-analysis";
import { enrichCutSilenceOps } from "./silence-cut-from-analysis";
import { enrichSplitAtBeatOps } from "./beat-split-from-analysis";
import { enrichMediaFileOps } from "./ops";
import type { EditOp } from "./types";

export interface EditOpFileProbe {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly codec: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface EditOpFileStat {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}

export interface PrepareEditOpOptions {
  readonly mediaRoots: readonly string[];
  readonly artifactRoot: string | undefined;
  readonly probeFile: (absPath: string) => Promise<EditOpFileProbe>;
  readonly statFile: (absPath: string) => Promise<EditOpFileStat>;
  readonly verb: "edit.apply" | "edit.validate";
}

export async function prepareEditOp(
  op: EditOp,
  draft: Project,
  opIndex: number,
  options: PrepareEditOpOptions,
): Promise<EditOp> {
  let prepared = op;
  if (prepared.op === "media.replace" || prepared.op === "media.relink") {
    prepared = (await enrichMediaFileOps(
      [prepared],
      options.mediaRoots,
      options.probeFile,
      options.statFile,
      async () => draft,
    ))[0]!;
  }
  if (prepared.op === "clip.setDuckingFromAnalysis") {
    prepared = (await enrichDuckingFromAnalysisOps(
      [prepared],
      options.artifactRoot,
      async () => draft,
      { opIndexBase: opIndex, verb: options.verb },
    ))[0]!;
  }
  if (prepared.op === "clip.cutSilenceFromAnalysis") {
    prepared = (await enrichCutSilenceOps(
      [prepared],
      options.artifactRoot,
      async () => draft,
      { opIndexBase: opIndex, verb: options.verb },
    ))[0]!;
  }
  if (prepared.op === "clip.splitAtBeat") {
    prepared = (await enrichSplitAtBeatOps(
      [prepared],
      options.artifactRoot,
      async () => draft,
      { opIndexBase: opIndex, verb: options.verb },
    ))[0]!;
  }
  return prepared;
}
