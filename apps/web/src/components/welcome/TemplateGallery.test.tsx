import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * TemplateGallery merges built-in templates with cloud templates. These
 * tests pin down the build-time cloud opt-out:
 * - off: an explicit disabled state is rendered and no request is made,
 *   even though the gallery mounts immediately.
 * - default: the mount-time cloud fetch still happens (unchanged behavior).
 */

const engineStub = vi.hoisted(() => {
  const state = { builtins: [] as unknown[] };

  const makeBuiltin = () => ({
    id: "builtin-test",
    name: "Builtin Test Template",
    description: "A local fixture template",
    category: "custom",
    thumbnailUrl: null,
    previewUrl: null,
    createdAt: 0,
    modifiedAt: 0,
    tags: ["fixture"],
    placeholders: [],
    timeline: { duration: 5, tracks: [] },
    settings: {},
  });

  const getTemplateEngine = async () => ({
    initialize: async () => undefined,
    getBuiltinTemplates: () => state.builtins,
    listTemplates: async () => [],
  });

  return { state, makeBuiltin, getTemplateEngine };
});

vi.mock("../../stores/engine-store", () => ({
  useEngineStore: (selector: (state: unknown) => unknown) =>
    selector({ getTemplateEngine: engineStub.getTemplateEngine }),
}));

function clearCloudEnv(): void {
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD;
}

async function renderGallery() {
  vi.resetModules();
  const { TemplateGallery } = await import("./TemplateGallery");
  return render(<TemplateGallery />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCloudEnv();
  engineStub.state.builtins = [];
});

describe("TemplateGallery cloud opt-out", () => {
  it("renders an explicit disabled state and issues zero requests when VITE_OPENREEL_CLOUD=off", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    engineStub.state.builtins = [engineStub.makeBuiltin()];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await renderGallery();

    // Built-in templates still load and render.
    expect(await screen.findAllByText("Builtin Test Template")).not.toHaveLength(0);
    // The disabled state is explicit, not a silent empty list.
    expect(screen.getByTestId("cloud-templates-disabled")).toBeInTheDocument();
    expect(screen.getAllByText("Cloud templates disabled").length).toBeGreaterThan(0);
    // Zero cloud requests despite the mount-time load.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the disabled copy as the empty state when the cloud is off and no built-ins exist", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await renderGallery();

    expect(await screen.findByTestId("cloud-templates-disabled")).toBeInTheDocument();
    expect(screen.getAllByText("Cloud templates disabled").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Built-in templates are still available/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the mount-time cloud fetch by default (no env set)", async () => {
    clearCloudEnv();
    engineStub.state.builtins = [engineStub.makeBuiltin()];
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await renderGallery();

    expect(await screen.findAllByText("Builtin Test Template")).not.toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/templates/scriptable");
    expect(screen.queryByTestId("cloud-templates-disabled")).toBeNull();
  });

  // B06 fault simulation: with the cloud enabled, a network failure must
  // not silently render the ordinary "No templates found" empty state.
  it("shows a load-failure empty state with retry when the cloud fetch rejects (cloud on)", async () => {
    clearCloudEnv();
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    await renderGallery();

    // Distinct failure empty state, not the "No templates found" state.
    expect(await screen.findByTestId("cloud-templates-failed-empty")).toBeInTheDocument();
    expect(screen.getAllByText("Cloud templates failed to load").length).toBeGreaterThan(0);
    expect(screen.queryByText("No templates found")).toBeNull();

    // Retry re-runs the load; once the network recovers, the failure state
    // clears (single user-driven retry, no automatic retry loop).
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });
    fireEvent.click(screen.getByTestId("cloud-templates-retry-empty"));

    expect(await screen.findByText("No templates found")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-templates-failed-empty")).toBeNull();
  });

  it("shows a failure banner beside built-in templates when the cloud is unreachable", async () => {
    clearCloudEnv();
    engineStub.state.builtins = [engineStub.makeBuiltin()];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await renderGallery();

    expect(await screen.findAllByText("Builtin Test Template")).not.toHaveLength(0);
    expect(await screen.findByTestId("cloud-templates-failed")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-templates-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-templates-disabled")).toBeNull();
  });
});
