import { z } from "zod";
import { resolveContainedPathDetailed } from "@reelterminal/agent-facade/media/path-roots";
import { CHANNELS } from "../../shared/channels";
import { handle } from "./index";
import { fileReply, getReviewFileStore } from "./review-files";
import { ReviewPackageStore } from "../review-package-store";

export function registerReviewPackageIpc(mediaRoots: () => readonly string[]): void {
  const store = new ReviewPackageStore(getReviewFileStore());
  const source = z.enum(["user", "agent"]);
  const authorized = (directory: string, source: "user" | "agent") => {
    if (source === "agent" && resolveContainedPathDetailed(directory, mediaRoots()).kind !== "ok") throw Object.assign(new Error("Agent node packages must be inside an allowed media root"), { reason: "INVALID_PARAMS" });
  };
  handle(CHANNELS.reviewPackageInspect, z.object({ directory: z.string().min(1), source }).strict(), args => fileReply(async () => {
    authorized(args.directory, args.source);
    return store.inspect(args.directory);
  }));
  handle(CHANNELS.reviewPackagePrepare, z.object({ packageId: z.string().uuid(), restoreId: z.string().uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/), source }).strict(), args => fileReply(async () => {
    authorized(store.directory(args.packageId), args.source);
    const prepared = await store.prepare(args.packageId, args.restoreId, args.digest);
    // prepare verifies the frozen preview; the facade/GUI additionally bind its digest to the durable receipt.
    return prepared;
  }));
  handle(CHANNELS.reviewPackageRelease, z.object({ packageId: z.string().uuid() }).strict(), args => store.release(args.packageId));
}
