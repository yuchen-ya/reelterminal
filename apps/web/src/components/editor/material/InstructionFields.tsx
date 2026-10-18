import { useTranslation } from "react-i18next";
import { COLLABORATION_INSTRUCTION_LIMITS as limits } from "@reelterminal/core";

export function InstructionFields({ title, description, onChange }: {
  title: string; description: string;
  onChange: (value: { title: string; description: string }) => void;
}) {
  const { t } = useTranslation();
  const field = "mt-1 w-full rounded border border-border bg-bg-2 p-2 text-xs text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent";
  return <div className="space-y-3">
    <label className="block text-xs">{t("collaborationInstructions.fieldTitle")}<input autoFocus className={field} value={title} maxLength={limits.title} onChange={e => onChange({ title: e.target.value, description })} /></label>
    <label className="block text-xs">{t("collaborationInstructions.description")}<textarea className={field} rows={6} value={description} maxLength={limits.description} onChange={e => onChange({ title, description: e.target.value })} /></label>
  </div>;
}
