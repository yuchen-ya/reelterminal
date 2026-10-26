import { TemplatesTab } from "../panels/TemplatesTab";

export function TemplatesBrowserPanel(props: { onTemplateApplied?: () => void }) {
  return <TemplatesTab {...props} />;
}

export default TemplatesBrowserPanel;
