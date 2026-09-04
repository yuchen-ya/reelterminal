import "../test/install-local-storage-mock";
import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore, type PanelState } from "./ui-store";

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

describe("ui-store externalAgent floating geometry", () => {
  const initialPanels = structuredClone(useUIStore.getState().panels);

  beforeEach(() => {
    useUIStore.setState({ panels: structuredClone(initialPanels) });
  });

  it("has floating defaults for the externalAgent panel", () => {
    expect(useUIStore.getState().panels.externalAgent).toMatchObject({
      visible: false,
      width: 400,
      height: 560,
      minimized: false,
      maximized: false,
    });
  });

  it("setPanelGeometry updates position and size", () => {
    useUIStore
      .getState()
      .setPanelGeometry("externalAgent", {
        x: 10,
        y: 20,
        width: 500,
        height: 600,
      });

    expect(useUIStore.getState().panels.externalAgent).toMatchObject({
      x: 10,
      y: 20,
      width: 500,
      height: 600,
    });
  });

  it("setPanelMaximized stores restoreBounds and restores them on unmaximize", () => {
    const restore = { x: 10, y: 20, width: 500, height: 600 };
    useUIStore.getState().setPanelGeometry("externalAgent", restore);
    useUIStore.getState().setPanelMaximized("externalAgent", true, restore);

    let panel = useUIStore.getState().panels.externalAgent;
    expect(panel.maximized).toBe(true);
    expect(panel.restoreBounds).toEqual(restore);

    useUIStore.getState().setPanelMaximized("externalAgent", false);
    panel = useUIStore.getState().panels.externalAgent;
    expect(panel.maximized).toBe(false);
    expect(panel.restoreBounds).toBeNull();
    expect(panel).toMatchObject(restore);
  });

  it("togglePanel restores a minimized externalAgent window instead of hiding it", () => {
    useUIStore.getState().setPanelVisible("externalAgent", true);
    useUIStore.getState().setPanelMinimized("externalAgent", true);

    useUIStore.getState().togglePanel("externalAgent");
    let panel = useUIStore.getState().panels.externalAgent;
    expect(panel.visible).toBe(true);
    expect(panel.minimized).toBe(false);

    useUIStore.getState().togglePanel("externalAgent");
    panel = useUIStore.getState().panels.externalAgent;
    expect(panel.visible).toBe(false);
  });

  it("migrates a v3 persisted state by filling floating-window defaults", () => {
    const migrated = useUIStore.persist.getOptions().migrate?.(
      { panels: { externalAgent: { visible: true, width: 380 } } },
      3,
    ) as unknown as { panels: Record<string, PanelState> };

    expect(migrated.panels.externalAgent).toMatchObject({
      visible: true,
      width: 380,
      height: 560,
      minimized: false,
      maximized: false,
    });
  });
});
