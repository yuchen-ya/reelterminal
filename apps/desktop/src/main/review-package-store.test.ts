import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { emptyWorkbenchState } from "@reelterminal/core/types/workbench";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";
import type { ReviewNodeArchive } from "@reelterminal/core/review/archive";
import { ReviewFileStore } from "./review-file-store";
import { ReviewExportStore } from "./review-export-store";
import { ReviewPackageStore } from "./review-package-store";

const directories: string[] = [];
const outputs: string[] = [];
const timings: Array<{ stage: string; elapsedMs: number }> = [];
async function measured<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); }
  finally { timings.push({ stage, elapsedMs: Math.round(performance.now() - started) }); }
}
afterEach(async () => {
  for (const directory of outputs.splice(0)) {
    expect(path.dirname(directory)).toBe(portable.directory);
    expect(path.basename(directory)).toMatch(/^case-/);
    await rm(directory, { recursive: true, force: true });
  }
});
afterAll(async () => {
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    expect(path.basename(directory)).toMatch(/^reel-review-package-/);
    await rm(directory, { recursive: true, force: true });
  }
});

async function preparePortableFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reel-review-package-")); directories.push(directory);
  const source = path.join(directory, "source.txt"); await writeFile(source, "Exact 👀\r\noriginal");
  const files = new ReviewFileStore(path.join(directory, "review"));
  const original = await files.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: source, mime: "text/plain", source: "user" });
  const itemId = randomUUID(), nodeId = randomUUID();
  const built = buildWorkbenchIngestActions(emptyWorkbenchState(), { batchId: randomUUID(), name: "Input", items: [{ id: itemId, title: "Original", type: "text", originalResourceId: original.id,
    content: { type: "text", entryId: randomUUID(), title: "Original", speakerOrContext: "", versions: [{ version: 1, text: "Exact 👀\r\noriginal", createdAt: 1, origin: "ingest" }] } }] });
  if (!built.ok) throw new Error(built.message);
  const state = reduceReviewActions(emptyWorkbenchState(), built.actions).state;
  const { storage: _storage, ...portable } = original;
  const archive: ReviewNodeArchive = { schemaVersion: 1, node: { id: nodeId, workspaceId: randomUUID(), name: "Package", pinned: false, revision: 1, createdAt: 1, updatedAt: 1 },
    state, versions: [{ nodeId, itemId, version: 1, content: state.items[0].content, originalResourceId: original.id }], steps: [], resources: [portable], journal: [], journalArchives: [] };
  const exporter = new ReviewExportStore(path.join(directory, "exports"), files);
  const exportId = randomUUID();
  await exporter.prepare({ exportId, nodeId, nodeRevision: 1, name: "Package", mode: "node-package", scope: "node", archive: JSON.stringify(archive), entries: [{ resourceId: original.id, fileName: "source.txt" }] });
  expect((await exporter.wait(exportId)).state).toBe("ready");
  return { directory, source, files, archive, exporter, exportId, original };
}

// The sealed export is immutable input. Each case still gets its own copied
// output and inspection session, so tampering cannot affect another case.
let portable: Awaited<ReturnType<typeof preparePortableFixture>>;
beforeAll(async () => {
  portable = await measured('fixture.prepare-sealed-export', preparePortableFixture);
});
async function createPortableNode() {
  const destination = await mkdtemp(path.join(portable.directory, 'case-'));
  outputs.push(destination);
  return { ...portable, archive: structuredClone(portable.archive), destination, reader: new ReviewPackageStore(portable.files) };
}

