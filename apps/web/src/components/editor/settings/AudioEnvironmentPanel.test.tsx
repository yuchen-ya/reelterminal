import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AudioEnvironmentPanel } from "./AudioEnvironmentPanel";
import { useAudioEnvironment } from "../../../services/audio-environment";

beforeEach(() => useAudioEnvironment.setState({ report: null, checking: false, error: "" }));
it("copies actionable offline CLI instructions and rechecks configuration", async () => {
  const check = vi.fn().mockRejectedValueOnce(new Error("not configured")).mockRejectedValueOnce(new Error("missing model"));
  Object.defineProperty(window, "reelterminal", { configurable: true, value: { audioEnvironment: { check }, collabControl: { getStartupInfo: async () => ({ cliCommand: "node /installation/reelctl/index.js", shell: "PowerShell" }) } } });
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<AudioEnvironmentPanel />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not configured"));
  fireEvent.click(screen.getByRole("button", { name: "Copy setup prompt" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  const prompt = writeText.mock.calls[0][0];
  expect(prompt).toContain("node /installation/reelctl/index.js");
  expect(prompt).toContain("environment set --file config.json");
  expect(prompt).toContain("environment test --file speech.wav");
  expect(prompt).toContain("No open project or Agent write access");
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
});
