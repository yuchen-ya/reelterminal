import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReviewCommandActivity } from "./ReviewCommandActivity";
import { COMMAND_ACTIVITY_LIMIT, useCollabStore } from "../../../stores/collab-store";

const target = { kind: "review" as const, reviewWorkspaceId: "workspace", instanceId: "instance", nodeId: "node-a" };
const event = { type: "action" as const, phase: "start" as const, verb: "review.repair.apply", callId: "call-a",
  reviewTarget: target, startedAt: 100, arguments: '{"requestId":"receipt-a","itemId":"image-a"}', argumentSummary: "itemId=image-a" };

afterEach(() => { useCollabStore.setState({ commandActivity: [] }); localStorage.clear(); });

it("shows actual running/failed calls and scoped details without reloading review content", () => {
  useCollabStore.setState({ commandActivity: [event] });
  const view = render(<ReviewCommandActivity target={target} />);
  expect(screen.getByTestId("review-command-current")).toHaveTextContent("review.repair.apply");
  expect(screen.getByTestId("review-command-current-status")).toHaveTextContent("运行中");
  act(() => useCollabStore.getState().applyCommandActivity({ ...event, phase: "end", ok: false, finishedAt: 145,
    summary: "CONFLICT: item version changed" }));
  fireEvent.click(screen.getByTestId("review-command-toggle"));
  expect(screen.getByTestId("review-command-current-status")).toHaveTextContent("失败");
  expect(screen.getAllByTestId("review-command-entry")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("review-command-entry").querySelector("summary")!);
  expect(screen.getByText("CONFLICT: item version changed")).toBeVisible();
  expect(screen.getByTestId("review-command-arguments")).toHaveTextContent("receipt-a");
  view.rerender(<ReviewCommandActivity target={{ ...target, nodeId: "node-b" }} />);
  expect(screen.queryByTestId("review-command-entry")).not.toBeInTheDocument();
  view.rerender(<ReviewCommandActivity target={{ ...target, instanceId: "new-instance" }} />);
  expect(screen.queryByTestId("review-command-current")).not.toBeInTheDocument();
});

it("correlates concurrent calls, retains replay receipts, and bounds window activity", () => {
  const store = useCollabStore.getState();
  store.applyCommandActivity(event);
  store.applyCommandActivity({ ...event, callId: "call-b" });
  store.applyCommandActivity({ ...event, phase: "end", ok: true, finishedAt: 120, replayed: true, summary: "review.repair.apply ok" });
  expect(useCollabStore.getState().commandActivity).toMatchObject([{ callId: "call-a", phase: "end", replayed: true }, { callId: "call-b", phase: "start" }]);
  store.applyCommandActivity(event);
  expect(useCollabStore.getState().commandActivity[0].phase).toBe("end");
  for (let index = 0; index < COMMAND_ACTIVITY_LIMIT; index++) store.applyCommandActivity({ ...event, callId: `call-${index}` });
  expect(useCollabStore.getState().commandActivity).toHaveLength(COMMAND_ACTIVITY_LIMIT);
  expect(useCollabStore.getState().commandActivity[0].callId).toBe("call-0");
});
