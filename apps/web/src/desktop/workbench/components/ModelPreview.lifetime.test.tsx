import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { reviewService } from "../../../services/review-workspace/service";
import { ModelPreview } from "./ModelPreview";

const createRuntime = vi.hoisted(() => vi.fn());
vi.mock("../model-preview/runtime", () => ({ ModelPreviewRuntime: createRuntime }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); createRuntime.mockReset(); });

it("does not resolve or allocate a model after its resource lookup is cancelled", async () => {
  let finish!: (value: Awaited<ReturnType<typeof reviewService.getResources>>) => void;
  const lookup = new Promise<Awaited<ReturnType<typeof reviewService.getResources>>>(resolve => { finish = resolve; });
  vi.spyOn(reviewService, "getResources").mockReturnValue(lookup);
  const resolveFile = vi.fn();
  vi.stubGlobal("reelterminal", { reviewFiles: { resolve: resolveFile } });
  const view = render(<ModelPreview resourceId="old" />);
  view.unmount();
  await act(async () => { finish([{ originalFileName:"old.glb", size:1, storage:{kind:"managed"} } as never]); await lookup; });
  expect(resolveFile).not.toHaveBeenCalled();
  expect(createRuntime).not.toHaveBeenCalled();
});

it("does not allocate a model after its file resolution finishes late", async () => {
  vi.spyOn(reviewService, "getResources").mockResolvedValue([{ originalFileName:"old.glb", size:1, storage:{kind:"managed"} } as never]);
  let finish!: (value: {ok:true; value:{path:string}}) => void;
  const pending = new Promise<{ok:true; value:{path:string}}>(resolve => { finish = resolve; });
  const resolveFile = vi.fn(() => pending);
  vi.stubGlobal("reelterminal", { reviewFiles: { resolve: resolveFile } });
  const view = render(<ModelPreview resourceId="old" />);
  await waitFor(() => expect(resolveFile).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => { finish({ok:true, value:{path:"fixture"}}); await pending; });
  expect(createRuntime).not.toHaveBeenCalled();
});
