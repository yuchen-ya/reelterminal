import "../test/install-local-storage-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useDesktopExportStore,
  type DesktopExportSession,
} from "./desktop-export-store";

function session(exportId: string): DesktopExportSession {
  return {
    target: {
      projectId: "project",
      workspaceId: "workspace",
      exportId,
      revision: 4,
    },
    projectName: "Movie",
    startedAt: 1,
    outputPath: "E:\\output.mp4",
    state: {
      isExporting: true,
      progress: 0,
      phase: "rendering",
      error: null,
      complete: false,
    },
    ownership: {
      kind: "output",
      purpose: "Video export",
      origin: "product",
      projectId: "project",
      workspaceId: "workspace",
      deliveryStatus: "pending",
    },
  };
}

describe("desktop export ownership and delivery", () => {
  beforeEach(() => {
    useDesktopExportStore.setState({
      session: null,
      outputs: [],
      cancel: null,
    });
    localStorage.clear();
  });

  it("records one delivered output and ignores a previous export's late progress", () => {
    useDesktopExportStore.getState().begin(session("old"), () => {});
    useDesktopExportStore.getState().begin(session("new"), () => {});
    const complete = {
      isExporting: false,
      progress: 100,
      phase: "Saved!",
      error: null,
      complete: true,
    };
    useDesktopExportStore.getState().update("old", complete);
    expect(useDesktopExportStore.getState().session?.target.exportId).toBe(
      "new",
    );
    expect(
      useDesktopExportStore
        .getState()
        .outputs.every(
          (record) => record.ownership.deliveryStatus === "pending",
        ),
    ).toBe(true);
    useDesktopExportStore.getState().update("new", complete);
    useDesktopExportStore.getState().update("new", complete);
    const outputs = useDesktopExportStore.getState().outputs;
    expect(
      outputs.filter(
        (record) => record.ownership.deliveryStatus === "delivered",
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem("reelterminal-export-deliveries")!).state
        .outputs,
    ).toEqual(outputs);
  });

  it("keeps failed attempts as work instead of claiming a completed delivery", () => {
    useDesktopExportStore.getState().begin(session("failed"), () => {});
    useDesktopExportStore
      .getState()
      .update("failed", {
        isExporting: false,
        progress: 20,
        phase: "encoding",
        error: "Disk full",
        complete: false,
      });
    expect(useDesktopExportStore.getState().outputs[0].ownership).toMatchObject(
      {
        kind: "work",
        deliveryStatus: "pending",
        projectId: "project",
        workspaceId: "workspace",
      },
    );
  });
});
