export interface TimelineLocation {
  readonly clipId: string;
  readonly trackId: string;
  readonly timelineSec: number;
}

interface TimelineClipLike {
  readonly id: string;
  readonly mediaId?: string;
  readonly startTime: number;
  readonly duration: number;
  readonly inPoint?: number;
  readonly outPoint?: number;
  readonly speed?: number;
  readonly reversed?: boolean;
  readonly speedKeyframes?: readonly unknown[];
  readonly freezeFrames?: readonly unknown[];
}

interface TimelineProjectLike {
  readonly timeline: {
    readonly tracks: readonly {
      readonly id: string;
      readonly clips: readonly TimelineClipLike[];
    }[];
  };
}

/** Map a source-media second to every constant-speed occurrence on the timeline. */
export function findTimelineLocations(
  project: TimelineProjectLike,
  mediaId: string,
  sourceSec: number,
): readonly TimelineLocation[] {
  if (!Number.isFinite(sourceSec) || sourceSec < 0) return [];
  const locations: TimelineLocation[] = [];
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaId !== mediaId) continue;
      // Variable-speed and freeze-frame inversion needs SpeedEngine state.
      // Omitting them is more honest than presenting an approximate seek.
      if (clip.speedKeyframes?.length || clip.freezeFrames?.length) continue;
      const inPoint = clip.inPoint ?? 0;
      const outPoint = clip.outPoint ?? inPoint + clip.duration;
      const speed = Math.max(0.0001, clip.speed ?? 1);
      if (sourceSec < inPoint - 0.0001 || sourceSec > outPoint + 0.0001) continue;
      const localSec = clip.reversed
        ? (outPoint - sourceSec) / speed
        : (sourceSec - inPoint) / speed;
      if (localSec < -0.0001 || localSec > clip.duration + 0.0001) continue;
      locations.push({
        clipId: clip.id,
        trackId: track.id,
        timelineSec: clip.startTime + Math.max(0, Math.min(clip.duration, localSec)),
      });
    }
  }
  return locations.sort((a, b) => a.timelineSec - b.timelineSec);
}

export interface EvidenceTime {
  readonly label: string;
  readonly sourceSec: number;
}

/** Pull explicit source-time fields from bounded persisted analysis data. */
export function collectEvidenceTimes(
  value: unknown,
  limit = 32,
): readonly EvidenceTime[] {
  const found: EvidenceTime[] = [];
  const seen = new Set<string>();
  const add = (label: string, sourceSec: unknown) => {
    if (found.length >= limit || typeof sourceSec !== "number" || !Number.isFinite(sourceSec) || sourceSec < 0) return;
    const key = `${label}:${sourceSec.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ label, sourceSec });
  };
  const visit = (entry: unknown, path: string, depth: number) => {
    if (found.length >= limit || depth > 7 || entry === null || entry === undefined) return;
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === "number" && /^(timeSec|startSec|endSec)$/i.test(key)) {
        add(childPath, child);
      } else if (key === "onsets" && Array.isArray(child)) {
        child.forEach((time, index) => add(`${childPath}[${index}]`, time));
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(value, "", 0);
  return found;
}
