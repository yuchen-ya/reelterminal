import { TemplatesTab } from "../editor/panels/TemplatesTab";

export function TemplateGallery(props: { onTemplateApplied?: () => void }) {
  return <TemplatesTab {...props} />;
}
