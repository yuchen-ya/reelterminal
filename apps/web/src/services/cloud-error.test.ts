import { describe, expect, it } from "vitest";
import { CloudRequestError } from "@openreel/core";
import {
  classifyCloudError,
  cloudFailureMessage,
} from "./cloud-error";

/**
 * The classifier is the single place that turns raw cloud-request
 * failures (fetch rejections, HTTP status errors, job failures,
 * timeouts, unparseable bodies) into categories the UI can present with
 * localized, understandable wording.
 */

describe("classifyCloudError", () => {
  it("passes structured cloud errors through with their kind and status", () => {
    const classified = classifyCloudError(
      new CloudRequestError("server", "Transcription failed: 503 - overloaded", 503),
    );
    expect(classified).toEqual({
      kind: "server",
      status: 503,
      detail: "Transcription failed: 503 - overloaded",
      cloudOrigin: true,
    });
  });

  it("treats a structured error without a status as a service-reported job failure", () => {
    const classified = classifyCloudError(
      new CloudRequestError("taskFailed", "Audio too long for this job"),
    );
    expect(classified.kind).toBe("taskFailed");
    expect(classified.status).toBeUndefined();
    expect(classified.cloudOrigin).toBe(true);
  });

  it("classifies browser fetch rejections as network failures", () => {
    expect(classifyCloudError(new TypeError("Failed to fetch")).kind).toBe(
      "network",
    );
    // WebKit wording, matched for robustness.
    expect(classifyCloudError(new TypeError("Load failed")).kind).toBe(
      "network",
    );
  });

  it("classifies wrapped unreachable-service errors as network failures", () => {
    const classified = classifyCloudError(
      new Error(
        "Could not reach the transcription service (Failed to fetch)",
      ),
    );
    expect(classified.kind).toBe("network");
    expect(classified.cloudOrigin).toBe(true);
    expect(classified.detail).toContain("Failed to fetch");
  });

  it("classifies submit and job timeouts", () => {
    expect(
      classifyCloudError(
        new CloudRequestError(
          "timeout",
          "Transcription upload timed out after 120 seconds",
        ),
      ).kind,
    ).toBe("timeout");
    expect(
      classifyCloudError(new Error("Transcription timed out after 6 minutes"))
        .kind,
    ).toBe("timeout");
  });

  it("classifies unparseable 2xx responses", () => {
    expect(
      classifyCloudError(new SyntaxError("Unexpected token '<' in JSON"))
        .kind,
    ).toBe("responseInvalid");
    expect(
      classifyCloudError(
        new Error(
          "Transcription service returned a response that is not valid JSON",
        ),
      ).kind,
    ).toBe("responseInvalid");
  });

  it("maps plain-string HTTP status failures via backstops", () => {
    const server = classifyCloudError(new Error("API error: 503"));
    expect(server.kind).toBe("server");
    expect(server.status).toBe(503);

    const limited = classifyCloudError(
      new Error(
        "Rate limit reached. Please wait a minute before transcribing more audio.",
      ),
    );
    expect(limited.kind).toBe("rateLimited");

    expect(classifyCloudError(new Error("Request failed (500)")).kind).toBe(
      "server",
    );
  });

  it("does not mistake 'Upload failed' for the WebKit 'Load failed' network wording", () => {
    const classified = classifyCloudError(
      new Error("Upload failed with status 500"),
    );
    expect(classified.kind).toBe("server");
    expect(classified.status).toBe(500);
  });

  it("keeps local (non-cloud) failures unclassified for the generic wording", () => {
    for (const local of [
      new Error("No transcript words found"),
      new Error("Media not found or not loaded"),
      "Analysis failed",
    ]) {
      const classified = classifyCloudError(local);
      expect(classified.kind).toBe("taskFailed");
      expect(classified.cloudOrigin).toBe(false);
    }
  });
});

describe("cloudFailureMessage", () => {
  it("maps each cloud kind to its cloud.failure key", () => {
    expect(
      cloudFailureMessage({
        kind: "network",
        detail: "Failed to fetch",
        cloudOrigin: true,
      }),
    ).toEqual({ key: "cloud.failure.network", showDetail: true });

    expect(
      cloudFailureMessage({
        kind: "timeout",
        detail: "Transcription timed out after 6 minutes",
        cloudOrigin: true,
      }),
    ).toEqual({ key: "cloud.failure.timeout", showDetail: true });

    expect(
      cloudFailureMessage({
        kind: "responseInvalid",
        detail: "Unexpected token",
        cloudOrigin: true,
      }),
    ).toEqual({ key: "cloud.failure.responseInvalid", showDetail: true });
  });

  it("interpolates the status for server errors and keeps the detail separate", () => {
    expect(
      cloudFailureMessage({
        kind: "server",
        status: 502,
        detail: "Transcription failed: 502",
        cloudOrigin: true,
      }),
    ).toEqual({
      key: "cloud.failure.server",
      options: { status: 502 },
      showDetail: true,
    });
  });

  it("interpolates the reason for job failures without a second detail line", () => {
    expect(
      cloudFailureMessage({
        kind: "taskFailed",
        detail: "Audio decode failed on server",
        cloudOrigin: true,
      }),
    ).toEqual({
      key: "cloud.failure.taskFailed",
      options: { message: "Audio decode failed on server" },
      showDetail: false,
    });
  });

  it("returns null for non-cloud failures so callers keep generic wording", () => {
    expect(
      cloudFailureMessage({
        kind: "taskFailed",
        detail: "No transcript words found",
        cloudOrigin: false,
      }),
    ).toBeNull();
  });
});
