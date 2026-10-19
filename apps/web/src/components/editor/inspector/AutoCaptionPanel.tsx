import { LocalCaptionPanel } from "./LocalCaptionPanel";
export function AutoCaptionPanel(props: { clipId?: string; maxWordsPerLine?: number; onBack?: () => void }) {
  return <LocalCaptionPanel clipId={props.clipId} onBack={props.onBack} />;
}
export default AutoCaptionPanel;
