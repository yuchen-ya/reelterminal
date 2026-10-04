import { describe, expect, it } from "vitest";
import {
  classifyWhisperDownloadError,
  whisperDownloadFailureCopy,
} from "./whisper-download-error";

/**
 * The caption model download fails over fetch in the whisper worker.
 * Classification must be evidence-backed: only the engine wordings of a
 * fetch rejection (the GUI-observed "Failed to fetch"), the
 * transformers.js HTTP failure phrases (hub.js ERROR_MAPPING / generic
 * "Error (NNN) …" of @huggingface/transformers 3.8.1), and browser
 * storage failures map to a kind. Everything else stays "unknown" so
 * the UI keeps the raw message instead of inventing a cause.
 */

describe("classifyWhisperDownloadError", () => {
  it("classifies the Chromium fetch rejection as a network failure", () => {
    const classified = classifyWhisperDownloadError(new TypeError("Failed to fetch"));
    expect(classified.kind).toBe("network");
    expect(classified.status).toBeUndefined();
    expect(classified.message).toBe("Failed to fetch");
  });

  it("classifies the WebKit and Firefox fetch rejections as network failures", () => {
    expect(classifyWhisperDownloadError(new TypeError("Load failed")).kind).toBe(
      "network",
    );
    expect(
      classifyWhisperDownloadError(
        new TypeError("NetworkError when attempting to fetch resource"),
      ).kind,
    ).toBe("network");
  });

  it("classifies string-thrown fetch rejections as network failures", () => {
    // Values crossing informal boundaries are not always Error instances.
    expect(classifyWhisperDownloadError("Failed to fetch").kind).toBe("network");
  });

  it("maps the transformers.js HTTP failure phrases to their status codes", () => {
    const notFound = classifyWhisperDownloadError(
      new Error(
        'Could not locate file: "https://huggingface.co/example/resolve/main/config.json".',
      ),
    );
    expect(notFound.kind).toBe("http");
    expect(notFound.status).toBe(404);

    const forbidden = classifyWhisperDownloadError(
      new Error('Forbidden access to file: "https://example.invalid/model.onnx".'),
    );
    expect(forbidden.kind).toBe("http");
    expect(forbidden.status).toBe(403);
  });

  it("extracts the status from the generic transformers.js HTTP wording", () => {
    const classified = classifyWhisperDownloadError(
      new Error(
        'Error (503) occurred while trying to load file: "https://example.invalid/model.onnx".',
      ),
    );
    expect(classified.kind).toBe("http");
    expect(classified.status).toBe(503);
  });

  it("classifies browser storage failures as storage problems", () => {
    expect(
      classifyWhisperDownloadError(
        new Error("Browser cache is not available in this environment."),
      ).kind,
    ).toBe("storage");

    const quota = classifyWhisperDownloadError(
      new DOMException("The quota has been exceeded.", "QuotaExceededError"),
    );
    expect(quota.kind).toBe("storage");
  });

  it("keeps unclassifiable failures unknown instead of guessing a cause", () => {
    const classified = classifyWhisperDownloadError(
      new Error("Something exploded unexpectedly"),
    );
    expect(classified.kind).toBe("unknown");
    expect(classified.message).toBe("Something exploded unexpectedly");
  });

  it("does not mistake unrelated failures with similar words for network errors", () => {
    // "Upload failed" must not match the "load failed" network wording
    // (same word-boundary rule as the cloud error classifier).
    expect(classifyWhisperDownloadError(new Error("Upload failed with status 500")).kind).toBe(
      "unknown",
    );
  });
});

describe("whisperDownloadFailureCopy", () => {
  const context = { model: "Large V3 Turbo", size: "About 760 MB" };

  it("returns localized copy for classified kinds", () => {
    expect(
      whisperDownloadFailureCopy({ kind: "network", rawMessage: "Failed to fetch" }, context),
    ).toEqual({
      key: "captions.modelDownloadFailure.network",
      options: { model: "Large V3 Turbo", size: "About 760 MB" },
    });
    expect(
      whisperDownloadFailureCopy(
        { kind: "http", status: 404, rawMessage: "Could not locate file" },
        context,
      )?.options,
    ).toEqual({ model: "Large V3 Turbo", status: 404 });
    expect(
      whisperDownloadFailureCopy({ kind: "storage", rawMessage: "quota" }, context)?.key,
    ).toBe("captions.modelDownloadFailure.storage");
  });

  it("returns null for unknown kinds so the raw message stays the title", () => {
    expect(
      whisperDownloadFailureCopy(
        { kind: "unknown", rawMessage: "Something exploded unexpectedly" },
        context,
      ),
    ).toBeNull();
  });
});
