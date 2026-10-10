import { TOUR_STEPS, type TourStep } from "../../components/editor/tour/tour-steps";

export const DESKTOP_TOUR_STEPS: readonly TourStep[] = [
  ...TOUR_STEPS.slice(0, -1).map((step) => step.id === "inspector" ? { ...step, target: "[data-testid='desktop-inspector']" } : step),
  {
    id: "archives",
    target: "[data-testid='current-archive-entry']",
    title: "desktop.help.archiveTourTitle",
    description: "desktop.help.archiveTourDescription",
    tips: ["desktop.help.archiveTourTipSave", "desktop.help.archiveTourTipPreview"],
    position: "left",
  },
  {
    id: "agent-access",
    target: "[data-testid='agent-access-status']",
    title: "desktop.help.agentTourTitle",
    description: "desktop.help.agentTourDescription",
    position: "top",
  },
  {
    id: "export",
    target: "[data-tour='desktop-export']",
    title: "desktop.help.exportTourTitle",
    description: "desktop.help.exportTourDescription",
    position: "bottom",
  },
  {
    ...TOUR_STEPS[TOUR_STEPS.length - 1],
    description: "desktop.help.tourComplete",
  },
];
