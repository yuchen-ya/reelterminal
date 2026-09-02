export interface TourStep {
  id: string;
  target: string | null;
  title: string;
  description: string;
  tips?: string[];
  position: "center" | "top" | "bottom" | "left" | "right";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: null,
    title: "editorTour.welcomeTitle",
    description: "editorTour.welcomeDescription",
    position: "center",
  },
  {
    id: "assets",
    target: "[data-tour='assets']",
    title: "editorTour.mediaTitle",
    description: "editorTour.mediaDescription",
    tips: [
      "editorTour.mediaTipLibrary",
      "editorTour.mediaTipToolRail",
      "editorTour.mediaTipDrag",
      "editorTour.mediaTipControls",
    ],
    position: "right",
  },
  {
    id: "timeline",
    target: "[data-tour='timeline']",
    title: "editorTour.timelineTitle",
    description: "editorTour.timelineDescription",
    tips: [
      "editorTour.timelineTipSplit",
      "editorTour.timelineTipTrim",
      "editorTour.timelineTipAddTrack",
    ],
    position: "top",
  },
  {
    id: "preview",
    target: "[data-tour='preview']",
    title: "editorTour.playerTitle",
    description: "editorTour.playerDescription",
    tips: [
      "editorTour.playerTipControls",
      "editorTour.playerTipLive",
      "editorTour.playerTipFullscreen",
    ],
    position: "left",
  },
  {
    id: "inspector",
    target: "[data-tour='inspector']",
    title: "editorTour.inspectorTitle",
    description: "editorTour.inspectorDescription",
    tips: [
      "editorTour.inspectorTipTabs",
      "editorTour.inspectorTipClipSpecific",
      "editorTour.inspectorTipKeyframes",
    ],
    position: "left",
  },
  {
    id: "complete",
    target: null,
    title: "editorTour.completeTitle",
    description: "editorTour.completeDescription",
    position: "center",
  },
];

export const ONBOARDING_KEY = "openreel-onboarding-complete";