it("exports and inspects a portable node and restores independent managed bytes", async () => {
  const { source, files, original, exporter, exportId, destination, reader } = await createPortableNode();
  const copied = await exporter.copy(exportId, destination);
  const preview = await reader.inspect(copied.directory);
  expect(preview).toMatchObject({ itemCount: 1, versionCount: 1, resourceCount: 1 });
  const prepared = await reader.prepare(preview.packageId, randomUUID(), preview.digest);
  expect(prepared.resources[0].id).not.toBe(original.id);
  expect(prepared.resources[0].storage.kind).toBe("managed");
  expect((await readFile((await files.resolve(prepared.resources[0].id, true)).path)).equals(await readFile(source))).toBe(true);
  await expect(reader.prepare(preview.packageId, randomUUID(), "0".repeat(64))).rejects.toMatchObject({ reason: "CONFLICT" });
  expect(await readFile(source, "utf8")).toBe("Exact 👀\r\noriginal");
});

it("backs up populated and empty nodes with groups and rejects stale node revisions", async () => {
  const { source, files, archive, exporter, exportId, destination, reader } = await createPortableNode();
  const existingCopy = await measured('backup.copy-existing', () => exporter.copy(exportId, destination));
  const emptyNode = { ...archive.node, id: randomUUID(), archivedAt: 1, trashedAt: 2 };
  const emptyExportId = randomUUID();
  await measured('backup.prepare-empty-export', async () => {
    await exporter.prepare({ exportId: emptyExportId, nodeId: emptyNode.id, nodeRevision: emptyNode.revision, name: emptyNode.name,
      mode: "node-package", scope: "node", archive: JSON.stringify({ ...archive, node: emptyNode, state: emptyWorkbenchState(), versions: [], resources: [] }), entries: [] });
    expect((await exporter.wait(emptyExportId)).state).toBe("ready");
  });
  const group = { id: randomUUID(), workspaceId: archive.node.workspaceId, name: "Original group", order: 0 };
  const reloadedExporter = new ReviewExportStore(exporter.root, files);
  const backup = await measured('backup.copy-populated-and-empty', () => reloadedExporter.backup({ workspaceId: archive.node.workspaceId, revision: 4, groups: [group],
    nodes: [{ exportId, node: archive.node }, { exportId: emptyExportId, node: emptyNode }] }, destination));
  const index = JSON.parse(await readFile(path.join(backup.directory, "backup.json"), "utf8"));
  expect(index).toMatchObject({ schemaVersion: 1, groups: [group], nodes: [{ id: archive.node.id, relativePath: "nodes/Package" }, { id: emptyNode.id, relativePath: "nodes/Package (2)", archivedAt: 1, trashedAt: 2 }] });
  expect(await reader.inspect(path.join(backup.directory, ...index.nodes[0].relativePath.split("/")))).toMatchObject({ itemCount: 1, resourceCount: 1 });
  expect(await reader.inspect(path.join(backup.directory, ...index.nodes[1].relativePath.split("/")))).toMatchObject({ itemCount: 0, resourceCount: 0 });
  await expect(exporter.backup({ workspaceId: archive.node.workspaceId, revision: 4, groups: [], nodes: [{ exportId, node: { ...archive.node, revision: 99 } }] }, destination)).rejects.toMatchObject({ reason: "CONFLICT" });
  expect((await readFile(path.join(existingCopy.directory, "source.txt"))).equals(await readFile(source))).toBe(true);
  process.stdout.write(`REVIEW_PACKAGE_STAGES ${JSON.stringify(timings)}\n`);
});

it("rejects traversal and tampered package files without changing the source", async () => {
  const { source, exporter, exportId, destination, reader } = await createPortableNode();
  const copied = await exporter.copy(exportId, destination);
  const manifestPath = path.join(copied.directory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  manifest.entries[0].relativePath = "../outside.txt";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(reader.inspect(copied.directory)).rejects.toMatchObject({ reason: "INVALID_PARAMS" });
  await writeFile(manifestPath, manifestText);
  await writeFile(path.join(copied.directory, "source.txt"), "tampered bytes");
  await expect(reader.inspect(copied.directory)).rejects.toMatchObject({ reason: "SOURCE_CHANGED" });
  expect(await readFile(source, "utf8")).toBe("Exact 👀\r\noriginal");
});
