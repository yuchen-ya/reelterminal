import { describe, expect, it } from "vitest";
import {
  EMITTED_VERB_JSON_SCHEMAS,
  EMITTED_VERB_OUTPUT_JSON_SCHEMAS,
  FACADE_VERBS,
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
} from "./index";
import { getCommandCatalog, getCommandCatalogEntry } from "./command-catalog";
import { REVIEW_DESCRIPTIONS, REVIEW_SCHEMAS } from "./review";
import { WORKBENCH_INGEST_ITEM_SCHEMA } from "./workbench";

describe("protocol-neutral command catalog", () => {
  it("derives every headless command, including plugins, from the facade registry", () => {
    const catalog = getCommandCatalog("headless");
    expect(catalog.map((entry) => entry.name)).toEqual(FACADE_VERBS);
    for (const entry of catalog) {
      expect(entry.toolName).toBe(entry.name.replace(/\./g, "_"));
      expect(entry.inputSchema).toBe(EMITTED_VERB_JSON_SCHEMAS[entry.name]);
      expect(entry.outputSchema).toBe(EMITTED_VERB_OUTPUT_JSON_SCHEMAS[entry.name]);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.effects.length).toBeGreaterThan(0);
      expect(["safe", "idempotent", "never"]).toContain(entry.retry);
    }
  });

  it("uses live schemas and descriptions where live behavior differs", () => {
    const catalog = getCommandCatalog("live");
    expect(catalog.map((entry) => entry.name)).toEqual(FACADE_VERBS);
    for (const [name, schema] of Object.entries(LIVE_VERB_INPUT_SCHEMA_OVERRIDES)) {
      const entry = getCommandCatalogEntry(name, "live");
      expect(entry?.inputSchema).toBe(schema);
    }
    expect(getCommandCatalogEntry("project.save", "live")?.inputSchema)
      .not.toBe(EMITTED_VERB_JSON_SCHEMAS["project.save"]);
  });

  it("marks read, mutation, task, filesystem and retry behavior explicitly", () => {
    expect(getCommandCatalogEntry("timeline.query", "live")).toMatchObject({
      effects: ["read"],
      retry: "safe",
    });
    expect(getCommandCatalogEntry("edit.apply", "live")).toMatchObject({
      effects: ["write"],
      retry: "idempotent",
    });
    expect(getCommandCatalogEntry("media.analyze_start", "live")).toMatchObject({
      effects: ["read", "task", "filesystem"],
      retry: "never",
    });
    expect(getCommandCatalogEntry("audio.process.normalize", "live")).toMatchObject({
      effects: ["write", "task", "filesystem"],
      retry: "never",
    });
    expect(getCommandCatalogEntry("audio.process.register", "live")).toMatchObject({
      effects: ["write", "filesystem"],
      retry: "idempotent",
    });
    expect(getCommandCatalogEntry("media.inspect", "live")).toMatchObject({
      effects: ["read", "task", "filesystem"],
      retry: "never",
    });
    expect(getCommandCatalogEntry("media.import_preflight", "live")).toMatchObject({
      effects: ["read", "filesystem"],
      retry: "safe",
    });
    expect(getCommandCatalogEntry("editor.control", "live")?.effects).toContain("write");
  });

  it("resolves canonical dotted names without accepting compatibility aliases", () => {
    expect(getCommandCatalogEntry("edit.apply", "live")?.toolName).toBe("edit_apply");
    expect(getCommandCatalogEntry("edit_apply", "live")).toBeUndefined();
    expect(getCommandCatalogEntry("unknown.command", "live")).toBeUndefined();
  });

  it("exposes shared review guidance through nested command schemas", () => {
    const ingest = getCommandCatalogEntry("review.ingest", "live")!;
    const item = (ingest.inputSchema.properties.items as {
      items: { properties: Record<string, { description: string; properties: Record<string, { description: string }> }> };
    }).items.properties;
    for (const field of ["title", "groupMode", "compareWithItemId"]) {
      expect(item[field].description).toBe(WORKBENCH_INGEST_ITEM_SCHEMA[field].describe);
    }
    expect(item.agentGuidance.properties.nodeSlotLabel.description).toContain("4–8 Chinese characters");
    expect(item.lineage.properties.parentNodeId.description).toContain("parent item id");
    expect(ingest.inputSchema.properties.name.description).toBe(REVIEW_SCHEMAS["review.ingest"].name.describe);
    expect(ingest.inputSchema.properties.target.description).toContain("fixed across GUI selection changes");
    expect(JSON.stringify(getCommandCatalogEntry("review.steps.complete", "live")?.inputSchema))
      .toContain(WORKBENCH_INGEST_ITEM_SCHEMA.title.describe);

    const apply = getCommandCatalogEntry("review.apply", "live")!;
    expect(apply.description).toBe(REVIEW_DESCRIPTIONS["review.apply"]);
    expect(apply.description).toContain("review.handoff.get and review.versions.get");
    expect(JSON.stringify(apply.inputSchema)).toContain("must be the live version");
    expect(JSON.stringify(apply.inputSchema)).toContain("capabilities mediaImport.mediaRoots");
    // Naming advice stays guidance; the actual boundary still owns constraints.
    expect(item.title).not.toHaveProperty("maxLength", 15);
    expect(ingest.inputSchema.required).toContain("expectedNodeRevision");
  });
});
