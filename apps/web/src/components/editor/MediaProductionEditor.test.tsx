import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ActionExecutor,
  ActionHistory,
  type MediaItem,
} from "@reelterminal/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { MediaProductionEditor } from "./MediaProductionEditor";

const media = {
  id: "candidate",
  name: "Candidate",
  type: "video",
  metadata: { duration: 6 },
} as MediaItem;

beforeEach(() => {
  const history = new ActionHistory();
  const project = createEmptyProject("Production");
  project.mediaLibrary.items.push(media);
  useProjectStore.setState({
    project,
    hasOpenProject: true,
    actionHistory: history,
    actionExecutor: new ActionExecutor(history),
  });
});

it("saves candidate status and notes through the project history and undoes them", async () => {
  const close = vi.fn();
  render(<MediaProductionEditor item={media} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Candidate status"), {
    target: { value: "rejected" },
  });
  fireEvent.change(screen.getByLabelText("Notes"), {
    target: { value: "Wrong motion" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const store = useProjectStore.getState();
  expect(store.project.mediaLibrary.items[0].production).toEqual({
    status: "rejected",
    notes: "Wrong motion",
    steps: [],
  });
  await act(async () => {
    await store.actionExecutor.undo(store.project);
  });
  expect(store.project.mediaLibrary.items[0].production).toBeUndefined();
});

it("refuses to overwrite a production record changed while the editor was open", async () => {
  render(<MediaProductionEditor item={media} onClose={vi.fn()} />);
  await act(async () => {
    await useProjectStore
      .getState()
      .executeAction({
        type: "media/setProduction",
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        params: {
          mediaId: media.id,
          production: {
            status: "adopted",
            notes: "Updated by another editor",
            steps: [],
          },
        },
      });
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Project or production record changed",
  );
  expect(
    useProjectStore.getState().project.mediaLibrary.items[0].production?.status,
  ).toBe("adopted");
});
