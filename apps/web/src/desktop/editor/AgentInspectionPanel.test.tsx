import { beforeEach, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AgentInspectionPanel } from "./AgentInspectionPanel";
import { useCollabStore } from "../../stores/collab-store";
import { useTimelineStore } from "../../stores/timeline-store";

beforeEach(() => {
  useTimelineStore.setState({ playbackState: "paused" });
  useCollabStore.setState({ inspection: { title: "Source · revision 2", range: "1–2 s", images: [], limitations: ["Static frames only"] } });
});
it("labels static evidence and dismisses the overlay when normal playback starts", () => {
  render(<AgentInspectionPanel />);
  expect(screen.getByText(/not audiovisual review/)).toBeTruthy();
  act(() => useTimelineStore.setState({ playbackState: "playing" }));
  expect(screen.queryByLabelText("Agent source inspection")).toBeNull();
  expect(useCollabStore.getState().inspection).toBeNull();
});

it("shows cloud text as an opinion without rendering markup or claiming acceptance", () => {
  useCollabStore.setState({ inspection: { kind: "cloud-opinion", title: "Qwen · revision 3", range: "source 1–3 s", text: "<script>untrusted</script>", images: [], limitations: ["Unknown sampling"] } });
  const { container } = render(<AgentInspectionPanel />);
  expect(screen.getByText(/Cloud model opinion · not audiovisual acceptance/)).toBeTruthy();
  expect(screen.getByText("<script>untrusted</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  act(() => useTimelineStore.setState({ playbackState: "playing" }));
  expect(useCollabStore.getState().inspection).toBeNull();
});
