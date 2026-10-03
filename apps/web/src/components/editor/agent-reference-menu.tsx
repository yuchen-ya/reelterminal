import { useTranslation } from "react-i18next";
import { Hash, X } from "@/icons/lucide-compat";
import type { LiveEditorReferenceKind } from "@reelterminal/agent-facade/live-store";
import { useAgentReferencesStore } from "../../stores/agent-references-store";

export function useAgentReferenceMenuItem(
  kind: LiveEditorReferenceKind | null,
  entityId: string,
  onAdd: () => void,
  onClose?: () => void,
) {
  const { t } = useTranslation();
  const reference = useAgentReferencesStore((state) =>
    Object.values(state.references).find((item) => item.kind === kind && item.entityId === entityId),
  );
  return {
    label: reference
      ? t("agentReferences.remove", { number: reference.number })
      : t("agentReferences.add"),
    icon: reference ? <X size={14} aria-hidden /> : <Hash size={14} aria-hidden />,
    isDisabled: kind === null,
    onClick: () => {
      if (reference) {
        useAgentReferencesStore.getState().remove(reference.number);
        onClose?.();
      } else {
        onAdd();
      }
    },
  };
}
