import type {
  Template,
  TemplateCategory,
  TemplateTimeline,
  TemplateTrack,
  TemplateClip,
  TemplateSubtitle,
  TemplatePlaceholder,
  TemplateReplacements,
  TemplateSummary,
} from "../types/template";
import type { Project, MediaItem } from "../types/project";
import type { Clip, Subtitle, Timeline } from "../types/timeline";
import type {
  ScriptableTemplate,
  ExtendedPlaceholder,
  PlaceholderTarget,
  ScriptableTemplateReplacements,
  TemplateValidationError,
  TemplateApplicationResult,
  ExtendedPlaceholderConstraints,
} from "../types/scriptable-template";

import { LEGACY_IDB_TEMPLATES } from "../legacy/physical-identifiers";

// Persisted database name for user templates.
const TEMPLATE_DB_NAME = LEGACY_IDB_TEMPLATES;
const TEMPLATE_STORE_NAME = "templates";
const TEMPLATE_DB_VERSION = 1;

export class TemplateEngine {
  private db: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(TEMPLATE_DB_NAME, TEMPLATE_DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
          db.createObjectStore(TEMPLATE_STORE_NAME, { keyPath: "id" });
        }
      };
    });
  }

  createFromProject(
    project: Project,
    options: {
      name: string;
      description: string;
      category: TemplateCategory;
      placeholders: TemplatePlaceholder[];
      tags?: string[];
    },
  ): Template {
    const templateId = `template-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const templateTimeline = this.convertToTemplateTimeline(
      project.timeline,
      options.placeholders,
    );

    return {
      id: templateId,
      name: options.name,
      description: options.description,
      category: options.category,
      thumbnailUrl: null,
      previewUrl: null,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      settings: project.settings,
      timeline: templateTimeline,
      placeholders: options.placeholders,
      tags: options.tags || [],
      version: "1.0.0",
    };
  }

  private convertToTemplateTimeline(
    timeline: Project["timeline"],
    placeholders: TemplatePlaceholder[],
  ): TemplateTimeline {
    const placeholderIds = new Set(placeholders.map((p) => p.id));

    const templateTracks: TemplateTrack[] = timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        this.convertToTemplateClip(clip, placeholderIds),
      ),
    }));

    const templateSubtitles: TemplateSubtitle[] = timeline.subtitles.map(
      (sub) => ({
        ...sub,
        isPlaceholder: false,
      }),
    );

    return {
      ...timeline,
      tracks: templateTracks,
      subtitles: templateSubtitles,
    };
  }

  private convertToTemplateClip(
    clip: Clip,
    placeholderIds: Set<string>,
  ): TemplateClip {
    return {
      ...clip,
      isPlaceholder: placeholderIds.has(clip.mediaId),
      placeholderId: placeholderIds.has(clip.mediaId)
        ? clip.mediaId
        : undefined,
    };
  }

  applyTemplate(
    template: Template,
    replacements: TemplateReplacements,
  ): {
    project: Project;
    missingPlaceholders: string[];
    textClips: Array<{ id: string; text: string; placeholderId: string }>;
  } {
    if (template.projectSnapshot) {
      const now = Date.now();
      return {
        project: {
          ...structuredClone(template.projectSnapshot),
          id: crypto.randomUUID(),
          name: `${template.name} - Copy`,
          createdAt: now,
          modifiedAt: now,
        },
        missingPlaceholders: [],
        textClips: [],
      };
    }

    const missingPlaceholders: string[] = [];
    const textClips: Array<{
      id: string;
      text: string;
      placeholderId: string;
    }> = [];

    const effectiveReplacements = { ...replacements };
    for (const placeholder of template.placeholders) {
      if (!effectiveReplacements[placeholder.id] && placeholder.defaultValue) {
        effectiveReplacements[placeholder.id] = {
          type: placeholder.type,
          value: placeholder.defaultValue,
        };
      }
      if (placeholder.required && !effectiveReplacements[placeholder.id]) {
        missingPlaceholders.push(placeholder.label);
      }
    }

    const projectId = `project-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const mediaItems = this.createMediaFromReplacements(
      effectiveReplacements,
      template.placeholders,
    );

    const tracks = template.timeline.tracks.map((track) => {
      const clips = track.clips.map((clip) => {
        const resolved = this.resolveClipPlaceholder(
          clip,
          effectiveReplacements,
        );
        if (clip.isPlaceholder && clip.placeholderId) {
          const placeholder = template.placeholders.find(
            (p) => p.id === clip.placeholderId,
          );
          if (placeholder?.type === "text") {
            const textValue =
              effectiveReplacements[clip.placeholderId]?.value ||
              placeholder.defaultValue ||
              "Text";
            textClips.push({
              id: clip.id,
              text: textValue,
              placeholderId: clip.placeholderId,
            });
          }
        }
        return resolved;
      });
      return { ...track, clips };
    });

    const project: Project = {
      id: projectId,
      name: `${template.name} - Copy`,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      settings: template.settings,
      mediaLibrary: { items: mediaItems },
      ...(template.timeline.graphics ? {
        shapeClips: structuredClone(template.timeline.graphics.shapes),
        svgClips: structuredClone(template.timeline.graphics.svgs),
        stickerClips: structuredClone(template.timeline.graphics.stickers),
      } : {}),
      timeline: {
        ...template.timeline,
        tracks,
        subtitles: template.timeline.subtitles.map((sub) =>
          this.resolveSubtitlePlaceholder(sub, effectiveReplacements),
        ),
      },
    };

    return { project, missingPlaceholders, textClips };
  }

  private createMediaFromReplacements(
    replacements: TemplateReplacements,
    placeholders: TemplatePlaceholder[],
  ): MediaItem[] {
    const items: MediaItem[] = [];

    for (const placeholder of placeholders) {
      const replacement = replacements[placeholder.id];
      if (
        replacement &&
        replacement.type === "media" &&
        replacement.mediaBlob
      ) {
        items.push({
          id: placeholder.id,
          name: replacement.value,
          type: "image",
          fileHandle: null,
          blob: replacement.mediaBlob,
          metadata: {
            duration: 0,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: "",
            sampleRate: 0,
            channels: 0,
            fileSize: replacement.mediaBlob.size,
          },
          thumbnailUrl: null,
          waveformData: null,
        });
      }
    }

    return items;
  }

  private resolveClipPlaceholder(
    clip: TemplateClip,
    replacements: TemplateReplacements,
  ): Clip {
    if (!clip.isPlaceholder || !clip.placeholderId) {
      const { isPlaceholder, placeholderId, ...clipData } = clip;
      return clipData as Clip;
    }

    const replacement = replacements[clip.placeholderId];
    if (!replacement) {
      const { isPlaceholder, placeholderId, ...clipData } = clip;
      return clipData as Clip;
    }

    const { isPlaceholder, placeholderId, ...clipData } = clip;
    const preserveMediaId =
      clip.mediaId.startsWith("text-") ||
      clip.mediaId.startsWith("shape-") ||
      clip.mediaId.startsWith("svg-");
    return {
      ...clipData,
      mediaId: preserveMediaId ? clip.mediaId : clip.placeholderId,
    } as Clip;
  }

  private resolveSubtitlePlaceholder(
    subtitle: TemplateSubtitle,
    replacements: TemplateReplacements,
  ): Subtitle {
    if (!subtitle.isPlaceholder || !subtitle.placeholderId) {
      const { isPlaceholder, placeholderId, ...subData } = subtitle;
      return subData as Subtitle;
    }

    const replacement = replacements[subtitle.placeholderId];
    if (!replacement || replacement.type !== "text") {
      const { isPlaceholder, placeholderId, ...subData } = subtitle;
      return subData as Subtitle;
    }

    const { isPlaceholder, placeholderId, ...subData } = subtitle;
    return {
      ...subData,
      text: replacement.value,
    } as Subtitle;
  }

  resolvePropertyPath(
    obj: Record<string, unknown>,
    path: string,
  ): { parent: Record<string, unknown>; key: string; value: unknown } | null {
    const parts = path.split(".");
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);

      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        const arr = current[arrayName];
        if (!Array.isArray(arr)) return null;
        const index = parseInt(indexStr, 10);
        if (index < 0 || index >= arr.length) return null;
        current = arr[index] as Record<string, unknown>;
      } else {
        if (current[part] === undefined || current[part] === null) return null;
        if (typeof current[part] !== "object") return null;
        current = current[part] as Record<string, unknown>;
      }
    }

    const lastPart = parts[parts.length - 1];
    const lastArrayMatch = lastPart.match(/^(\w+)\[(\d+)\]$/);

    if (lastArrayMatch) {
      const [, arrayName, indexStr] = lastArrayMatch;
      const arr = current[arrayName];
      if (!Array.isArray(arr)) return null;
      const index = parseInt(indexStr, 10);
      return {
        parent: current,
        key: arrayName,
        value: arr[index],
      };
    }

    return {
      parent: current,
      key: lastPart,
      value: current[lastPart],
    };
  }

  setPropertyByPath(
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ): boolean {
    const resolved = this.resolvePropertyPath(obj, path);
    if (!resolved) return false;

    const { parent, key } = resolved;
    const lastPart = path.split(".").pop() || "";
    const arrayMatch = lastPart.match(/^(\w+)\[(\d+)\]$/);

    if (arrayMatch) {
      const [, arrayName, indexStr] = arrayMatch;
      const arr = parent[arrayName];
      if (!Array.isArray(arr)) return false;
      const index = parseInt(indexStr, 10);
      arr[index] = value;
    } else {
      parent[key] = value;
    }

    return true;
  }

  validatePlaceholderValue(
    placeholder: ExtendedPlaceholder,
    value: unknown,
  ): TemplateValidationError | null {
    if (
      placeholder.required &&
      (value === undefined || value === null || value === "")
    ) {
      return {
        placeholderId: placeholder.id,
        message: `${placeholder.label} is required`,
        type: "missing",
      };
    }

    if (value === undefined || value === null) return null;

    const constraints = placeholder.constraints as
      | ExtendedPlaceholderConstraints
      | undefined;

    switch (placeholder.type) {
      case "text":
      case "subtitle":
        if (typeof value !== "string") {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be a string`,
            type: "invalid",
          };
        }
        if (constraints?.maxLength && value.length > constraints.maxLength) {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} exceeds maximum length of ${constraints.maxLength}`,
            type: "constraint",
          };
        }
        if (constraints?.pattern) {
          const regex = new RegExp(constraints.pattern);
          if (!regex.test(value)) {
            return {
              placeholderId: placeholder.id,
              message: `${placeholder.label} does not match required pattern`,
              type: "constraint",
            };
          }
        }
        break;

      case "number":
        if (typeof value !== "number") {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be a number`,
            type: "invalid",
          };
        }
        if (constraints?.min !== undefined && value < constraints.min) {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be at least ${constraints.min}`,
            type: "constraint",
          };
        }
        if (constraints?.max !== undefined && value > constraints.max) {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be at most ${constraints.max}`,
            type: "constraint",
          };
        }
        break;

      case "boolean":
        if (typeof value !== "boolean") {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be a boolean`,
            type: "invalid",
          };
        }
        break;

      case "color":
        if (
          typeof value !== "string" ||
          !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
        ) {
          return {
            placeholderId: placeholder.id,
            message: `${placeholder.label} must be a valid hex color`,
            type: "invalid",
          };
        }
        break;
    }

    if (
      constraints?.allowedValues &&
      !constraints.allowedValues.includes(String(value))
    ) {
      return {
        placeholderId: placeholder.id,
        message: `${placeholder.label} must be one of: ${constraints.allowedValues.join(", ")}`,
        type: "constraint",
      };
    }

    return null;
  }

  applyScriptableTemplate(
    template: ScriptableTemplate,
    replacements: ScriptableTemplateReplacements,
  ): {
    project: Project;
    result: TemplateApplicationResult;
    textClips: Array<{
      id: string;
      text: string;
      placeholderId: string;
      trackId: string;
      startTime: number;
      duration: number;
      transform: unknown;
    }>;
  } {
    const errors: TemplateValidationError[] = [];
    const warnings: string[] = [];
    const textClips: Array<{
      id: string;
      text: string;
      placeholderId: string;
      trackId: string;
      startTime: number;
      duration: number;
      transform: unknown;
    }> = [];

    const effectiveReplacements = { ...replacements };
    for (const placeholder of template.placeholders) {
      if (
        !effectiveReplacements[placeholder.id] &&
        placeholder.defaultValue !== undefined
      ) {
        effectiveReplacements[placeholder.id] = {
          type: placeholder.type,
          value: placeholder.defaultValue,
        };
      }

      const validationError = this.validatePlaceholderValue(
        placeholder,
        effectiveReplacements[placeholder.id]?.value,
      );
      if (validationError) {
        errors.push(validationError);
      }
    }

    const projectId = `project-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timelineClone = JSON.parse(
      JSON.stringify(template.timeline),
    ) as Timeline;

    for (const placeholder of template.placeholders) {
      const replacement = effectiveReplacements[placeholder.id];
      if (!replacement) continue;

      for (const target of placeholder.targets) {
        this.applyPlaceholderToTarget(
          timelineClone,
          target,
          replacement.value,
          placeholder,
          warnings,
        );
      }

      if (placeholder.type === "text") {
        let foundTextClip = false;
        for (const target of placeholder.targets) {
          if (target.clipId) {
            for (const track of timelineClone.tracks) {
              const clip = track.clips.find((c) => c.id === target.clipId);
              if (clip) {
                textClips.push({
                  id: clip.id,
                  text: String(
                    replacement.value ?? placeholder.defaultValue ?? "",
                  ),
                  placeholderId: placeholder.id,
                  trackId: track.id,
                  startTime: clip.startTime,
                  duration: clip.duration,
                  transform: clip.transform,
                });
                foundTextClip = true;
                break;
              }
            }
          }
        }

        if (!foundTextClip) {
          for (const track of timelineClone.tracks) {
            for (const clip of track.clips) {
              const clipAny = clip as any;
              if (
                clipAny.isPlaceholder &&
                clipAny.placeholderId === placeholder.id
              ) {
                textClips.push({
                  id: clip.id,
                  text: String(
                    replacement.value ?? placeholder.defaultValue ?? "",
                  ),
                  placeholderId: placeholder.id,
                  trackId: track.id,
                  startTime: clip.startTime,
                  duration: clip.duration,
                  transform: clip.transform,
                });
                foundTextClip = true;
                break;
              }
            }
            if (foundTextClip) break;
          }
        }
      }
    }

    const mediaItems = this.createMediaFromScriptableReplacements(
      effectiveReplacements,
      template.placeholders,
    );

    const project: Project = {
      id: projectId,
      name: `${template.name} - Copy`,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      settings: template.settings,
      mediaLibrary: { items: mediaItems },
      timeline: timelineClone,
    };

    return {
      project,
      result: {
        success: errors.length === 0,
        errors,
        warnings,
      },
      textClips,
    };
  }

  private applyPlaceholderToTarget(
    timeline: Timeline,
    target: PlaceholderTarget,
    value: unknown,
    placeholder: ExtendedPlaceholder,
    warnings: string[],
  ): void {
    if (target.clipId) {
      for (const track of timeline.tracks) {
        const clip = track.clips.find((c) => c.id === target.clipId);
        if (clip) {
          const clipObj = clip as unknown as Record<string, unknown>;
          if (!this.setPropertyByPath(clipObj, target.property, value)) {
            warnings.push(
              `Failed to set ${target.property} on clip ${target.clipId}`,
            );
          }
          return;
        }
      }
      warnings.push(
        `Clip ${target.clipId} not found for placeholder ${placeholder.id}`,
      );
    } else if (target.trackId) {
      const track = timeline.tracks.find((t) => t.id === target.trackId);
      if (track) {
        const trackObj = track as unknown as Record<string, unknown>;
        if (!this.setPropertyByPath(trackObj, target.property, value)) {
          warnings.push(
            `Failed to set ${target.property} on track ${target.trackId}`,
          );
        }
      } else {
        warnings.push(
          `Track ${target.trackId} not found for placeholder ${placeholder.id}`,
        );
      }
    } else if (target.effectId) {
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          const effect = clip.effects.find((e) => e.id === target.effectId);
          if (effect) {
            const effectObj = effect as unknown as Record<string, unknown>;
            if (!this.setPropertyByPath(effectObj, target.property, value)) {
              warnings.push(
                `Failed to set ${target.property} on effect ${target.effectId}`,
              );
            }
            return;
          }
        }
      }
      warnings.push(
        `Effect ${target.effectId} not found for placeholder ${placeholder.id}`,
      );
    }
  }

  private createMediaFromScriptableReplacements(
    replacements: ScriptableTemplateReplacements,
    placeholders: ExtendedPlaceholder[],
  ): MediaItem[] {
    const items: MediaItem[] = [];

    for (const placeholder of placeholders) {
      const replacement = replacements[placeholder.id];
      if (
        replacement &&
        replacement.type === "media" &&
        replacement.mediaBlob
      ) {
        const blob = replacement.mediaBlob;
        const value = replacement.value;
        items.push({
          id: placeholder.id,
          name: typeof value === "string" ? value : placeholder.label,
          type: "image",
          fileHandle: null,
          blob,
          metadata: {
            duration: 0,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: "",
            sampleRate: 0,
            channels: 0,
            fileSize: blob.size,
          },
          thumbnailUrl: null,
          waveformData: null,
        });
      }
    }

    return items;
  }

  async saveTemplate(template: Template): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [TEMPLATE_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(TEMPLATE_STORE_NAME);
      const request = store.put(template);

      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  }

  async loadTemplate(id: string): Promise<Template | null> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [TEMPLATE_STORE_NAME],
        "readonly",
      );
      const store = transaction.objectStore(TEMPLATE_STORE_NAME);
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const template = request.result as Template | undefined;
        resolve(template || null);
      };
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    if (!this.db) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [TEMPLATE_STORE_NAME],
        "readwrite",
      );
      const store = transaction.objectStore(TEMPLATE_STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  }

  async listStoredTemplates(): Promise<Template[]> {
    if (!this.db) await this.initialize();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([TEMPLATE_STORE_NAME], "readonly");
      const request = transaction.objectStore(TEMPLATE_STORE_NAME).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as Template[]);
    });
  }

  async listTemplates(): Promise<TemplateSummary[]> {
    return (await this.listStoredTemplates()).map(this.toSummary);
  }

  private toSummary(template: Template): TemplateSummary {
    return {
      id: template.id,
      name: template.name,
      category: template.category,
      thumbnailUrl: template.thumbnailUrl,
      placeholderCount: template.placeholders.length,
      duration: template.timeline.duration,
    };
  }
}

export function createTemplateEngine(): TemplateEngine {
  return new TemplateEngine();
}
