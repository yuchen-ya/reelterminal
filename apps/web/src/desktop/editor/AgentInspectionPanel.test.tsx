import { beforeEach, it, expect } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { AgentInspectionPanel } from "./AgentInspectionPanel";
import { ToastContainer } from "../../components/Toast";
import { useCollabStore } from "../../stores/collab-store";
import { useNotificationStore } from "../../stores/notification-store";
import { useTimelineStore } from "../../stores/timeline-store";

function renderWithToasts() {
  return render(
    <>
      <AgentInspectionPanel />
      <ToastContainer />
    </>,
  );
}

function expandFromToast(title: string) {
  fireEvent.click(screen.getByText(title));
}

beforeEach(() => {
  useTimelineStore.setState({ playbackState: "paused" });
  useNotificationStore.setState({ notifications: [] });
  useCollabStore.setState({ inspection: { title: "Source · revision 2", range: "1–2 s", images: [], limitations: ["Static frames only"] } });
});

it("collapses into a toast and mounts evidence only after the click", () => {
  useCollabStore.setState({ inspection: { title: "Source · revision 2", range: "1–2 s", images: ["data:image/png;base64,AAAA"], limitations: ["Static frames only"] } });
  renderWithToasts();
  // Collapsed: a text-only toast card, no panel, and the sample sheet is
  // not mounted anywhere.
  expect(screen.queryByLabelText("Agent source inspection")).toBeNull();
  expect(document.body.querySelector("img")).toBeNull();
  const notes = useNotificationStore.getState().notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.duration).toBe(0);
  expect(notes[0]!.title).toBe("Source · revision 2");
  expect(screen.getByText(/click to expand/)).toBeTruthy();

  expandFromToast("Source · revision 2");
  const panel = screen.getByLabelText("Agent source inspection");
  expect(within(panel).getByText(/not audiovisual review/)).toBeTruthy();
  expect(within(panel).getByRole("img")).toBeTruthy();
  // The toast retracts while the panel is open so both never share the corner.
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
});

it("labels static evidence and dismisses everything when normal playback starts", () => {
  renderWithToasts();
  expandFromToast("Source · revision 2");
  expect(within(screen.getByLabelText("Agent source inspection")).getByText(/not audiovisual review/)).toBeTruthy();
  act(() => useTimelineStore.setState({ playbackState: "playing" }));
  expect(screen.queryByLabelText("Agent source inspection")).toBeNull();
  expect(useCollabStore.getState().inspection).toBeNull();
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
});

it("shows cloud text as an opinion without rendering markup or claiming acceptance", () => {
  useCollabStore.setState({ inspection: { kind: "cloud-opinion", title: "Qwen · revision 3", range: "source 1–3 s", text: "<script>untrusted</script>", images: [], limitations: ["Unknown sampling"] } });
  renderWithToasts();
  expandFromToast("Qwen · revision 3");
  const panel = screen.getByLabelText("Agent source inspection");
  expect(within(panel).getByText(/Cloud model opinion · not audiovisual acceptance/)).toBeTruthy();
  expect(within(panel).getByText("<script>untrusted</script>")).toBeTruthy();
  // The panel portals to document.body, so the no-markup guarantee must
  // hold in the portal subtree, not the render container.
  expect(document.body.querySelector("script")).toBeNull();
  act(() => useTimelineStore.setState({ playbackState: "playing" }));
  expect(useCollabStore.getState().inspection).toBeNull();
});

it("keeps only the latest inspection and closes it for good from the toast X", () => {
  renderWithToasts();
  expect(useNotificationStore.getState().notifications).toHaveLength(1);
  act(() => useCollabStore.setState({ inspection: { title: "Next · revision 3", range: null, images: [], limitations: [] } }));
  const notes = useNotificationStore.getState().notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.title).toBe("Next · revision 3");

  // Scope to the live card: the replaced toast lingers in the DOM while its
  // framer-motion exit animation is pending, same labels and all.
  const card = screen.getByText("Next · revision 3").closest('[role="button"]');
  expect(card).toBeTruthy();
  fireEvent.click(within(card as HTMLElement).getByRole("button", { name: /dismiss notification/i }));
  expect(useCollabStore.getState().inspection).toBeNull();
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
});
