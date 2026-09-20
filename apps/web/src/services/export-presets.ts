import type { ExportPreset, AudioExportSettings } from "@reelterminal/core";

export interface PlatformExportPreset extends ExportPreset {
  platform: string;
  icon?: string;
  maxDuration?: number;
  maxFileSize?: number;
  aspectRatio?: string;
  recommended?: boolean;
}

const SOCIAL_MEDIA_PRESETS: PlatformExportPreset[] = [
  {
    id: "youtube-4k",
    name: "YouTube 4K",
    description: "Best quality for YouTube 4K - 50Mbps",
    platform: "YouTube",
    category: "social",
    aspectRatio: "16:9",
    recommended: true,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 50000,
      bitrateMode: "vbr",
      quality: 90,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 384,
        channels: 2,
      },
    },
  },
  {
    id: "youtube-4k-60",
    name: "YouTube 4K 60fps",
    description: "4K 60fps for gaming/motion - 65Mbps",
    platform: "YouTube",
    category: "social",
    aspectRatio: "16:9",
    settings: {
      format: "mp4",
      codec: "h264",
      width: 3840,
      height: 2160,
      frameRate: 60,
      bitrate: 65000,
      bitrateMode: "vbr",
      quality: 90,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 384,
        channels: 2,
      },
    },
  },
  {
    id: "youtube-1080p",
    name: "YouTube 1080p HD",
    description: "Standard HD quality for YouTube",
    platform: "YouTube",
    category: "social",
    aspectRatio: "16:9",
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 8000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 256,
        channels: 2,
      },
    },
  },
  {
    id: "youtube-shorts",
    name: "YouTube Shorts",
    description: "Vertical format for YouTube Shorts (60s max)",
    platform: "YouTube",
    category: "social",
    aspectRatio: "9:16",
    maxDuration: 60,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1080,
      height: 1920,
      frameRate: 60,
      bitrate: 12000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 256,
        channels: 2,
      },
    },
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "Optimized for TikTok (3min max)",
    platform: "TikTok",
    category: "social",
    aspectRatio: "9:16",
    maxDuration: 180,
    maxFileSize: 287 * 1024 * 1024,
    recommended: true,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1080,
      height: 1920,
      frameRate: 60,
      bitrate: 10000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
  {
    id: "instagram-reels",
    name: "Instagram Reels",
    description: "Vertical format for Reels (90s max)",
    platform: "Instagram",
    category: "social",
    aspectRatio: "9:16",
    maxDuration: 90,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1080,
      height: 1920,
      frameRate: 30,
      bitrate: 8000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
  {
    id: "instagram-feed",
    name: "Instagram Feed Video",
    description: "Square format for feed posts (60s max)",
    platform: "Instagram",
    category: "social",
    aspectRatio: "1:1",
    maxDuration: 60,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1080,
      height: 1080,
      frameRate: 30,
      bitrate: 6000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
  {
    id: "instagram-story",
    name: "Instagram Story",
    description: "Vertical format for Stories (15s per clip)",
    platform: "Instagram",
    category: "social",
    aspectRatio: "9:16",
    maxDuration: 15,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1080,
      height: 1920,
      frameRate: 30,
      bitrate: 6000,
      bitrateMode: "vbr",
      quality: 80,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 128,
        channels: 2,
      },
    },
  },
  {
    id: "twitter",
    name: "Twitter/X",
    description: "Optimized for Twitter (2min 20s max)",
    platform: "Twitter",
    category: "social",
    aspectRatio: "16:9",
    maxDuration: 140,
    maxFileSize: 512 * 1024 * 1024,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 8000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
  {
    id: "facebook-feed",
    name: "Facebook Feed",
    description: "Standard format for Facebook feed",
    platform: "Facebook",
    category: "social",
    aspectRatio: "16:9",
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 8000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Professional format for LinkedIn (10min max)",
    platform: "LinkedIn",
    category: "social",
    aspectRatio: "16:9",
    maxDuration: 600,
    maxFileSize: 5 * 1024 * 1024 * 1024,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 8000,
      bitrateMode: "vbr",
      quality: 85,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    },
  },
];

