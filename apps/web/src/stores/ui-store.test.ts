import "../test/install-local-storage-mock";
import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./ui-store";

describe("ui-store inspectorActiveTab", () => {
  beforeEach(() => {
    useUIStore.setState({ inspectorActiveTab: "transform" });
  });

  it("defaults to transform", () => {
    expect(useUIStore.getState().inspectorActiveTab).toBe("transform");
  });

  it("setInspectorActiveTab updates the value", () => {
    useUIStore.getState().setInspectorActiveTab("color");
    expect(useUIStore.getState().inspectorActiveTab).toBe("color");
  });
});

describe("ui-store conversation panel migration", () => {
  it("drops obsolete chat panel preferences while keeping editor panel preferences", () => {
    const migrated = useUIStore.persist.getOptions().migrate?.(
      {
        panels: {
          agentChat: { visible: true },
          externalAgent: { visible: true, width: 380 },
          audioMixer: { visible: true, width: 420 },
        },
      },
      4,
    ) as { panels: Record<string, unknown> };

    expect(migrated.panels.externalAgent).toBeUndefined();
    expect(migrated.panels.agentChat).toBeUndefined();
    expect(migrated.panels.audioMixer).toMatchObject({ visible: true, width: 420 });
    expect(migrated.panels.mediaLibrary).toBeDefined();
  });
});
