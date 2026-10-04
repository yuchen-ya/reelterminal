import { PRODUCTION_OPERATIONS } from "@reelterminal/core/types/media-production";
import { definePlugin, defineTool } from "../plugin-api";

export const mediaProductionPlugin = definePlugin({
  id: "media-production",
  tools: [
    defineTool({
      name: "media.production_list",
      effect: "read",
      description:
        "List project media version lineage and creator-declared production records. Filter by operation (including source frame segments) or candidate status; unrecorded media are not assumed original. Resizing is distinct from explicit external model enhancement. Use media.setProduction through edit.apply to update records and media.replace to apply a new file version.",
      input: {
        operation: {
          check: (v) =>
            (PRODUCTION_OPERATIONS as readonly unknown[]).includes(v),
          describe: "Production operation filter",
          emits: { kind: "leaf", schema: { enum: [...PRODUCTION_OPERATIONS] } },
        },
        status: {
          check: (v) =>
            ["pending", "adopted", "rejected"].includes(v as string),
          describe: "Candidate status filter",
          emits: {
            kind: "leaf",
            schema: { enum: ["pending", "adopted", "rejected"] },
          },
        },
      },
      output: { type: "object", additionalProperties: true, properties: {} },
      schemaCases: [
        { name: "all", params: {}, expectValid: true },
        {
          name: "generated",
          params: { operation: "generation" },
          expectValid: true,
        },
        {
          name: "unknown status",
          params: { status: "deleted" },
          expectValid: false,
        },
      ],
      async execute(input: { operation?: string; status?: string }, context) {
        const { project, revision } = await context.snapshot();
        return {
          projectId: project.id,
          revision,
          items: project.mediaLibrary.items
            .filter(
              (item) =>
                (!input.status || item.production?.status === input.status) &&
                (!input.operation ||
                  item.production?.steps.some(
                    (step) => step.operation === input.operation,
                  )),
            )
            .map((item) => ({
              mediaId: item.id,
              name: item.displayName ?? item.name,
              production: item.production ?? null,
              versionSource: item.versionSource ?? null,
              usedByClipIds: project.timeline.tracks.flatMap((track) =>
                track.clips
                  .filter((clip) => clip.mediaId === item.id)
                  .map((clip) => clip.id),
              ),
            })),
        };
      },
    }),
  ],
});
