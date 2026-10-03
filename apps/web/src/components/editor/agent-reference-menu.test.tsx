import "../../test/install-local-storage-mock";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAgentReferenceMenuItem } from "./agent-reference-menu";
import { AgentReferenceBadge } from "./timeline/AgentReferenceBadge";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { useEditorContextStore } from "../../stores/editor-context-store";

afterEach(() => {
  cleanup();
  useAgentReferencesStore.getState().reset();
});

it("removes the badge and live reference, then assigns a fresh number when re-added", () => {
  const target = { kind: "video" as const, entityId: "clip", label: "Clip", timing: { startSeconds: 0, endSeconds: 2 }, trackOrder: 0 };
  const add = () => { useAgentReferencesStore.getState().mark([target], 1); };
  add();
  render(<AgentReferenceBadge kind="video" entityId="clip" />);
  const { result } = renderHook(() => useAgentReferenceMenuItem("video", "clip", add));
  expect(screen.getByText("A1")).toBeInTheDocument();
  expect(result.current.label).toBe("Remove reference A1");
  act(() => { result.current.onClick?.(); });
  expect(screen.queryByText("A1")).toBeNull();
  expect(useEditorContextStore.getState().references).toEqual({});
  expect(result.current.label).toBe("Add reference");
  act(() => { result.current.onClick?.(); });
  expect(screen.getByText("A2")).toBeInTheDocument();
});
