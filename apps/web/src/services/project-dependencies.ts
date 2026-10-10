import { workspaceManager, type FontDependencyReference } from "./workspace-manager";

export type { FontDependencyReference };

/** Return every saved/runtime project root that uses the given font family. */
export async function getFontDependencyReferences(
  family: string,
): Promise<FontDependencyReference[]> {
  return workspaceManager.getFontDependencyReferences(family);
}
