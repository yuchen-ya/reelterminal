import { collectArtifactPaths } from "./artifact-paths";
import { workspaceManager, type ArtifactPathReference } from "./workspace-manager";
import { getExportArtifactPathReferences } from "./project-export-activity";
import { createIdbMaterialStorage, openMaterialDatabase } from "./material-library/storage";
import { createIdbAgentTaskStorage } from "./agent-media-tasks/storage";
import { projectManager } from "./project-manager";
import { autoSaveManager } from "./auto-save";
import { projectTemplateStorage } from "./project-template-storage";
import { useDesktopExportStore } from "../stores/desktop-export-store";

const materials = createIdbMaterialStorage();
const agentTasks = createIdbAgentTaskStorage();

async function reviewFileReferences(): Promise<unknown[]> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("fileResources", "readonly");
      const request = transaction.objectStore("fileResources").getAll();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Review file references could not be read"));
    });
  } finally { database.close(); }
}

/** A failed provider rejects the scan; absence of evidence never permits deletion. */
export async function scanArtifactPathReferences(): Promise<ArtifactPathReference[]> {
  const [workspace, library, tasks, projects, recovery, templates, review] = await Promise.all([
    workspaceManager.getArtifactPathReferences(),
    materials.loadSnapshot(),
    agentTasks.loadAll(),
    projectManager.listStoredProjects(),
    autoSaveManager.listRecoveryProjects(),
    projectTemplateStorage.listStoredTemplates(),
    reviewFileReferences(),
  ]);
  const references = [...workspace, ...getExportArtifactPathReferences()];
  const add = (value: unknown, kind: ArtifactPathReference["kind"], referenceId: string): void => {
    for (const pathKey of collectArtifactPaths(value)) references.push({ pathKey, kind, referenceId });
  };
  add(library, "material", "material-library-and-history");
  add(tasks, "task", "agent-media-tasks");
  add(projects, "recovery-draft", "saved-projects");
  add(recovery, "recovery-draft", "autosave");
  add(templates, "template", "project-templates");
  add(review, "review", "review-file-resources");
  const exportSession = useDesktopExportStore.getState().session;
  if (exportSession?.state.isExporting) add(exportSession.outputPath, "task", `desktop-export:${exportSession.target.exportId}`);
  for (const output of useDesktopExportStore.getState().outputs) {
    add(output.outputPath, "task", `desktop-export-history:${output.target.exportId}`);
  }
  return references;
}
