import { describe, expect, it } from "vitest";
import {
  EMITTED_VERB_JSON_SCHEMAS,
  EMITTED_VERB_OUTPUT_JSON_SCHEMAS,
  FACADE_VERBS,
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
} from "./index";
import { getCommandCatalog, getCommandCatalogEntry } from "./command-catalog";

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

  it("resolves canonical dotted names without accepting MCP aliases", () => {
    expect(getCommandCatalogEntry("edit.apply", "live")?.toolName).toBe("edit_apply");
    expect(getCommandCatalogEntry("edit_apply", "live")).toBeUndefined();
    expect(getCommandCatalogEntry("unknown.command", "live")).toBeUndefined();
  });
});
