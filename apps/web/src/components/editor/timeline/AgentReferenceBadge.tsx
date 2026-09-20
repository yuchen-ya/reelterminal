import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { LiveEditorReferenceKind } from "@reelterminal/agent-facade/live-store";
import { useAgentReferencesStore } from "../../../stores/agent-references-store";

interface AgentReferenceBadgeProps {
  kind: LiveEditorReferenceKind;
  entityId: string;
  className?: string;
}

/** Small, high-contrast marker for the agent's stable reference number. */
export function AgentReferenceBadge({
  kind,
  entityId,
  className = "",
}: AgentReferenceBadgeProps): JSX.Element | null {
  const { t } = useTranslation();
  const reference = useAgentReferencesStore((state) =>
    Object.values(state.references).find(
      (candidate) =>
        !candidate.stale &&
        candidate.kind === kind &&
        candidate.entityId === entityId,
    ),
  );
  if (!reference) return null;

  return (
    <span
      className={`pointer-events-none absolute left-1 top-1 z-30 rounded-[4px] bg-violet-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white shadow-[0_1px_5px_rgba(0,0,0,0.35)] ${className}`}
      aria-label={t("agentReferences.badgeLabel", { number: reference.number })}
      title={t("agentReferences.badgeLabel", { number: reference.number })}
    >
      A{reference.number}
    </span>
  );
}
