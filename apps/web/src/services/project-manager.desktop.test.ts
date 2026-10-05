import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { projectManager } from "./project-manager";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.spyOn(projectManager, "addToRecent").mockResolvedValue();
  (window as any).reelterminal = {
    platform: "desktop",
    fs: {
      showSaveDialog: vi.fn(async () => "/tmp/proj.oreel"),
      showOpenDialog: vi.fn(async () => "/tmp/proj.oreel"),
      writeFile: vi.fn(async (p: string, d: string) => {
        store.set(p, d);
      }),
      readFile: vi.fn(async (p: string) => store.get(p) ?? ""),
    },
  };
});

afterEach(() => {
  delete (window as any).reelterminal;
  vi.restoreAllMocks();
});

const project: any = {
  id: "p1",
  name: "Demo",
  timeline: { duration: 1, tracks: [] },
};

describe("ProjectManager desktop fs", () => {
  it("uses the active project folder on each open, including after a storage relocation", async () => {
    const getInfo = vi.fn().mockResolvedValue({ active: true, projects: "E:/Library/projects" });
    (window as any).reelterminal.dataRoot = { getInfo };
    (window as any).reelterminal.fs.showOpenDialog.mockResolvedValue(null);
    await expect(projectManager.openProject()).resolves.toBeNull();
    expect((window as any).reelterminal.fs.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultDir: "E:/Library/projects" }));

    getInfo.mockResolvedValue({ active: true, projects: "D:/New Library/projects" });
    await projectManager.openProject();
    expect((window as any).reelterminal.fs.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultDir: "D:/New Library/projects" }));
  });

  it("does not pass an inactive data-root folder to the native picker", async () => {
    (window as any).reelterminal.dataRoot = { getInfo: vi.fn().mockResolvedValue({ active: false, projects: "" }) };
    (window as any).reelterminal.fs.showOpenDialog.mockResolvedValue(null);
    await projectManager.openProject();
    expect((window as any).reelterminal.fs.showOpenDialog).toHaveBeenCalledWith({ filters: [{ name: "ReelTerminal Project", extensions: ["oreel", "json"] }] });
  });
  it("saveProjectAs writes via window.reelterminal.fs and round-trips", async () => {
    const ok = await projectManager.saveProjectAs(project);
    expect(ok).toBe(true);
    expect((window as any).reelterminal.fs.writeFile).toHaveBeenCalled();
    const loaded = await projectManager.openProject();
    expect(loaded?.name).toBe("Demo");
  });
});
