import { workspaceManager } from "./workspace-manager";

export interface FontDependencyReference {
  readonly family: string;
  readonly projectId: string;
  readonly kind: "node" | "workspace-draft" | "recovery-draft" | "task" | "history";
  readonly referenceId: string;
  readonly label?: string;
}

function collectFontFamilies(value: unknown, families: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFontFamilies(item, families));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "fontFamily" && typeof child === "string" && child.trim()) {
      families.add(child.trim());
    } else {
      collectFontFamilies(child, families);
    }
  }
}

/** Return every saved/runtime project root that uses the given font family. */
export async function getFontDependencyReferences(
  family: string,
): Promise<FontDependencyReference[]> {
  const wanted = family.trim().toLowerCase();
  if (!wanted) return [];

  const snapshots = await workspaceManager.getDependencyProjectSnapshots();
  const references: FontDependencyReference[] = [];
  for (const snapshot of snapshots) {
    const families = new Set<string>();
    collectFontFamilies(snapshot.project, families);
    collectFontFamilies(snapshot.historyEntries, families);
    if (![...families].some((candidate) => candidate.toLowerCase() === wanted)) continue;
    references.push({
      family,
      projectId: snapshot.projectId,
      kind: snapshot.kind,
      referenceId: snapshot.referenceId,
      ...(snapshot.label ? { label: snapshot.label } : {}),
    });
  }
  return references;
}
