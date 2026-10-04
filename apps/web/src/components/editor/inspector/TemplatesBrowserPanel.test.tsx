import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The inspector templates browser merges local templates with cloud
 * templates through the failure-aware `listTemplatesWithStatus`. These
 * tests pin down that "cloud unreachable" renders a distinct failure
 * state with retry instead of silently reading as "no templates", and
 * that the off build's disabled banner keeps priority.
 */

const engineStub = vi.hoisted(() => {
  const state = { local: [] as unknown[] };

  const makeLocal = () => ({
    id: "local-test",
    name: "Local Test Template",
    category: "custom",
    thumbnailUrl: null,
    placeholderCount: 0,
    duration: 5,
  });

  const getTemplateEngine = async () => ({
    initialize: async () => undefined,
    listTemplates: async () => state.local,
    loadTemplate: async () => null,
    applyTemplate: () => {
      throw new Error("not used in these tests");
    },
  });

  return { state, makeLocal, getTemplateEngine };
});

vi.mock("../../../stores/engine-store", () => ({
  useEngineStore: (selector: (state: unknown) => unknown) =>
    selector({ getTemplateEngine: engineStub.getTemplateEngine }),
}));

function clearCloudEnv(): void {
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD;
}

async function renderBrowser() {
  vi.resetModules();
  const { TemplatesBrowserPanel } = await import("./TemplatesBrowserPanel");
  return render(<TemplatesBrowserPanel />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCloudEnv();
  engineStub.state.local = [];
});

describe("TemplatesBrowserPanel cloud load failure", () => {
  it("shows a failure banner with retry beside local templates when the cloud fetch rejects", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "on");
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://backend.example");
    engineStub.state.local = [engineStub.makeLocal()];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await renderBrowser();

    // Local templates still render…
    expect(
      await screen.findAllByText("Local Test Template"),
    ).not.toHaveLength(0);
    // …next to an explicit failure banner with a retry affordance.
    expect(
      await screen.findByTestId("cloud-templates-failed"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("cloud-templates-retry")).toBeInTheDocument();
    // The failure must not be reported as "no templates".
    expect(screen.queryByText("No templates in this category")).toBeNull();
    // And an enabled build must not show the disabled banner.
    expect(screen.queryByTestId("cloud-templates-disabled")).toBeNull();
  });

  it("keeps the failed state distinct from the empty state and clears it after a successful retry", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "on");
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://backend.example");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    await renderBrowser();

    // No local and no cloud templates: the failure empty state (with
    // retry) replaces the ordinary empty state, so "cloud unreachable"
    // never reads as "no templates in this category".
    expect(
      await screen.findByTestId("cloud-templates-failed-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Cloud templates failed to load").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("No templates in this category")).toBeNull();

    // Manual retry re-issues the load once; after the cloud recovers,
    // the failure state clears and the ordinary empty state returns.
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });
    fireEvent.click(screen.getByTestId("cloud-templates-retry-empty"));

    expect(
      await screen.findByText("No templates in this category"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-templates-failed-empty")).toBeNull();
    expect(screen.queryByTestId("cloud-templates-failed")).toBeNull();
  });

  it("keeps the off build's disabled banner authoritative with no failure state and zero requests", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    engineStub.state.local = [engineStub.makeLocal()];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await renderBrowser();

    expect(
      await screen.findAllByText("Local Test Template"),
    ).not.toHaveLength(0);
    expect(screen.getByTestId("cloud-templates-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-templates-failed")).toBeNull();
    expect(screen.queryByTestId("cloud-templates-failed-empty")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the success path unchanged: cloud templates render and no state banner appears", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_REELTERMINAL_CLOUD", "on");
    vi.stubEnv("VITE_REELTERMINAL_CLOUD_URL", "https://backend.example");
    engineStub.state.local = [engineStub.makeLocal()];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          templates: [
            {
              id: "cloud-1",
              name: "Cloud Fixture",
              category: "custom",
              thumbnailUrl: null,
              placeholderCount: 0,
              duration: 8,
            },
          ],
        }),
      }),
    );

    await renderBrowser();

    expect(await screen.findByText("Cloud Fixture")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-templates-failed")).toBeNull();
    expect(screen.queryByTestId("cloud-templates-failed-empty")).toBeNull();
    expect(screen.queryByTestId("cloud-templates-disabled")).toBeNull();
  });
});