const BROADCAST_PRESETS: PlatformExportPreset[] = [
  {
    id: "broadcast-4k-master",
    name: "4K Master Quality",
    description: "Maximum quality 4K - 80Mbps H.265",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    recommended: true,
    settings: {
      format: "mov",
      codec: "h265",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 80000,
      bitrateMode: "vbr",
      quality: 95,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 320,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-4k-prores-hq",
    name: "4K ProRes HQ",
    description: "Professional ProRes for editing/mastering",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "prores",
      proresProfile: "hq",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 880000,
      bitrateMode: "cbr",
      quality: 100,
      keyframeInterval: 1,
      audioSettings: {
        format: "wav",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-4k-prores-4444",
    name: "4K ProRes 4444",
    description: "Highest quality ProRes with alpha support",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "prores",
      proresProfile: "4444",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 1320000,
      bitrateMode: "cbr",
      quality: 100,
      keyframeInterval: 1,
      audioSettings: {
        format: "wav",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-4k-60",
    name: "4K 60fps High Motion",
    description: "4K at 60fps for sports/gaming - 65Mbps",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "h265",
      width: 3840,
      height: 2160,
      frameRate: 60,
      bitrate: 65000,
      bitrateMode: "vbr",
      quality: 90,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 320,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-4k",
    name: "Broadcast 4K UHD",
    description: "4K broadcast quality - 50Mbps",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "h264",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 50000,
      bitrateMode: "cbr",
      quality: 90,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 320,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-1080p-high",
    name: "1080p High Quality",
    description: "High bitrate 1080p - 20Mbps",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 20000,
      bitrateMode: "vbr",
      quality: 95,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 320,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-1080p-prores",
    name: "1080p ProRes HQ",
    description: "ProRes HQ for 1080p editing",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "prores",
      proresProfile: "hq",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 220000,
      bitrateMode: "cbr",
      quality: 100,
      keyframeInterval: 1,
      audioSettings: {
        format: "wav",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "broadcast-hd",
    name: "Broadcast HD 1080p",
    description: "Standard broadcast quality",
    platform: "Broadcast",
    category: "broadcast",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 12000,
      bitrateMode: "cbr",
      quality: 85,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 320,
        channels: 2,
      },
    },
  },
];

const WEB_PRESETS: PlatformExportPreset[] = [
  {
    id: "web-hd",
    name: "Web HD",
    description: "Balanced quality for web embedding",
    platform: "Web",
    category: "web",
    aspectRatio: "16:9",
    recommended: true,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 5000,
      bitrateMode: "vbr",
      quality: 80,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 128,
        channels: 2,
      },
    },
  },
  {
    id: "web-small",
    name: "Web Optimized",
    description: "Smaller file size for faster loading",
    platform: "Web",
    category: "web",
    aspectRatio: "16:9",
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1280,
      height: 720,
      frameRate: 30,
      bitrate: 2500,
      bitrateMode: "vbr",
      quality: 75,
      keyframeInterval: 90,
      audioSettings: {
        format: "aac",
        sampleRate: 44100,
        bitDepth: 16,
        bitrate: 96,
        channels: 2,
      },
    },
  },
  {
    id: "webm-vp9",
    name: "WebM VP9",
    description: "Modern web format with VP9 codec (720p recommended)",
    platform: "Web",
    category: "web",
    aspectRatio: "16:9",
    settings: {
      format: "webm",
      codec: "vp9",
      width: 1280,
      height: 720,
      frameRate: 30,
      bitrate: 3000,
      bitrateMode: "vbr",
      quality: 80,
      keyframeInterval: 60,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 128,
        channels: 2,
      },
    },
  },
];

