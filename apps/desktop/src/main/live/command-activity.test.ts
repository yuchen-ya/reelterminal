import { expect, it } from "vitest";
import { activityText, commandActivityDetails } from "./command-activity";

it("projects real arguments without credentials, image payloads or unbounded geometry", () => {
  const target = { reviewWorkspaceId: "workspace", instanceId: "instance", nodeId: "node" };
  const details = commandActivityDetails({ target, itemId: "image", requestId: "receipt", region: {
    points: Array.from({ length: 400 }, (_, index) => ({ x: index, y: index })),
  }, nested: { apiKey: "private-key", token: "private-token", data: "data:image/png;base64,private-image" } });
  expect(details.reviewTarget).toEqual(target);
  const args = JSON.parse(details.arguments);
  expect(args).toMatchObject({ itemId: "image", requestId: "receipt", region: { points: { count: 400, omitted: 392 } } });
  expect(args.region.points.preview).toHaveLength(8);
  expect(details.arguments).not.toMatch(/private-key|private-token|private-image/);
  expect(details.argumentSummary).toContain("itemId=image");
  expect(activityText("Failed: token=private-token Bearer private-secret")).not.toMatch(/private-token|private-secret/);
});

it("omits free-form content and redacts quoted credentials embedded in text", () => {
  const details = commandActivityDetails({ itemId: "image-a", opacity: 0.5,
    updates: [{ content: { text: "naked-private-secret", opacity: 0.8 }, feedback: "another-private-secret" }],
    note: 'Failed with {"token":"quoted private token", "api_key": "key-with-\\"quote"}',
  });
  expect(JSON.parse(details.arguments)).toMatchObject({ itemId: "image-a", opacity: 0.5,
    updates: [{ content: "[content omitted]", feedback: "[content omitted]" }] });
  expect(details.arguments).not.toMatch(/naked-private-secret|another-private-secret|quoted private token|key-with/);
  expect(activityText("password='secret with spaces' credential=plain-secret")).not.toMatch(/secret with spaces|plain-secret/);
});
