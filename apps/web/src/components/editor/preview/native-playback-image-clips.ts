/**
 * Image-clip collection for native video playback background compositing.
 *
 * Native playback draws image clips as the background layer beneath video
 * frames. Image clips can live on image tracks AND on video tracks (e.g. a
 * JPG still placed in the video track next to MP4 clips); collecting only
 * image tracks made video-track stills invisible during playback while the
 * paused preview (which composites by track order) showed them correctly.
 */

export interface NativeImageClipEntry<TClip> {
  readonly clip: TClip;
  /** Index of the owning track in the full track list (z-order for compositing). */
  readonly trackIndex: number;
}

export interface NativeImageTrackLike<TClip> {
  readonly type: string;
  readonly hidden?: boolean;
  readonly clips: readonly TClip[];
}

/**
 * Collects every clip that native playback must composite as a background
 * image: all clips on visible image tracks, plus image-media clips found on
 * visible video tracks (identified through `mediaTypeOf`). Hidden tracks are
 * skipped; other track kinds never host image clips in native playback.
 */
export function collectNativePlaybackImageClips<TClip>(
  tracks: readonly NativeImageTrackLike<TClip>[],
  mediaTypeOf: (clip: TClip) => string | undefined,
): NativeImageClipEntry<TClip>[] {
  const imageClips: NativeImageClipEntry<TClip>[] = [];
  tracks.forEach((track, trackIndex) => {
    if (track.hidden) return;
    if (track.type === "image") {
      for (const clip of track.clips) {
        imageClips.push({ clip, trackIndex });
      }
      return;
    }
    if (track.type !== "video") return;
    for (const clip of track.clips) {
      if (mediaTypeOf(clip) === "image") {
        imageClips.push({ clip, trackIndex });
      }
    }
  });
  return imageClips;
}