const ARCHIVE_PRESETS: PlatformExportPreset[] = [
  {
    id: "archive-4k-prores",
    name: "Archive 4K ProRes",
    description: "Lossless 4K ProRes for long-term archival",
    platform: "Archive",
    category: "archive",
    aspectRatio: "16:9",
    recommended: true,
    settings: {
      format: "mov",
      codec: "prores",
      proresProfile: "hq",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 880000,
      bitrateMode: "cbr",
      quality: 100,
      keyframeInterval: 1,
      audioSettings: {
        format: "wav",
        sampleRate: 96000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "archive-master",
    name: "Archive Master H.265",
    description: "High quality 4K H.265 - 80Mbps",
    platform: "Archive",
    category: "archive",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "h265",
      width: 3840,
      height: 2160,
      frameRate: 30,
      bitrate: 80000,
      bitrateMode: "vbr",
      quality: 95,
      keyframeInterval: 30,
      audioSettings: {
        format: "wav",
        sampleRate: 96000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "archive-1080p-prores",
    name: "Archive 1080p ProRes",
    description: "ProRes HQ for 1080p archival",
    platform: "Archive",
    category: "archive",
    aspectRatio: "16:9",
    settings: {
      format: "mov",
      codec: "prores",
      proresProfile: "hq",
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 220000,
      bitrateMode: "cbr",
      quality: 100,
      keyframeInterval: 1,
      audioSettings: {
        format: "wav",
        sampleRate: 48000,
        bitDepth: 24,
        bitrate: 0,
        channels: 2,
      },
    },
  },
  {
    id: "archive-proxy",
    name: "Archive Proxy",
    description: "Lower quality proxy for editing",
    platform: "Archive",
    category: "archive",
    aspectRatio: "16:9",
    settings: {
      format: "mp4",
      codec: "h264",
      width: 1280,
      height: 720,
      frameRate: 30,
      bitrate: 3000,
      bitrateMode: "vbr",
      quality: 70,
      keyframeInterval: 30,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 128,
        channels: 2,
      },
    },
  },
];

const AUDIO_PRESETS: PlatformExportPreset[] = [
  {
    id: "audio-mp3-320",
    name: "MP3 High Quality",
    description: "320kbps MP3 for music",
    platform: "Audio",
    category: "custom",
    settings: {
      format: "mp3",
      sampleRate: 48000,
      bitDepth: 16,
      bitrate: 320,
      channels: 2,
    } as AudioExportSettings,
  },
  {
    id: "audio-wav",
    name: "WAV Lossless",
    description: "Uncompressed WAV audio",
    platform: "Audio",
    category: "archive",
    settings: {
      format: "wav",
      sampleRate: 48000,
      bitDepth: 24,
      bitrate: 0,
      channels: 2,
    } as AudioExportSettings,
  },
  {
    id: "audio-aac",
    name: "AAC High Quality",
    description: "256kbps AAC for compatibility",
    platform: "Audio",
    category: "custom",
    settings: {
      format: "aac",
      sampleRate: 48000,
      bitDepth: 16,
      bitrate: 256,
      channels: 2,
    } as AudioExportSettings,
  },
];

export const ALL_EXPORT_PRESETS: PlatformExportPreset[] = [
  ...SOCIAL_MEDIA_PRESETS,
  ...BROADCAST_PRESETS,
  ...WEB_PRESETS,
  ...ARCHIVE_PRESETS,
  ...AUDIO_PRESETS,
];

const CUSTOM_PRESETS_KEY = "openreel-custom-export-presets";

class ExportPresetsManager {
  private customPresets: PlatformExportPreset[] = [];
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.loadCustomPresets();
  }

  private loadCustomPresets(): void {
    try {
      const stored = localStorage.getItem(CUSTOM_PRESETS_KEY);
      if (stored) {
        this.customPresets = JSON.parse(stored);
      }
    } catch (error) {
      console.error("[ExportPresets] Failed to load custom presets:", error);
    }
  }

  private saveCustomPresets(): void {
    try {
      localStorage.setItem(
        CUSTOM_PRESETS_KEY,
        JSON.stringify(this.customPresets),
      );
    } catch (error) {
      console.error("[ExportPresets] Failed to save custom presets:", error);
    }
  }

  getAllPresets(): PlatformExportPreset[] {
    return [...ALL_EXPORT_PRESETS, ...this.customPresets];
  }

  getPresetsByCategory(
    category: ExportPreset["category"],
  ): PlatformExportPreset[] {
    return this.getAllPresets().filter((p) => p.category === category);
  }

  getPresetsByPlatform(platform: string): PlatformExportPreset[] {
    return this.getAllPresets().filter((p) => p.platform === platform);
  }

  getPreset(id: string): PlatformExportPreset | undefined {
    return this.getAllPresets().find((p) => p.id === id);
  }

  getRecommendedPresets(): PlatformExportPreset[] {
    return this.getAllPresets().filter((p) => p.recommended);
  }

  getPlatforms(): string[] {
    const platforms = new Set(this.getAllPresets().map((p) => p.platform));
    return Array.from(platforms);
  }

  addCustomPreset(
    preset: Omit<PlatformExportPreset, "id">,
  ): PlatformExportPreset {
    const newPreset: PlatformExportPreset = {
      ...preset,
      id: `custom-${Date.now()}`,
      category: "custom",
    };
    this.customPresets.push(newPreset);
    this.saveCustomPresets();
    this.notify();
    return newPreset;
  }

  updateCustomPreset(
    id: string,
    updates: Partial<PlatformExportPreset>,
  ): boolean {
    const index = this.customPresets.findIndex((p) => p.id === id);
    if (index === -1) return false;

    this.customPresets[index] = { ...this.customPresets[index], ...updates };
    this.saveCustomPresets();
    this.notify();
    return true;
  }

  deleteCustomPreset(id: string): boolean {
    const index = this.customPresets.findIndex((p) => p.id === id);
    if (index === -1) return false;

    this.customPresets.splice(index, 1);
    this.saveCustomPresets();
    this.notify();
    return true;
  }

  getCustomPresets(): PlatformExportPreset[] {
    return [...this.customPresets];
  }

  isCustomPreset(id: string): boolean {
    return id.startsWith("custom-");
  }

  duplicatePreset(id: string, newName: string): PlatformExportPreset | null {
    const preset = this.getPreset(id);
    if (!preset) return null;

    return this.addCustomPreset({
      ...preset,
      name: newName,
      platform: "Custom",
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const exportPresetsManager = new ExportPresetsManager();
