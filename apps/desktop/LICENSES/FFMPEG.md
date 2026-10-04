# FFmpeg

Default desktop packages exclude FFmpeg binaries. Users install FFmpeg/ffprobe
separately. The development-only fetch command downloads prebuilt FFmpeg for
local use as an external process. The pinned binary sources and
SHA-256 digests are listed in [`../resources/bin/MANIFEST.json`](../resources/bin/MANIFEST.json)
and verified by `scripts/fetch-ffmpeg.mjs`.

## Builds

| Platform | Version | License configuration | Source |
|---|---:|---|---|
| macOS arm64 | 7.1 | GPL-2.0-or-later | [OSXExperts](https://www.osxexperts.net/ffmpeg71arm.zip) |
| macOS x64 | 6.1.1 | GPL-3.0-or-later | [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) |
| Linux x64 | 6.1.1 | GPL-3.0-or-later | [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) |
| Windows x64 | 6.1.1 | GPL-3.0-or-later | [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) |

The binaries include GPL components such as x264 and x265. The complete GPL-2.0
and GPL-3.0 texts are included alongside this file. See the
[FFmpeg license information](https://ffmpeg.org/legal.html).

## Source materials for binary releases

Binary releases require the complete corresponding source, build
configuration, and patches through a source-access method permitted by the
applicable license. This repository provides provenance and hash records;
corresponding source archives and build configurations must accompany a
release.
