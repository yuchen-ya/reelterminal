import ReactDOM from "react-dom/client";
import "../i18n";
import i18n from "../i18n";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "../index.css";
import "../desktop/theme/desktop-theme.css";
import "./showcase.css";
import { AstryxProvider } from "../components/astryx/AstryxProvider";
import { useThemeStore } from "../stores/theme-store";
import { useUIStore } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { loadSampleProject, SHOWCASE_PROJECT_ID } from "./sample-project";
import { workspaceManager } from "../services/workspace-manager";
import { ONBOARDING_KEY } from "../components/editor/tour";
import { ShowcaseApp } from "./ShowcaseApp";

localStorage.setItem(ONBOARDING_KEY, "true");
useThemeStore.getState().setMode("dark");
await i18n.changeLanguage("zh-CN");
await workspaceManager.initialize();
const existing = workspaceManager
  .getSnapshot()
  .projects.find((project) => project.id === SHOWCASE_PROJECT_ID);
if (existing) {
  await workspaceManager.switchView({
    projectId: existing.id,
    workspaceId: existing.defaultWorkspaceId,
  });
} else {
  const project = await loadSampleProject();
  const created = await workspaceManager.createProject(project, {
    deduplicateName: false,
  });
  const target = {
    projectId: project.id,
    workspaceId: created.defaultWorkspaceId,
  };
  await workspaceManager.switchView(target);
  await workspaceManager.saveNode({ target, name: "初始版本" });
}
useUIStore.getState().clearSelection();
useUIStore.getState().showCurrentArchive();
useTimelineStore.getState().seekTo(1);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AstryxProvider>
    <ShowcaseApp />
  </AstryxProvider>,
);
