import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fault simulation: when the remote default 3D text font fails to
 * load, the 3D stage shows a degradation notice with an explicit retry
 * entry; the success path renders nothing (no UI change when the font
 * loads normally). No automatic retries happen anywhere.
 */

const originalFetch = window.fetch;
const fontUrl =
  "https://threejs.org/examples/fonts/helvetiker_bold.typeface.json";

async function loadFresh() {
  vi.resetModules();
  const status = await import("../text3d-font-status");
  const { Text3DFontFailureNotice } = await import("./Text3DFontFailureNotice");
  return { status, Text3DFontFailureNotice };
}

afterEach(() => {
  cleanup();
  window.fetch = originalFetch;
});

describe("Text3DFontFailureNotice", () => {
  it("renders nothing when the font loads (success path unchanged)", async () => {
    const { status, Text3DFontFailureNotice } = await loadFresh();
    status.installText3DFontFetchObserver();
    window.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
    ) as unknown as typeof window.fetch;

    await window.fetch(fontUrl);

    render(<Text3DFontFailureNotice onRetry={vi.fn()} />);
    expect(screen.queryByTestId("text3d-font-failure")).toBeNull();
  });

  it("shows the degradation notice and retry entry when the font fetch fails", async () => {
    const { status, Text3DFontFailureNotice } = await loadFresh();
    // The mock must be in place BEFORE installing the observer so the
    // patched fetch wraps it (same order as production fetch usage).
    window.fetch = vi.fn(() =>
      Promise.reject(new Error("ERR_CONNECTION_FAILED")),
    ) as unknown as typeof window.fetch;
    status.installText3DFontFetchObserver();

    await expect(window.fetch(fontUrl)).rejects.toThrow("ERR_CONNECTION_FAILED");

    render(<Text3DFontFailureNotice onRetry={vi.fn()} />);

    // Visible feedback appears instead of the text silently missing.
    expect(screen.getByTestId("text3d-font-failure")).toBeInTheDocument();
    expect(screen.getByText("3D text font failed to load")).toBeInTheDocument();
    expect(screen.getByTestId("text3d-font-retry")).toBeInTheDocument();
  });

  it("clears the notice after a user retry succeeds and stays gone without auto-retry", async () => {
    const { status, Text3DFontFailureNotice } = await loadFresh();
    const fetchMock = vi.fn<[], Promise<Response>>(() =>
      Promise.reject(new Error("ERR_CONNECTION_FAILED")),
    );
    window.fetch = fetchMock as unknown as typeof window.fetch;
    status.installText3DFontFetchObserver();

    await expect(window.fetch(fontUrl)).rejects.toThrow();

    const onRetry = vi.fn(() => {
      // The stage retry re-renders with a fresh renderer, which re-fetches
      // the font — this time successfully.
      fetchMock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 } as unknown as Response),
      );
      void window.fetch(fontUrl);
    });

    render(<Text3DFontFailureNotice onRetry={onRetry} />);
    expect(screen.getByTestId("text3d-font-failure")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("text3d-font-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(screen.queryByTestId("text3d-font-failure")).toBeNull(),
    );
    // Exactly one retry fetch was issued by the (simulated) stage retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
