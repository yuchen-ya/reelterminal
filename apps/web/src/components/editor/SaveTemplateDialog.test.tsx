import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The save-template dialog is the upload entry for cloud template
 * publishing. These tests pin the honest publish copy (what is sent, and
 * that it becomes publicly browsable), and the cloud-off precheck: the
 * Cloud option is disabled with an explanation and any submission falls
 * back to a purely local save, so no upload request is constructed.
 */

const stubs = vi.hoisted(() => ({
  cloudEnabled: { value: true },
  uploadTemplate: vi.fn(),
  saveTemplate: vi.fn(),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({ project: { name: "Test Project" } }),
}));

vi.mock("../../stores/engine-store", () => ({
  useEngineStore: (selector: (s: unknown) => unknown) =>
    selector({
      getTemplateEngine: async () => ({
        initialize: async () => undefined,
        createFromProject: () => ({ name: "t", timeline: {} }),
        saveTemplate: stubs.saveTemplate,
      }),
      getGraphicsEngine: () => undefined,
    }),
}));

vi.mock("../../services/template-cloud-service", () => ({
  templateCloudService: {
    isCloudEnabled: () => stubs.cloudEnabled.value,
    uploadTemplate: stubs.uploadTemplate,
  },
}));

import { SaveTemplateDialog } from "./SaveTemplateDialog";

function renderDialog() {
  return render(<SaveTemplateDialog isOpen onClose={() => {}} />);
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText("My Awesome Template"), {
    target: { value: "My Template" },
  });
  fireEvent.change(
    screen.getByPlaceholderText(
      "Describe what this template is for and how to use it...",
    ),
    { target: { value: "A template" } },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  stubs.cloudEnabled.value = true;
});

describe("SaveTemplateDialog cloud publish copy", () => {
  it("describes public cloud publishing instead of private device sync", () => {
    renderDialog();
    expect(
      screen.getByText(
        "Sends the template name, description and timeline structure to the template service, where other users may access it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Saved to cloud and accessible from any device"),
    ).toBeNull();
  });

  it("keeps the local-save copy (now via i18n) for the Local option", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Local" }));
    expect(
      screen.getByText("Saved locally in your browser storage"),
    ).toBeInTheDocument();
  });
});

describe("SaveTemplateDialog cloud-off precheck", () => {
  it("offers only local saving when cloud is unavailable", () => {
    stubs.cloudEnabled.value = false;
    renderDialog();
    expect(screen.queryByRole("checkbox", { name: "Cloud" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Local" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText(
        "Saved locally in your browser storage",
      ),
    ).toBeInTheDocument();
  });

  it("an off-build submission saves locally and never constructs an upload", async () => {
    stubs.cloudEnabled.value = false;
    stubs.uploadTemplate.mockRejectedValue(
      new Error("upload must not be attempted"),
    );
    renderDialog();
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(stubs.saveTemplate).toHaveBeenCalledTimes(1));
    expect(stubs.uploadTemplate).not.toHaveBeenCalled();
  });

  it("an on-build cloud submission still uploads as before (success path unchanged)", async () => {
    stubs.uploadTemplate.mockResolvedValue({ success: true });
    renderDialog();
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Save Template" }));
    await waitFor(() =>
      expect(stubs.uploadTemplate).toHaveBeenCalledTimes(1),
    );
    expect(stubs.saveTemplate).not.toHaveBeenCalled();
  });
});
