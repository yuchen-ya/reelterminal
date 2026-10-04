import "../../../test/install-local-storage-mock";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeAppLanguage } from "../../../i18n";
import { classifyWhisperDownloadError } from "../../../utils/whisper-download-error";
import { AutoCaptionPanel } from "./AutoCaptionPanel";

/**
 * The GUI-observed failure (F05): downloading a caption model over an
 * unreachable network rendered the bare browser text "Failed to fetch"
 * in a bar below the visible panel area. The panel must classify the
 * worker's failure, show a localized explanation next to the Download
 * button (no scrolling), keep the raw message as a detail line, add the
 * local-inference note, and offer an explicit Retry that re-issues the
 * same download flow.
 */

type MessageListener = (event: { data: unknown }) => void;

class FakeWhisperWorker {
  static instances: FakeWhisperWorker[] = [];
  readonly postedMessages: Array<Record<string, unknown>> = [];
  /** The failure the next "load" request is answered with. */
  scriptedLoadFailure: unknown = null;
  private listeners = new Set<MessageListener>();

  constructor(public readonly url: URL | string) {
    FakeWhisperWorker.instances.push(this);
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: MessageListener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: Record<string, unknown>): void {
    this.postedMessages.push(message);
    if (message.type === "load" && this.scriptedLoadFailure) {
      // Mirror the real worker: classify while the Error instance is
      // alive, then post the protocol shape (message + code + status).
      const classified = classifyWhisperDownloadError(this.scriptedLoadFailure);
      this.emit({
        requestId: message.requestId,
        type: "error",
        message: classified.message,
        code: classified.kind,
        status: classified.status,
      });
    }
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data });
  }

  terminate(): void {}
}

function lastWorker(): FakeWhisperWorker {
  const worker = FakeWhisperWorker.instances.at(-1);
  if (!worker) throw new Error("No fake worker was created");
  return worker;
}

function loadRequestCount(): number {
  return lastWorker().postedMessages.filter((message) => message.type === "load").length;
}

async function renderPanel(): Promise<void> {
  await act(async () => {
    render(<AutoCaptionPanel />);
  });
}

/** Clicks trigger async handlers whose microtasks must flush inside act. */
async function clickAsync(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** Select changes are synchronous but re-render, so wrap them too. */
async function changeAsync(element: Element, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(element, { target: { value } });
  });
}

beforeEach(async () => {
  FakeWhisperWorker.instances = [];
  vi.stubGlobal("Worker", FakeWhisperWorker);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await act(async () => {
    await changeAppLanguage("en");
  });
});

describe("AutoCaptionPanel model download failure feedback", () => {
  it("shows the classified English network copy with the raw detail and a Retry next to the Download button", async () => {
    await renderPanel();
    const worker = lastWorker();
    worker.scriptedLoadFailure = new TypeError("Failed to fetch");

    await clickAsync(screen.getByRole("button", { name: "Download Large V3 Turbo" }));

    const alert = await screen.findByRole("alert");
    // Localized, understandable title (not the bare browser text)…
    expect(alert.textContent).toContain(
      "Could not reach the model download server for Large V3 Turbo",
    );
    // …with the actionable suggestion and the once-only size…
    expect(alert.textContent).toContain("Check your network connection and retry");
    expect(alert.textContent).toContain("About 760 MB");
    // …the local-inference note…
    expect(alert.textContent).toContain(
      "captioning itself always runs locally on your device",
    );
    // …and the raw message kept as a debugging detail.
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();

    // The retry re-issues the same download flow (a second "load").
    await clickAsync(screen.getByRole("button", { name: "Retry" }));
    expect(loadRequestCount()).toBe(2);
  });

  it("shows the classified Chinese copy and a 重试 button after switching language", async () => {
    await act(async () => {
      await changeAppLanguage("zh-CN");
    });
    await renderPanel();
    const worker = lastWorker();
    worker.scriptedLoadFailure = new TypeError("Failed to fetch");

    await clickAsync(screen.getByRole("button", { name: "下载 Large V3 Turbo" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法连接 Large V3 Turbo 的模型下载服务器");
    expect(alert.textContent).toContain("请检查网络连接后重试");
    expect(alert.textContent).toContain("约 760 MB");
    expect(alert.textContent).toContain("字幕识别始终在你的设备上本地运行");
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();

    await clickAsync(screen.getByRole("button", { name: "重试" }));
    expect(loadRequestCount()).toBe(2);
  });

  it("surfaces HTTP status failures with the status code in the title", async () => {
    await renderPanel();
    const worker = lastWorker();
    worker.scriptedLoadFailure = new Error(
      'Could not locate file: "https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped/resolve/main/config.json".',
    );

    await clickAsync(screen.getByRole("button", { name: "Download Large V3 Turbo" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The model server returned an error (HTTP 404)");
    expect(alert.textContent).toContain("Large V3 Turbo");
  });

  it("keeps unclassifiable failures honest: raw message only, no retry framing", async () => {
    await renderPanel();
    const worker = lastWorker();
    worker.scriptedLoadFailure = new Error("Something exploded unexpectedly");

    await clickAsync(screen.getByRole("button", { name: "Download Large V3 Turbo" }));

    // No alert role: the plain raw-message bar renders as before.
    await screen.findByText("Something exploded unexpectedly");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/always runs locally on your device/)).toBeNull();
  });

  it("clears the failure when a different model is selected", async () => {
    await renderPanel();
    const worker = lastWorker();
    worker.scriptedLoadFailure = new TypeError("Failed to fetch");

    await clickAsync(screen.getByRole("button", { name: "Download Large V3 Turbo" }));
    await screen.findByRole("alert");

    await changeAsync(screen.getByLabelText("Local caption model"), "fast");

    expect(await screen.findByRole("button", { name: "Download Whisper Tiny" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
