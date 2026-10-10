/**
 * "Next content start" finders for the multi-track playback loop.
 *
 * When the playhead lands in a gap with no active content, the playback loop
 * seeks forward to the earliest upcoming start among video/image clips, text
 * clips, shape-family clips, motion instances, and audio clips. Each finder
 * returns the smallest `startTime` strictly greater than `afterTime`, or null
 * when nothing follows. The data sources are parameters; the Preview playback
 * effect passes its live refs at call time, exactly as the previous inline
 * bodies read them.
 */

export interface NextContentStartTrackLike<TClip> {
  readonly type: string;
  readonly hidden?: boolean;
  readonly clips: readonly TClip[];
}

export interface NextContentStartTimedLike {
  readonly startTime: number;
}

export function findNextClipStartTime<TClip extends NextContentStartTimedLike>(
  tracks: readonly NextContentStartTrackLike<TClip>[],
  afterTime: number,
): number | null {
  const videoTracks = tracks.filter(
    (t) => (t.type === "video" || t.type === "image") && !t.hidden,
  );
  let nextStart: number | null = null;

  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.startTime > afterTime) {
        if (nextStart === null || clip.startTime < nextStart) {
          nextStart = clip.startTime;
        }
      }
    }
  }

  return nextStart;
}

export function findNextTextClipStartTime<
  TClip extends NextContentStartTimedLike,
>(textClips: readonly TClip[], afterTime: number): number | null {
  let nextStart: number | null = null;

  for (const clip of textClips) {
    if (clip.startTime > afterTime) {
      if (nextStart === null || clip.startTime < nextStart) {
        nextStart = clip.startTime;
      }
    }
  }

  return nextStart;
}

export function findNextShapeClipStartTime<
  TClip extends NextContentStartTimedLike,
>(shapeClips: readonly TClip[], afterTime: number): number | null {
  let nextStart: number | null = null;

  for (const clip of shapeClips) {
    if (clip.startTime > afterTime) {
      if (nextStart === null || clip.startTime < nextStart) {
        nextStart = clip.startTime;
      }
    }
  }

  return nextStart;
}

export function findNextMotionInstanceStartTime<
  TInstance extends NextContentStartTimedLike,
>(motionInstances: readonly TInstance[], afterTime: number): number | null {
  let nextStart: number | null = null;
  for (const instance of motionInstances) {
    if (instance.startTime > afterTime) {
      if (nextStart === null || instance.startTime < nextStart) {
        nextStart = instance.startTime;
      }
    }
  }
  return nextStart;
}

export function findNextAudioClipStartTime<
  TClip extends NextContentStartTimedLike,
>(tracks: readonly NextContentStartTrackLike<TClip>[], afterTime: number): number | null {
  const audioTracks = tracks.filter((t) => t.type === "audio" && !t.hidden);
  let nextStart: number | null = null;

  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.startTime > afterTime) {
        if (nextStart === null || clip.startTime < nextStart) {
          nextStart = clip.startTime;
        }
      }
    }
  }

  return nextStart;
}
